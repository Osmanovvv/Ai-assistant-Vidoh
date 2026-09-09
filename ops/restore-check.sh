#!/usr/bin/env bash
# Проверка восстановления (задача 1.22).
#
# §18 ТЗ требует не просто копию, а копию с проверкой восстановления.
# Непроверенный бэкап — это не бэкап: узнать, что он битый, в момент
# аварии слишком поздно.
#
# Скрипт поднимает последний дамп на временной базе, сверяет состав
# таблиц и число строк с живой базой и удаляет временную базу.
set -euo pipefail

# Оповещение о провале: §18 ТЗ требует, чтобы об ошибках узнавали.
# Без этого сломавшееся задание молчит до того дня, когда оно
# понадобится, — то есть ведёт себя как отсутствующее.
# shellcheck source=ops/notify.sh
. "$(dirname "$0")/notify.sh"
trap 'notify_failure "проверка восстановления"' ERR

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

# `-r` у xargs обязателен: без него на пустом вводе запускается `ls` без
# аргументов, тот показывает текущий каталог, и скрипт принимает за копию
# первую попавшуюся папку. Поймано 27.08.2026 на проверке оповещений:
# вместо внятного «копий нет» приходил невнятный отказ pg_restore на
# файле с именем «ops».
LATEST="$(find "$BACKUP_DIR" -name 'vydoh-*.dump*' -type f -print0 2>/dev/null \
  | xargs -0 -r ls -1t 2>/dev/null | head -1 || true)"

if [ -z "$LATEST" ] || [ ! -f "$LATEST" ]; then
  die "проверка восстановления" "в ${BACKUP_DIR} нет ни одной копии"
fi

# Возраст копии — половина проверки, и её здесь не было.
#
# Условие готовности 1.22 требует «поднимает **вчерашний** дамп», а
# скрипт брал самый свежий из имеющихся и о дате не спрашивал: отказ был
# только на «нет ни одной копии». То есть стоило backup.sh перестать
# снимать копии — и эта проверка каждый день докладывала «Копия
# восстанавливается», подтверждая вчерашний дамп десятидневным.
# Замерено 09.09.2026 на стенде: копия десятидневной давности проходила
# проверку с кодом выхода 0 и без единого слова о её дате. Молчание
# длилось бы до дня, когда ротация (BACKUP_KEEP_DAYS в backup.sh) съест
# последнюю копию, — то есть до аварии, в которую восстанавливать будет
# нечего.
#
# Порог в двое суток, а не в одни. По расписанию (ops/cron/vydoh) копия
# снимается в 3:20, проверка идёт в 4:00 — то есть в норме копии около
# сорока минут, и двое суток это запас на один пропущенный или
# затянувшийся запуск. Тревога, которая звенит на норме, кончается тем,
# что её перестают слушать. А вот двое суток без копии — это уже
# сломанное задание, и звенеть надо.
MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-48}"

# Время файла: на сервере GNU stat, у разработчика на macOS — BSD.
file_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"
}

NOW_SECONDS="$(date +%s)"
LATEST_SECONDS="$(file_mtime "$LATEST")"
AGE_HOURS=$(( (NOW_SECONDS - LATEST_SECONDS) / 3600 ))

# Возраст печатается всегда, а не только при отказе: «Копия
# восстанавливается» без даты копии — ровно то сообщение, которое и
# усыпляло. Число, по которому принимают решение, должно стоять в
# журнале рядом с выводом.
echo "Проверяю копию: ${LATEST} (возраст ${AGE_HOURS} ч)"

if [ "$AGE_HOURS" -gt "$MAX_AGE_HOURS" ]; then
  die "проверка восстановления" \
    "последней копии ${AGE_HOURS} ч, а порог ${MAX_AGE_HOURS} ч: ${LATEST}. Похоже, копии перестали снимать — проверять восстановление уже нечего"
fi

WORK_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK_DIR"
  psql_run "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${CHECK_DB}\";" >/dev/null
}
trap cleanup EXIT

# Открытая копия — это отказ, а не находка (§16; ревизия этапа 1).
#
# Прежде проверка принимала дамп без .gpg наравне с зашифрованным и
# молчала: единственный признак того, что копии перестали шифровать,
# уходил в журнал, который никто не читает. Теперь backup.sh без
# парольной фразы копию не снимает вовсе, но открытая копия могла
# остаться с прежних дней или быть положена руками — и тогда об этом
# надо сказать, а не подтверждать её восстановление.
if [[ "$LATEST" != *.gpg ]]; then
  die "проверка восстановления" "последняя копия не зашифрована: ${LATEST}. §16 требует шифровать копии; уберите открытый дамп и снимите новый"
fi

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

# Список таблиц берётся из живой базы, а не пишется руками.
#
# Раньше он был вписан в скрипт и застыл на первом этапе: без items,
# topics, prompt_versions и user_state. Копия без всех данных второго
# этапа прошла бы проверку молча. Список из живой базы устареть не может:
# появится таблица — она сама попадёт в ожидаемые.
TABLES_QUERY="SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;"

LIVE_TABLES="$(psql_run "$DATABASE_URL" -tAc "$TABLES_QUERY" | tr -d '\r' | tr '\n' ' ')"

if [ -z "$(printf '%s' "$LIVE_TABLES" | tr -d '
 ')" ]; then
  die "проверка восстановления" "в живой базе нет ни одной таблицы"
fi

MISSING=""
for table in $LIVE_TABLES; do
  FOUND="$(psql_run "$RESTORE_URL" -tAc "SELECT to_regclass('public.${table}');" | tr -d '
 ')"
  if [ "$FOUND" != "$table" ]; then
    MISSING="${MISSING} ${table}"
  fi
done

if [ -n "$MISSING" ]; then
  die "проверка восстановления" "в восстановленной копии нет таблиц:${MISSING}"
fi

echo "Таблиц проверено по живой базе: $(printf '%s' "$LIVE_TABLES" | wc -w)"

# Пустота копии при непустой базе — сломанная копия.
#
# Раньше строки печатались, и всё. На пустой базе проверка зеленела,
# ничего не проверив, — именно так она и прошла 27.08.2026 сразу после
# удаления тестовых данных. Печать без сравнения не проверка.
LIVE_ROWS=0
COPY_ROWS=0

for table in $LIVE_TABLES; do
  LIVE_COUNT="$(psql_run "$DATABASE_URL" -tAc "SELECT count(*) FROM ${table};" | tr -d '
 ')"
  COPY_COUNT="$(psql_run "$RESTORE_URL" -tAc "SELECT count(*) FROM ${table};" | tr -d '
 ')"

  LIVE_ROWS=$((LIVE_ROWS + LIVE_COUNT))
  COPY_ROWS=$((COPY_ROWS + COPY_COUNT))

  if [ "$LIVE_COUNT" != "0" ] || [ "$COPY_COUNT" != "0" ]; then
    printf '  %-20s копия %-8s живая %s\n' "$table" "$COPY_COUNT" "$LIVE_COUNT"
  fi
done

# Строк в копии меньше, чем в живой базе, — норма: между снимком и
# проверкой люди продолжали писать. А вот пустая копия непустой базы — нет.
if [ "$LIVE_ROWS" != "0" ] && [ "$COPY_ROWS" = "0" ]; then
  die "проверка восстановления" "живая база не пуста (${LIVE_ROWS} строк), а копия пуста"
fi

if [ "$LIVE_ROWS" = "0" ]; then
  echo "Внимание: живая база пуста, сверять строки не с чем." >&2
fi

echo "Копия восстанавливается (возраст ${AGE_HOURS} ч, порог ${MAX_AGE_HOURS} ч)."
