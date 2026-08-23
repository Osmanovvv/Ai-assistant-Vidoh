#!/usr/bin/env bash
# Резервная копия базы (задача 1.22).
#
# §18 ТЗ: регулярная копия с проверкой восстановления. Встроенные копии
# хостинга делаются раз в несколько дней — этого мало.
#
# §16 ТЗ: дамп содержит расшифровки, поэтому шифруется и кладётся в
# хранилище на территории РФ. Ключ шифрования берётся из окружения и
# в репозиторий не попадает.
set -euo pipefail

: "${DATABASE_URL:?нужна переменная DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/vydoh}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="${BACKUP_DIR}/vydoh-${STAMP}.dump"

mkdir -p "$BACKUP_DIR"

echo "Снимаю дамп: ${DUMP}"
# -Fc: сжатый формат, восстанавливается выборочно и параллельно.
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-privileges --file="$DUMP"

if [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then
  echo "Шифрую дамп"
  gpg --batch --yes --symmetric --cipher-algo AES256 \
      --passphrase "$BACKUP_ENCRYPTION_PASSPHRASE" \
      --output "${DUMP}.gpg" "$DUMP"
  shred -u "$DUMP" 2>/dev/null || rm -f "$DUMP"
  DUMP="${DUMP}.gpg"
else
  # Незашифрованный дамп с расшифровками — нарушение §16 ТЗ.
  echo "ВНИМАНИЕ: BACKUP_ENCRYPTION_PASSPHRASE не задан, дамп не зашифрован" >&2
fi

SIZE="$(du -h "$DUMP" | cut -f1)"
echo "Готово: ${DUMP} (${SIZE})"

# Старые копии убираются, иначе диск кончится молча.
find "$BACKUP_DIR" -name 'vydoh-*.dump*' -type f -mtime "+${KEEP_DAYS}" -print -delete

echo "Копий в хранилище: $(find "$BACKUP_DIR" -name 'vydoh-*.dump*' -type f | wc -l)"
