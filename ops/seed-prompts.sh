#!/usr/bin/env bash
# Заливка промптов на боевой сервер (задачи 2.1 и далее).
#
# Запускается с машины разработчика:
#     ./ops/seed-prompts.sh              # залить, не переключая активную
#     ./ops/seed-prompts.sh --activate   # залить и сделать активными
#
# Зачем отдельный шаг, а не часть выкладки. Тексты промптов лежат в
# docs/prompts, а эта папка намеренно не входит в репозиторий: он
# публичный, а промпты и есть основное ноу-хау продукта. Значит, в архив
# выкладки они не попадают, и доехать до сервера могут только так —
# отдельной осознанной командой.
#
# Без этого шага бот поднимется здоровым и упадёт на первой же выгрузке:
# активной версии промпта в базе нет, и разбор до модели не дойдёт.
# Проверять это надо после каждой выкладки, где менялись промпты или
# схемы ответа.

set -euo pipefail

HOST="${VYDOH_HOST:-vydoh}"
REMOTE_DIR="${VYDOH_DIR:-/opt/vydoh}"
COMPOSE="docker compose -f docker-compose.prod.yml"

cd "$(dirname "$0")/.."

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() {
  printf '\033[31mОшибка: %s\033[0m\n' "$1" >&2
  exit 1
}

SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=3"

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

ACTIVATE=""
FORCE=""
for arg in "$@"; do
  case "$arg" in
    --activate) ACTIVATE="--activate" ;;
    --force) FORCE="1" ;;
    *) fail "неизвестный флаг: $arg" ;;
  esac
done

[ -d docs/prompts ] || fail "нет папки docs/prompts — промпты лежат вне репозитория"

count=$(find docs/prompts -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')
[ "$count" -gt 0 ] || fail "в docs/prompts нет ни одного файла промпта"

# Заслон §10.3: «любое изменение промпта прогоняется по контрольному
# набору, выкладка только при отсутствии ухудшения».
#
# Требование было записано в ТЗ и ничем не исполнялось. 28.08.2026 я
# выложил router@3, потом router@4, не прогнав набор, — и регрессия дошла
# до боевого: промпт терял три единицы из сорока трёх, то есть семь
# процентов сказанного человеком не превращалось в записи.
#
# --force оставлен намеренно: промпт бывает нужно править в аварию, когда
# набор гонять некогда. Но это видно в выводе, а не втихую.
if [ -n "$FORCE" ]; then
  printf "
!! Заслон 10.3 отключён флагом --force: промпты не сверены с набором.
"
else
  say "Сверяю с прогоном контрольного набора (§10.3)"
  ( cd apps/bot && npx tsx src/scripts/check-eval-fresh.ts ../../docs/prompts ../../docs/eval ) || fail "промпты не сверены с контрольным набором. Прогнать набор, либо в аварию: ./ops/seed-prompts.sh --activate --force"
fi

say "Проверяю доступ к серверу ($HOST)"
sshx 'echo "сервер отвечает: $(hostname)"' || fail "нет доступа по SSH к $HOST"

# Отдельная папка вне рабочего дерева: выкладка перезаписывает $REMOTE_DIR
# целиком, и промпты, положенные внутрь, она бы снесла.
say "Отправляю $count промптов"
# Папка на сервере создаётся заново, а не дополняется.
#
# Раньше tar распаковывался поверх, и отменённая версия оставалась на
# сервере навсегда: заливка находила её снова и делала активной, а потом
# активной становилась следующая по порядку обхода папки. Кто останется
# активным, решал порядок имён. Найдено 28.08.2026: router@2 уехал в
# архив, а на сервере остался и был активирован перед router@3.
#
# Рантбук предупреждает ровно об этом: старая версия получает имя
# нынешней схемы, хотя писалась под прежнюю, и откат на неё молча
# деградирует разбор.
sshx "rm -rf $REMOTE_DIR/prompts && mkdir -p $REMOTE_DIR/prompts"
# shellcheck disable=SC2086
tar -czf - -C docs prompts | ssh $SSH_OPTS "$HOST" "tar -xzf - -C $REMOTE_DIR" \
  || fail "не удалось отправить промпты"

say "Заливаю в базу${ACTIVATE:+ и делаю активными}"
sshx "cd $REMOTE_DIR && $COMPOSE run --rm -T \
  -v $REMOTE_DIR/prompts:/prompts:ro \
  migrate node apps/bot/dist/scripts/seed-prompts.js /prompts $ACTIVATE"

say "Готово"

if [ -z "$ACTIVATE" ]; then
  printf '\nВерсии залиты, но активными не стали. Чтобы включить:\n'
  printf '    ./ops/seed-prompts.sh --activate\n'
fi
