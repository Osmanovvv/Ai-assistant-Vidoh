#!/usr/bin/env bash
# Резервная копия папки docs (открытый хвост 2).
#
# `docs/` намеренно не входит в репозиторий: он публичный, а там лежат ТЗ,
# промпты, контрольный набор и дело приёмки. Обратная сторона: у всего этого
# нет ни одной копии, кроме машины разработчика. Диск умрёт — умрёт и
# основное ноу-хау продукта вместе с историей решений.
#
# Копия шифруется той же парольной фразой, что и копии базы, и кладётся
# рядом с ними на сервер, под ту же ротацию по дням.
#
# **Запускается с машины разработчика, а не с сервера** — папка живёт здесь.
# Это слабое место: то, что запускают руками, однажды не запустят. Пока так;
# честнее иметь ручную копию, чем не иметь никакой.
#
#   ./ops/backup-docs.sh
set -euo pipefail

. "$(dirname "$0")/notify.sh"
trap 'notify_failure "копия документации"' ERR

HOST="${VYDOH_HOST:-vydoh}"
REMOTE_DIR="${VYDOH_DOCS_BACKUP_DIR:-/var/backups/vydoh-docs}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

say() {
  printf '\n==> %s\n' "$1"
}

[ -d docs ] || die "копия документации" "папка docs не найдена: запускать из корня репозитория"

# Парольная фраза берётся с сервера, из настроек копий базы: держать её
# вторым экземпляром на машине разработчика значило бы удвоить риск утечки.
say "Беру парольную фразу с сервера"
PASSPHRASE="$(ssh "$HOST" "grep '^BACKUP_ENCRYPTION_PASSPHRASE=' /opt/vydoh/backup.env | sed 's/^[^=]*=//' | tr -d '\"'")"
[ -n "$PASSPHRASE" ] || die "копия документации" "в backup.env на сервере нет BACKUP_ENCRYPTION_PASSPHRASE"

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
NAME="docs-${STAMP}.tar.gz.gpg"

say "Пакую и шифрую docs"
tar -czf - docs \
  | gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase-fd 3 --output "/tmp/${NAME}" 3<<<"$PASSPHRASE"

SIZE="$(du -h "/tmp/${NAME}" | cut -f1)"

say "Отправляю на ${HOST}:${REMOTE_DIR}"
ssh "$HOST" "mkdir -p '$REMOTE_DIR'"
scp -q "/tmp/${NAME}" "${HOST}:${REMOTE_DIR}/"
rm -f "/tmp/${NAME}"

say "Убираю копии старше ${KEEP_DAYS} дней"
ssh "$HOST" "find '$REMOTE_DIR' -name 'docs-*.tar.gz.gpg' -type f -mtime +${KEEP_DAYS} -delete"

COUNT="$(ssh "$HOST" "ls -1 '$REMOTE_DIR' | wc -l | tr -d ' '")"

printf '\nГотово: %s (%s). Копий в хранилище: %s\n' "$NAME" "$SIZE" "$COUNT"
printf 'Распаковать: gpg --decrypt файл | tar -xzf -\n'
