#!/usr/bin/env bash
# Только упаковка исходников: без SSH, Docker, запуска бота и изменения базы.
# Архив пишется в stdout; deploy.sh отправляет этот же поток на сервер.
set -euo pipefail

cd "$(dirname "$0")/.."

# Явный состав сохраняет новые локальные исходники, но не захватывает
# произвольные файлы из корня проекта. Это всё, что нужно Dockerfile,
# docker-compose.prod.yml и служебным скриптам на сервере.
paths=(
  Dockerfile
  .dockerignore
  docker-compose.prod.yml
  package.json
  package-lock.json
  tsconfig.base.json
  apps/bot
  apps/admin
  ops
)

# Отказ до записи архива: пропущенный обязательный путь не должен дать
# частичный комплект, который получатель примет за готовую выкладку.
for path in "${paths[@]}"; do
  if [ ! -e "$path" ]; then
    printf 'Ошибка упаковки: отсутствует обязательный путь %s\n' "$path" >&2
    exit 1
  fi
done

# Исключения действуют и внутри разрешённых каталогов. Промпты и отчёты
# контрольных наборов доставляет отдельно ops/seed-prompts.sh.
exec tar \
  --exclude=node_modules --exclude=dist --exclude=build --exclude=coverage \
  --exclude=.git --exclude=.github --exclude=.data --exclude=.claude \
  --exclude=.cache --exclude=.turbo --exclude=.vscode --exclude=.idea \
  --exclude=docs --exclude=secrets --exclude=logs --exclude=backups \
  --exclude=playwright-report --exclude=test-results \
  --exclude=.env --exclude='.env.*' --exclude='*.env' --exclude='*.env.*' \
  --exclude=.npmrc --exclude=.netrc --exclude=.pgpass \
  --exclude='ops/caddy/certs' \
  --exclude='*.pem' --exclude='*.key' --exclude='*.p12' --exclude='*.pfx' \
  --exclude='*.log' --exclude='*.dump' --exclude='*.backup' --exclude='*.bak' \
  --exclude='*.zip' --exclude='*.tar' --exclude='*.tgz' --exclude='*.gz' \
  --exclude='*.bz2' --exclude='*.xz' --exclude='*.zst' --exclude='*.7z' --exclude='*.rar' \
  -czf - "${paths[@]}"
