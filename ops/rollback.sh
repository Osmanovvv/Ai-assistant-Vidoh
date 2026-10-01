#!/usr/bin/env bash
# Запускается на сервере. По умолчанию — только план, без изменения контейнеров.
# --apply допустим после явного согласования отката и совместимости схемы/промптов.
set -euo pipefail

cd "${VYDOH_DIR:-$(dirname "$0")/..}"
image="${1:-}"
mode="${2:---plan}"
[[ "$image" =~ ^vydoh-bot:(rollback|release)-[a-f0-9]{64}$ ]] \
  || { printf 'Укажите сохранённый образ vydoh-bot:rollback-<полный ID> или release-<полный ID>\n' >&2; exit 1; }
[ "$#" -le 2 ] || { printf 'Лишние аргументы\n' >&2; exit 1; }
case "$mode" in
  --plan|--apply) ;;
  *) printf 'Допустимый режим: --plan или --apply\n' >&2; exit 1 ;;
esac

expected="sha256:${image##*-}"
actual=$(docker image inspect --format '{{.Id}}' "$image")
[ "$actual" = "$expected" ] || { printf 'Сохранённая метка указывает на другой образ\n' >&2; exit 1; }
[ -f docker-compose.prod.yml ] || { printf 'Нет docker-compose.prod.yml\n' >&2; exit 1; }

printf 'Образ для возврата: %s\n' "$image"
printf 'Будет пересоздан только bot, без сборки и миграций. База и промпты не восстанавливаются.\n'
if [ "$mode" = --plan ]; then
  printf 'План готов. Для применения нужен отдельный запуск с --apply после согласования.\n'
  exit 0
fi

# Отдельный override работает и с прежним Compose, где image был latest.
# latest сохраняется: возврат выбирает конкретный образ, а не меняет общий ярлык.
mkdir -p .data/releases
override=".data/releases/rollback-${image##*-}.yml"
printf 'services:\n  bot:\n    image: %s\n' "$image" > "$override"
docker compose -f docker-compose.prod.yml -f "$override" up -d --no-build --no-deps bot
printf 'Команда возврата выполнена. Проверьте состояние bot и затем ручной сценарий в Telegram.\n'
