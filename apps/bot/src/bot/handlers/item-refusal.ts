import type { Item } from '../../db/schema.js';
import { isoDateIn, localDateParts } from '../../modules/classifier/dates.js';
import { isRecurring } from '../../modules/recurrence/recurrence.service.js';
import type { ApplyAction } from '../../modules/resolver/patch.js';
import type { TextProfile } from '../../texts/index.js';

/**
 * Что ответить на кнопку, которая ничего не изменит (ревизия этапа 3, C3
 * и C5).
 *
 * Карточка и напоминание остаются в чате навсегда, и кнопки на них
 * нажимают спустя дни. «Сделано» на уже закрытом деле переписывало дату
 * закрытия на сегодня — или отвечало «Этой записи больше нет», хотя
 * запись есть, она закрыта. Одна проверка на обе кнопки: закрытое дело
 * не трогается, человеку называется его состояние.
 */
export function buttonRefusal(
  action: ApplyAction,
  item: Item,
  texts: TextProfile,
  timeZone: string,
  now: Date,
): string | undefined {
  if (item.status === 'done' || item.status === 'cancelled') {
    return texts.card.closed(texts.card.statusName(item.status));
  }

  if (
    action === 'snooze' &&
    item.status === 'snoozed' &&
    item.deadlineAt !== null &&
    item.deadlineAt.getTime() > now.getTime()
  ) {
    return texts.card.snoozedAlready(shortDate(item.deadlineAt, timeZone));
  }

  return undefined;
}

/**
 * Реплика на «менять нечего» после отказов выше.
 *
 * Так бывает у одного случая: регулярное дело сегодня уже отмечали —
 * второе «Сделано» за день срок не двигает (C2). Всё прочее — запись
 * исчезла между чтением и записью.
 */
export function nothingChangedReply(
  action: ApplyAction,
  item: Item,
  texts: TextProfile,
  timeZone: string,
  now: Date,
): string {
  const doneToday =
    action === 'complete' &&
    isRecurring(item) &&
    item.completedAt !== null &&
    isoDateIn(item.completedAt, timeZone) === isoDateIn(now, timeZone);

  return doneToday ? texts.card.doneToday(item.text) : texts.card.gone;
}

function shortDate(at: Date, timeZone: string): string {
  const parts = localDateParts(at, timeZone);
  return `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}`;
}
