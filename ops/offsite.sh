#!/usr/bin/env bash
# Копия вне сервера (задача 1.22; ревизия этапов 1–2, дефект 22).
#
# План 1.22 обещал «хранение в объектном хранилище в РФ», и шапка backup.sh
# утверждала это как сделанное. На деле дамп ложился в /var/backups на ту
# же машину, где живёт база, а копия docs приезжала по scp туда же. От
# единственного риска, ради которого копии и делают, — потеря машины, —
# не защищало ничто: уходили бы разом база, все её копии и копии ноу-хау.
# И ни один документ не говорил, что так решено: расхождение было не
# осознанным, а забытым.
#
# Поэтому выбор теперь обязателен и записан в backup.env одной строкой:
#
#   BACKUP_REMOTE="offsite:vydoh"  — remote rclone вида имя:путь, куда
#                                    уезжает каждая копия. Сам remote
#                                    описывается там же, переменными
#                                    RCLONE_CONFIG_OFFSITE_TYPE="s3",
#                                    RCLONE_CONFIG_OFFSITE_PROVIDER="Other",
#                                    RCLONE_CONFIG_OFFSITE_ENDPOINT="…",
#                                    RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID="…",
#                                    RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY="…":
#                                    rclone читает их из окружения, и второй
#                                    файл с доступами не нужен — все секреты
#                                    копий остаются в одном файле с правами 600.
#   BACKUP_REMOTE="local"          — копии остаются на сервере. Так пишут
#                                    только если риск потерять сервер вместе
#                                    со всеми копиями принят осознанно.
#
# Не задано ничего — отказ с оповещением, но уже после того, как копия
# легла на диск: локальная копия и тревога лучше, чем ни того ни другого.
# Путь на диске вместо remote — тоже отказ: rclone принял бы его молча и
# положил копию на тот же сервер, вернув дефект под видом починки.
#
# Где именно стоит хранилище, скрипт проверить не может. §16 требует
# территорию РФ, и это выбор того, кто заводит remote, — не скрипта.
#
# Из backup.sh подключается через source (после notify.sh: отсюда берётся
# die). С машины разработчика backup-docs.sh зовёт его на сервере напрямую:
#   bash ops/offsite.sh put   "копия документации" /var/backups/vydoh-docs/docs-….tar.gz.gpg
#   bash ops/offsite.sh prune "копия документации" 'docs-*.tar.gz.gpg' 14

# Размер файла: на сервере GNU stat, у разработчика на macOS — BSD.
offsite_file_size() {
  stat -c %s "$1" 2>/dev/null || stat -f %z "$1"
}

# Есть ли хранилище. 0 — есть, работаем через rclone; 1 — осознанно нет.
# Не сделанный или сделанный неверно выбор — отказ, а не умолчание.
offsite_wanted() {
  local what="$1"
  case "${BACKUP_REMOTE:-}" in
    '')
      die "$what" "снята, но лежит на том же сервере, что и база: в backup.env нет BACKUP_REMOTE. Задайте remote rclone (имя:путь) или BACKUP_REMOTE=local, если риск потерять сервер вместе с копиями принят"
      ;;
    local)
      return 1
      ;;
    *:*)
      return 0
      ;;
    *)
      die "$what" "BACKUP_REMOTE=${BACKUP_REMOTE} — это путь на диске, а не remote rclone вида имя:путь; копия легла бы на тот же сервер"
      ;;
  esac
}

# Отправить файл в хранилище и убедиться, что он там целиком.
offsite_put() {
  local what="$1" file="$2"

  if ! offsite_wanted "$what"; then
    echo "Копия остаётся на сервере: BACKUP_REMOTE=local, риск потерять сервер вместе с копиями принят осознанно"
    return 0
  fi

  command -v rclone >/dev/null 2>&1 \
    || die "$what" "снята (${file}), но не выгружена: на сервере нет rclone"

  local name
  name="$(basename "$file")"

  # Три повтора у rclone по умолчанию: связь с этим сервером моргает
  # (см. deploy.sh), и одна сорвавшаяся передача — не повод остаться без
  # копии вне сервера.
  rclone copy "$file" "$BACKUP_REMOTE" \
    || die "$what" "снята (${file}), но выгрузка в ${BACKUP_REMOTE} не удалась; причина строками выше в журнале"

  # «Выгружено» — слово rclone, а не факт. Сверяется размер того, что
  # лежит в хранилище, с тем, что лежит на диске: обрезанный объект или
  # remote, смотрящий не туда, иначе прошли бы как успех.
  local want got
  want="$(offsite_file_size "$file")"
  got="$(rclone lsf --format s "${BACKUP_REMOTE}/${name}" 2>/dev/null || true)"
  if [ "$got" != "$want" ]; then
    die "$what" "в ${BACKUP_REMOTE} у ${name} размер «${got:-нет файла}», а на сервере ${want} байт: копия в хранилище неполная"
  fi

  echo "Выгружено в ${BACKUP_REMOTE}: ${name} (${want} байт, размер сверен)"
}

# Убрать из хранилища копии старше N дней и сказать, сколько осталось.
# Иначе хранилище растёт бесконечно, а платит за него заказчица.
offsite_prune() {
  local what="$1" pattern="$2" days="$3"

  offsite_wanted "$what" || return 0

  rclone delete --min-age "${days}d" --include "$pattern" "$BACKUP_REMOTE" \
    || die "$what" "не удалось убрать старые копии из ${BACKUP_REMOTE}"

  # Число печатается только из удавшегося перечня: «0» вместо «не смогли
  # перечислить» — та же ложь, что и молчание.
  local listing
  listing="$(rclone lsf --files-only --include "$pattern" "$BACKUP_REMOTE")" \
    || die "$what" "не удалось перечислить копии в ${BACKUP_REMOTE}"
  echo "Копий в хранилище ${BACKUP_REMOTE}: $(printf '%s' "$listing" | grep -c .)"
}

# Прямой запуск — по ssh с машины разработчика (backup-docs.sh).
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  # shellcheck source=ops/notify.sh
  . "$(dirname "$0")/notify.sh"

  case "${1:-}:$#" in
    put:3) offsite_put "$2" "$3" ;;
    prune:4) offsite_prune "$2" "$3" "$4" ;;
    *)
      echo "использование: offsite.sh put <что> <файл> | prune <что> <маска> <дней>" >&2
      exit 2
      ;;
  esac
fi
