#!/usr/bin/env bash
# На сервере: сохраняет образ существующего контейнера по полному ID.
# Новые слои не создаёт, сервисы не перезапускает, latest не меняет.
set -euo pipefail

cd "${VYDOH_DIR:-$(dirname "$0")/..}"
kind="${1:-rollback}"
case "$kind" in
  rollback|release) ;;
  *) printf 'Допустимое назначение: rollback или release\n' >&2; exit 1 ;;
esac
[ "$#" -le 1 ] || { printf 'Лишние аргументы\n' >&2; exit 1; }

container=$(docker compose -f docker-compose.prod.yml ps -a -q bot)
if [ -z "$container" ]; then
  if [ "$kind" = release ]; then
    printf 'Нельзя сохранить релиз: контейнера bot нет\n' >&2
    exit 1
  fi
  printf 'Контейнера bot пока нет; предыдущий образ сохранять не требуется\n'
  exit 0
fi
[[ "$container" != *$'\n'* ]] || { printf 'Ожидался один контейнер bot\n' >&2; exit 1; }

image=$(docker inspect --format '{{.Image}}' "$container")
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || { printf 'Некорректный ID образа\n' >&2; exit 1; }
state=$(docker inspect --format '{{.State.Status}}' "$container")
health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")
if [ "$kind" = release ] && { [ "$state" != running ] || [ "$health" != healthy ]; }; then
  printf 'Нельзя отметить релиз: состояние %s, здоровье %s\n' "$state" "$health" >&2
  exit 1
fi

tag="vydoh-bot:${kind}-${image#sha256:}"
existing=$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null || true)
if [ -n "$existing" ] && [ "$existing" != "$image" ]; then
  printf 'Отказ: сохранённая метка указывает на другой образ\n' >&2
  exit 1
fi
if [ -z "$existing" ]; then
  docker image tag "$image" "$tag"
fi
saved=$(docker image inspect --format '{{.Id}}' "$tag")
[ "$saved" = "$image" ] || { printf 'Сохранённый образ не совпадает с исходным\n' >&2; exit 1; }

# Только технические сведения; .env, ключи и пользовательские данные не читаются.
mkdir -p .data/releases
record=".data/releases/${kind}-${image#sha256:}.txt"
if [ ! -f "$record" ]; then
  {
    printf 'image=%s\nimage_id=%s\ncontainer=%s\n' "$tag" "$image" "$container"
    printf 'state=%s\nhealth=%s\nsaved_at=%s\n' "$state" "$health" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$record"
fi
printf 'Сохранён образ: %s\n' "$tag"
