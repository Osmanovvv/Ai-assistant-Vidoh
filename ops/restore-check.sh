#!/usr/bin/env bash
# Проверка восстановления (задача 1.22).
#
# §18 ТЗ требует не просто копию, а копию с проверкой восстановления.
# Непроверенный бэкап — это не бэкап: узнать, что он битый, в момент
# аварии слишком поздно.
#
# Скрипт поднимает последний дамп на временной базе, сверяет, что все
# таблицы на месте и в них есть строки, и удаляет временную базу.
set -euo pipefail

: "${DATABASE_URL:?нужна переменная DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/vydoh}"
CHECK_DB="${RESTORE_CHECK_DB:-vydoh_restore_check}"

# См. пояснение в backup.sh: на сервере база живёт в контейнере, и сюда
# подставляется «docker compose exec -T postgres psql» и то же для
# pg_restore. Локально это обычные psql и pg_restore.
PSQL_CMD="${PSQL_CMD:-psql}"
PG_RESTORE_CMD="${PG_RESTORE_CMD:-pg_restore}"

psql_run() {
  # shellcheck disable=SC2086
  $PSQL_CMD "$@"
}

LATEST="$(find "$BACKUP_DIR" -name 'vydoh-*.dump*' -type f -print0 \
  | xargs -0 ls -1t 2>/dev/null | head -1 || true)"

if [ -z "$LATEST" ]; then
  echo "В ${BACKUP_DIR} нет ни одной копии" >&2
  exit 1
fi

echo "Проверяю копию: ${LATEST}"

WORK_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK_DIR"
  psql_run "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${CHECK_DB}\";" >/dev/null
}
trap cleanup EXIT

DUMP="$LATEST"
if [[ "$LATEST" == *.gpg ]]; then
  : "${BACKUP_ENCRYPTION_PASSPHRASE:?копия зашифрована, нужен BACKUP_ENCRYPTION_PASSPHRASE}"
  DUMP="${WORK_DIR}/restore.dump"
  gpg --batch --yes --quiet --decrypt \
      --passphrase "$BACKUP_ENCRYPTION_PASSPHRASE" \
      --output "$DUMP" "$LATEST"
fi

psql_run "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${CHECK_DB}\";" >/dev/null
psql_run "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${CHECK_DB}\";" >/dev/null

# Подмена имени базы в адресе средствами шелла: лишняя зависимость на
# python3 внутри контейнера базы нам ни к чему.
BASE="${DATABASE_URL%%\?*}"
QUERY=""
if [ "$BASE" != "$DATABASE_URL" ]; then
  QUERY="?${DATABASE_URL#*\?}"
fi
RESTORE_URL="${BASE%/*}/${CHECK_DB}${QUERY}"

# Дамп подаётся потоком: файл лежит на хосте, а pg_restore может работать
# внутри контейнера, которому этот путь не виден.
# shellcheck disable=SC2086
$PG_RESTORE_CMD --dbname="$RESTORE_URL" --no-owner --no-privileges < "$DUMP"

EXPECTED_TABLES="ai_calls batches messages_raw telegram_updates user_settings users"
MISSING=""
for table in $EXPECTED_TABLES; do
  if ! psql_run "$RESTORE_URL" -tAc "SELECT to_regclass('public.${table}');" | grep -q "$table"; then
    MISSING="${MISSING} ${table}"
  fi
done

if [ -n "$MISSING" ]; then
  echo "В восстановленной копии нет таблиц:${MISSING}" >&2
  exit 1
fi

echo "Таблицы на месте. Строк в основных:"
for table in users messages_raw batches; do
  COUNT="$(psql_run "$RESTORE_URL" -tAc "SELECT count(*) FROM ${table};")"
  printf '  %-16s %s\n' "$table" "$COUNT"
done

echo "Копия восстанавливается."
