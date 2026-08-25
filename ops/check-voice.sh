#!/usr/bin/env bash
# Проверка голосового пути на живом боте (задачи 1.24 и 1.25).
#
# Автоматический сквозной тест голосовые проверить не может: ссылка на
# файл живёт у Telegram, подделать её нельзя. Значит, нужен человек.
#
# Как пользоваться:
#   1. Отправить боту три голосовых подряд с паузами меньше 30 секунд
#   2. Подождать примерно минуту
#   3. Запустить этот скрипт
#
#     ./ops/check-voice.sh

set -euo pipefail

HOST="${VYDOH_HOST:-vydoh}"
REMOTE_DIR="${VYDOH_DIR:-/opt/vydoh}"
COMPOSE="docker compose -f docker-compose.prod.yml"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

remote() { ssh -o ConnectTimeout=20 "$HOST" "cd $REMOTE_DIR && $*"; }
sql() { remote "$COMPOSE exec -T postgres psql -U vydoh -d vydoh $*"; }

say "Последняя выгрузка"
sql "-c \"select b.status, b.message_count as сообщений, b.combined_text as текст
           from batches b order by b.opened_at desc limit 1;\""

say "Сообщения в ней"
sql "-c \"select m.kind as вид, m.audio_duration_sec as секунд,
                 m.file_id is not null as ссылка_на_файл,
                 left(coalesce(m.transcript, m.text, ''), 60) as начало_текста
            from messages_raw m order by m.received_at desc limit 5;\""

say "Расход на распознавание (§10.5 ТЗ)"
sql "-c \"select stage as этап, model as модель, audio_seconds as секунд,
                 latency_ms as мс, ok as успех, cost_micros as стоимость
            from ai_calls order by created_at desc limit 5;\""

say "Аудио не хранится дольше обработки (§16 ТЗ)"
echo -n "  сообщений со ссылкой на файл: "
sql "-tAq -c \"select count(*) from messages_raw where file_id is not null;\"" | tr -d '\r'
echo "  содержимое временной папки контейнера:"
remote "$COMPOSE exec -T bot sh -c 'ls -A /tmp 2>/dev/null | head -5 || true'" \
  | sed 's/^/    /' || echo "    пусто"

say "Идентификатор чата для MONITORING_CHAT_ID"
echo -n "  "
sql "-tAq -c \"select coalesce(max(tg_id)::text, 'пока никто не писал') from users;\"" | tr -d ''
echo "  Вписать в /opt/vydoh/.env и выложить заново — тогда оповещения"
echo "  об ошибках пойдут в Telegram, а не только в журнал (§18 ТЗ)."

say "Что должно получиться"
cat <<'EOF'
  Одна выгрузка со статусом done и тремя сообщениями.
  В combined_text — три расшифровки через перевод строки.
  Ссылок на файлы не осталось, временная папка пуста.
  В ai_calls — по строке на каждое голосовое, все успешные.
EOF
