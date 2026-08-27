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

# Оповещение о провале: §18 ТЗ требует, чтобы об ошибках узнавали.
# Без этого сломавшееся задание молчит до того дня, когда оно
# понадобится, — то есть ведёт себя как отсутствующее.
# shellcheck source=ops/notify.sh
. "$(dirname "$0")/notify.sh"
trap 'notify_failure "копия базы"' ERR

: "${DATABASE_URL:?нужна переменная DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/vydoh}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="${BACKUP_DIR}/vydoh-${STAMP}.dump"

# Чем снимать дамп. На машине разработчика это обычный pg_dump, на сервере
# база живёт в контейнере и порт наружу не публикуется, поэтому туда
# подставляется «docker compose exec -T postgres pg_dump». Так и локально,
# и в бою работает один и тот же проверенный скрипт.
PG_DUMP_CMD="${PG_DUMP_CMD:-pg_dump}"

mkdir -p "$BACKUP_DIR"

# Дамп идёт потоком, а не через промежуточный файл: на диск никогда не
# ложится незашифрованная копия расшифровок (§16 ТЗ). Раньше файл писался
# и затирался shred, но между записью и затиранием оставалось окно, а на
# SSD затирание к тому же ничего не гарантирует.
# -Fc: сжатый формат, восстанавливается выборочно и параллельно.
dump_stream() {
  # shellcheck disable=SC2086
  $PG_DUMP_CMD --dbname="$DATABASE_URL" --format=custom --no-owner --no-privileges
}

if [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then
  echo "Снимаю и шифрую дамп: ${DUMP}.gpg"
  dump_stream | gpg --batch --yes --symmetric --cipher-algo AES256 \
      --passphrase "$BACKUP_ENCRYPTION_PASSPHRASE" \
      --output "${DUMP}.gpg"
  DUMP="${DUMP}.gpg"
else
  # Незашифрованный дамп с расшифровками — нарушение §16 ТЗ.
  echo "ВНИМАНИЕ: BACKUP_ENCRYPTION_PASSPHRASE не задан, дамп не зашифрован" >&2
  echo "Снимаю дамп: ${DUMP}"
  dump_stream > "$DUMP"
fi

SIZE="$(du -h "$DUMP" | cut -f1)"
echo "Готово: ${DUMP} (${SIZE})"

# Старые копии убираются, иначе диск кончится молча.
find "$BACKUP_DIR" -name 'vydoh-*.dump*' -type f -mtime "+${KEEP_DAYS}" -print -delete

echo "Копий в хранилище: $(find "$BACKUP_DIR" -name 'vydoh-*.dump*' -type f | wc -l)"
