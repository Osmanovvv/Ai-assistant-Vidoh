#!/usr/bin/env bash
# Сквозной тест первого этапа на боевом сервере (задача 1.24).
#
# Запускается с машины разработчика после ./ops/deploy.sh:
#     ./ops/e2e-stage1.sh
#
# Проверяет на живой системе три сценария §21 ТЗ:
#   1. Серия сообщений подряд — одна выгрузка, один склеенный текст
#   2. Сообщение во время обработки не потеряно
#   3. Перезапуск сервиса посреди обработки не съедает выгрузку
#
# Чего тест НЕ проверяет: расшифровку голосового. Голосовое может
# прислать только настоящий человек из Telegram — ссылка на файл живёт
# у Telegram, и подделать её нельзя. Этот сценарий проверяется вручную,
# см. docs/07-runbook.md.

set -euo pipefail

HOST="${VYDOH_HOST:-vydoh}"
REMOTE_DIR="${VYDOH_DIR:-/opt/vydoh}"
COMPOSE="docker compose -f docker-compose.prod.yml"

# Заведомо несуществующий пользователь Telegram: настоящие идентификаторы
# в этот диапазон не попадают.
CHAT_ID=999000001

SILENCE_SEC=30

passed=0
failed=0

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok() { printf '  \033[32mOK\033[0m  %s\n' "$1"; passed=$((passed + 1)); }
no() { printf '  \033[31mНЕТ\033[0m %s\n' "$1"; failed=$((failed + 1)); }

# Обрыв SSH посреди трёхминутного теста — обычное дело, и он не должен
# выглядеть как провал сценария. Поэтому три попытки.
remote() {
  local attempt
  for attempt in 1 2 3; do
    if ssh -o ConnectTimeout=20 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 \
         "$HOST" "cd $REMOTE_DIR && $*"; then
      return 0
    fi
    printf '  (соединение сорвалось, попытка %d из 3)\n' "$((attempt + 1))" >&2
    sleep 5
  done
  return 1
}

sql() {
  remote "$COMPOSE exec -T postgres psql -U vydoh -d vydoh -tAq -c \"$1\"" | tr -d '\r'
}

send() {
  remote "$COMPOSE exec -T bot node apps/bot/dist/scripts/send-test-update.js $CHAT_ID $1 '$2'" \
    > /dev/null
}

cleanup() {
  # Каскад по внешним ключам уносит сообщения и выгрузки вместе с человеком.
  #
  # Журнал апдейтов чистится отдельно: у него нет ссылки на пользователя,
  # и без этого повторный прогон отсекался бы дедупликацией по update_id
  # — все проверки падали бы, хотя система работает правильно.
  # Диапазон 900000000+ отведён под тесты, настоящие апдейты сюда не попадают.
  sql "delete from users where tg_id = $CHAT_ID;
       delete from telegram_updates where update_id >= 900000000;" > /dev/null 2>&1 || true
}

expect_eq() {
  if [ "$2" = "$3" ]; then ok "$1"; else no "$1 (ожидалось «$3», получено «$2»)"; fi
}

trap cleanup EXIT

# Все факты о состоянии забираются одним запросом: каждое обращение к
# серверу — это отдельное SSH-соединение, и чем их меньше, тем меньше
# поводов у теста упасть не по делу.
FACTS="select
  (select count(*) from batches b join users u on u.id = b.user_id where u.tg_id = $CHAT_ID)
  || '~' ||
  (select coalesce(string_agg(b.status::text, ',' order by b.opened_at), '-')
     from batches b join users u on u.id = b.user_id where u.tg_id = $CHAT_ID)
  || '~' ||
  (select coalesce(sum(b.message_count), 0)
     from batches b join users u on u.id = b.user_id where u.tg_id = $CHAT_ID)
  || '~' ||
  (select count(*) from messages_raw m join users u on u.id = m.user_id where u.tg_id = $CHAT_ID)
  || '~' ||
  (select count(*) from messages_raw m join users u on u.id = m.user_id
     where u.tg_id = $CHAT_ID and m.batch_id is null)
  || '~' ||
  (select coalesce(string_agg(replace(b.combined_text, chr(10), ' | '), ' // ' order by b.opened_at), '-')
     from batches b join users u on u.id = b.user_id where u.tg_id = $CHAT_ID)
  || '~' ||
  (select count(*) from batches b join users u on u.id = b.user_id
     where u.tg_id = $CHAT_ID and b.status_message_id is not null);"

# Раскладывает ответ по переменным: выгрузок, статусы, сообщений в
# выгрузках, сообщений всего, без выгрузки, тексты.
read_facts() {
  local row
  row=$(sql "$FACTS")
  BATCHES=$(printf '%s' "$row" | cut -d'~' -f1)
  STATUSES=$(printf '%s' "$row" | cut -d'~' -f2)
  IN_BATCHES=$(printf '%s' "$row" | cut -d'~' -f3)
  MESSAGES=$(printf '%s' "$row" | cut -d'~' -f4)
  ORPHANS=$(printf '%s' "$row" | cut -d'~' -f5)
  TEXTS=$(printf '%s' "$row" | cut -d'~' -f6)
  WITH_REPLY=$(printf '%s' "$row" | cut -d'~' -f7)
}

# ─── Сценарий 1: серия сообщений — одна выгрузка ──────────────────────────────

say "Сценарий 1: три сообщения подряд дают одну выгрузку"
cleanup

send 101 'надо записать сына к врачу'
sleep 3
send 102 'и купить продуктов'
sleep 3
send 103 'ещё забрать вещи из химчистки'

echo "  жду закрытия по тишине (${SILENCE_SEC} с) и обработки"
sleep $((SILENCE_SEC + 15))
read_facts

# §9.1 правило 2 ТЗ: серия сообщений — это одна мысль.
expect_eq "выгрузка ровно одна" "$BATCHES" "1"
expect_eq "выгрузка обработана" "$STATUSES" "done"
expect_eq "в выгрузке все три сообщения" "$IN_BATCHES" "3"
expect_eq "текст склеен в порядке получения" "$TEXTS" \
  "надо записать сына к врачу | и купить продуктов | ещё забрать вещи из химчистки"

# Чат выдуманный, поэтому Telegram отвергает ответ — и это часть проверки:
# недоставленная реплика не должна ни ронять разбор, ни оставлять в базе
# идентификатор несуществующего сообщения. Настоящий ответ живому человеку
# проверяется отдельно, скриптом ops/check-voice.sh.
expect_eq "несостоявшийся ответ не сохранён как отправленный" "$WITH_REPLY" "0"

# ─── Сценарий 2: сообщение во время обработки ─────────────────────────────────

say "Сценарий 2: сообщение во время обработки не потеряно"
cleanup

send 201 'первая мысль'
echo "  жду закрытия первой выгрузки"
sleep $((SILENCE_SEC + 2))

# Ровно в момент разбора первой выгрузки приходит следующее сообщение.
send 202 'вторая мысль, пришла в момент разбора'

echo "  жду закрытия второй выгрузки"
sleep $((SILENCE_SEC + 15))
read_facts

expect_eq "сохранены оба сообщения" "$MESSAGES" "2"
expect_eq "ни одно не осталось без выгрузки" "$ORPHANS" "0"
expect_eq "обе выгрузки доведены до конца" "$STATUSES" "done,done"

# ─── Сценарий 3: перезапуск посреди обработки ─────────────────────────────────

say "Сценарий 3: перезапуск сервиса не съедает незавершённую обработку"
cleanup

send 301 'мысль, которую прервёт перезапуск'
echo "  жду закрытия выгрузки"
sleep $((SILENCE_SEC + 1))

echo "  перезапускаю бота ровно в момент разбора"
remote "$COMPOSE restart bot" > /dev/null 2>&1

echo "  жду восстановления"
sleep 30
read_facts

# §9.1 правило 4 ТЗ: незавершённая обработка возобновляется, а не теряется.
expect_eq "выгрузка доведена до конца после перезапуска" "$STATUSES" "done"
expect_eq "текст на месте" "$TEXTS" "мысль, которую прервёт перезапуск"

# ─── Итог ─────────────────────────────────────────────────────────────────────

say "Итог"
printf '  пройдено: %d, провалено: %d\n\n' "$passed" "$failed"

[ "$failed" -eq 0 ]
