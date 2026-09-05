#!/usr/bin/env bash
# Выкладка боевой версии в один шаг (задача 1.23).
#
# Запускается с машины разработчика:
#     ./ops/deploy.sh
#
# Что делает: собирает рабочее дерево в архив, отправляет на сервер по SSH,
# собирает образ и перезапускает сервисы. Ни git, ни доступа сервера к
# интернету за исходниками не требуется.
#
# Чего НЕ делает: не трогает .env на сервере. Там боевые ключи, и
# перезаписать их выкладкой было бы отличным способом однажды потерять
# доступ к базе. Файл заводится один раз руками — см. docs/07-runbook.md.

set -euo pipefail

HOST="${VYDOH_HOST:-vydoh}"
REMOTE_DIR="${VYDOH_DIR:-/opt/vydoh}"
COMPOSE="docker compose -f docker-compose.prod.yml"

cd "$(dirname "$0")/.."

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[31mОшибка: %s\033[0m\n' "$1" >&2; exit 1; }

SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=3"

# Связь с этим сервером периодически обрывается на секунды — за одну
# сессию это случилось четыре раза. Выкладка от такого падать не должна:
# все её шаги идемпотентны, поэтому повтор безопасен.
sshx() {
  local attempt
  for attempt in 1 2 3; do
    # shellcheck disable=SC2086
    if ssh $SSH_OPTS "$HOST" "$@"; then
      return 0
    fi
    printf '  (соединение сорвалось, попытка %d из 3)\n' "$((attempt + 1))" >&2
    sleep 5
  done
  return 1
}

# ─── Проверки до того, как что-то менять ──────────────────────────────────────

say "Проверяю доступ к серверу ($HOST)"
sshx 'echo "сервер отвечает: $(hostname)"' \
  || fail "нет доступа по SSH к $HOST. Проверьте ~/.ssh/config"

sshx 'command -v docker >/dev/null' \
  || fail "на сервере нет docker"

sshx "test -f $REMOTE_DIR/.env" \
  || fail "на сервере нет $REMOTE_DIR/.env. Заведите его по docs/07-runbook.md"

# ─── Доставка исходников ──────────────────────────────────────────────────────

say "Отправляю исходники в $REMOTE_DIR"
sshx "mkdir -p $REMOTE_DIR"

# Исключается всё, что либо собирается на месте, либо не должно уезжать:
# зависимости, история, сборки, локальные настройки и чужие сертификаты.
# Повтор здесь отдельным циклом, а не внутри sshx: поток архива
# одноразовый, и заново его надо создавать целиком.
delivered=""
for attempt in 1 2 3; do
  if tar --exclude=node_modules \
      --exclude=.git \
      --exclude=dist \
      --exclude=.env \
      --exclude='ops/caddy/certs' \
      --exclude='*.log' \
      -czf - . \
    | ssh $SSH_OPTS "$HOST" "tar -xzf - -C $REMOTE_DIR"; then
    delivered="да"
    break
  fi
  printf '  (передача сорвалась, попытка %d из 3)\n' "$((attempt + 1))" >&2
  sleep 5
done

[ -n "$delivered" ] || fail "не удалось передать исходники на сервер"

# ─── Сертификат для вебхука, если домена ещё нет ──────────────────────────────

CADDYFILE=$(sshx "grep -E '^CADDYFILE=' $REMOTE_DIR/.env | cut -d= -f2-" || true)

if [ "${CADDYFILE:-Caddyfile}" = "Caddyfile.selfsigned" ]; then
  say "Проверяю самоподписанный сертификат"
  ssh $SSH_OPTS "$HOST" "bash -s" <<REMOTE
set -euo pipefail
cd "$REMOTE_DIR"
mkdir -p ops/caddy/certs

if [ -f ops/caddy/certs/webhook.pem ]; then
  # Сертификат живёт год. За месяц до конца пора выпускать новый, иначе
  # Telegram однажды просто перестанет доставлять апдейты.
  if openssl x509 -in ops/caddy/certs/webhook.pem -checkend 2592000 -noout >/dev/null 2>&1; then
    echo "сертификат на месте и годен ещё больше месяца"
    exit 0
  fi
  echo "сертификат истекает, выпускаю новый"
fi

# CN должен совпадать с адресом, на который Telegram шлёт вебхук.
HOSTNAME_FOR_CERT=\$(grep -E '^SITE_ADDRESS=' .env | cut -d= -f2- | sed -E 's#^https?://##; s#/.*##')
[ -n "\$HOSTNAME_FOR_CERT" ] || { echo "в .env нет SITE_ADDRESS" >&2; exit 1; }

openssl req -newkey rsa:2048 -sha256 -nodes -days 365 -x509 \
  -keyout ops/caddy/certs/webhook.key \
  -out ops/caddy/certs/webhook.pem \
  -subj "/CN=\$HOSTNAME_FOR_CERT" \
  -addext "subjectAltName=IP:\$HOSTNAME_FOR_CERT" 2>/dev/null \
  || openssl req -newkey rsa:2048 -sha256 -nodes -days 365 -x509 \
       -keyout ops/caddy/certs/webhook.key \
       -out ops/caddy/certs/webhook.pem \
       -subj "/CN=\$HOSTNAME_FOR_CERT"

chmod 600 ops/caddy/certs/webhook.key
echo "выпущен сертификат для \$HOSTNAME_FOR_CERT"
REMOTE
fi

# ─── Сборка и запуск ──────────────────────────────────────────────────────────

say "Собираю образ и поднимаю сервисы"
sshx "cd $REMOTE_DIR && $COMPOSE up -d --build --remove-orphans"

# Конфиг Caddy лежит в примонтированном файле. Compose видит, что описание
# контейнера не изменилось, и не пересоздаёт его — правка Caddyfile сама по
# себе не доехала бы до работающего прокси. Перезагрузка мягкая: соединения
# не рвутся, и делать её можно на каждой выкладке.
say "Перечитываю конфигурацию Caddy"
sshx "cd $REMOTE_DIR && $COMPOSE exec -T caddy caddy reload --config /etc/caddy/${CADDYFILE:-Caddyfile} --adapter caddyfile"

# ─── Схема базы: применено по журналу ≠ применено по факту ────────────────────
#
# Задача 3.63, и страж существует из-за случившегося. 05.09.2026 миграция
# была применена в недописанном виде: одну колонку добавил, вторую дописал
# в файл минутой позже. Журнал drizzle пометил миграцию выполненной, и
# больше её никто не запускал — значит вторая колонка не появилась бы
# никогда. Стоило трёх прогонов сквозного и неверной догадки про модель.
#
# Тесты такое не ловят: они работают на своей базе, которую пересоздают
# каждый раз. Ловить надо здесь — на выкладке, до того как бот начнёт
# отвечать людям.
say "Сверяю схему базы с кодом"
sshx "cd $REMOTE_DIR && $COMPOSE run --rm --no-deps -T bot npx tsx apps/bot/src/scripts/check-schema.ts"

# ─── Проверка, что выкатилось живое ───────────────────────────────────────────

say "Жду готовности бота"
ssh $SSH_OPTS "$HOST" "bash -s" <<REMOTE
set -euo pipefail
cd "$REMOTE_DIR"

for attempt in \$(seq 1 30); do
  state=\$(docker inspect --format '{{.State.Health.Status}}' \
    \$($COMPOSE ps -q bot) 2>/dev/null || echo "нет контейнера")

  case "\$state" in
    healthy) echo "бот здоров"; exit 0 ;;
    unhealthy) echo "бот поднялся нездоровым" >&2; break ;;
  esac

  sleep 2
done

echo "не дождался готовности, последние строки журнала:" >&2
$COMPOSE logs --tail 40 bot >&2
exit 1
REMOTE

# ─── Промпты: бот здоров и без них, а разбор — нет ────────────────────────────
#
# Открытый хвост 16, и сторож существует из-за случившегося: при выкладке
# этапа 2 бот поднялся здоровым и упал на первой же выгрузке, потому что
# активной версии промпта в базе не было. Тексты промптов лежат вне
# репозитория и в архив выкладки не попадают — заливка отдельный шаг, о
# котором легко забыть, а проверка готовности его не ловит.
say "Проверяю активные промпты"
# Прямой вызов, а не sshx: тот трижды повторяет при неуспехе, и настоящая
# нехватка промпта выглядела бы обрывом связи.
# shellcheck disable=SC2086
if ! ssh $SSH_OPTS "$HOST" "cd $REMOTE_DIR && $COMPOSE exec -T bot node apps/bot/dist/scripts/check-prompts.js"; then
  printf '
[31mВыкладка прошла, но разбор работать не будет.[0m
' >&2
  printf 'Залейте промпты: ./ops/seed-prompts.sh --activate
' >&2
  exit 1
fi

say "Состояние сервисов"
sshx "cd $REMOTE_DIR && $COMPOSE ps"

say "Готово"
