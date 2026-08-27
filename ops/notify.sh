#!/usr/bin/env bash
# Оповещение о сбоях служебных заданий (§18 ТЗ).
#
# §18 требует, чтобы об ошибках узнавали, а не догадывались. Внутри бота
# это работает: мониторинг шлёт оповещение в чат при росте доли ошибок —
# проверено на живой системе 27.08.2026.
#
# А вот копии базы и проверка восстановления живут в cron и пишут только
# в журнал. Журнал никто не читает. Значит сломавшаяся копия молчит ровно
# до того дня, когда она понадобится, — то есть ведёт себя как её
# отсутствие.
#
# Подключается так:
#   . "$(dirname "$0")/notify.sh"
#   trap 'notify_failure "копия базы"' ERR
#
# Нужны MONITORING_BOT_TOKEN и MONITORING_CHAT_ID. Не заданы — сообщение
# уходит в журнал, и это честно сказано: тихого отказа быть не должно.

notify() {
  local text="$1"

  if [ -z "${MONITORING_BOT_TOKEN:-}" ] || [ -z "${MONITORING_CHAT_ID:-}" ]; then
    echo "Оповещение не отправлено (нет MONITORING_BOT_TOKEN или MONITORING_CHAT_ID): ${text}" >&2
    return 0
  fi

  # Отказ самого оповещения не должен ронять задание: копия важнее
  # сообщения о копии.
  curl --silent --show-error --max-time 20 \
    --data-urlencode "chat_id=${MONITORING_CHAT_ID}" \
    --data-urlencode "text=${text}" \
    "https://api.telegram.org/bot${MONITORING_BOT_TOKEN}/sendMessage" >/dev/null 2>&1 \
    || echo "Не удалось отправить оповещение: ${text}" >&2
}

# Сообщение о провале задания. Вызывается из trap на ERR.
notify_failure() {
  local what="$1"
  local host
  host="$(hostname 2>/dev/null || echo 'сервер')"

  notify "⚠️ ${what}: задание не выполнено на ${host}. Смотри /var/log/vydoh-backup.log"
}

# Осмысленный отказ: сообщить человеку и выйти.
#
# Отдельно от ловушки ERR: она не срабатывает на явном `exit`, а именно
# так выходят наши проверки — «копий нет», «в копии нет таблиц», «копия
# пуста». Это самые важные отказы, и молчать о них нельзя.
die() {
  local what="$1"
  local reason="$2"

  echo "$reason" >&2
  notify "⚠️ ${what}: ${reason}"
  exit 1
}
