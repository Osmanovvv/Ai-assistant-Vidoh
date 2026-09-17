import { localDateParts, startOfDayInZone } from '../classifier/dates.js';
import type { TextProfile } from '../../texts/index.js';

/**
 * Срок словами — одинаково в карточке и в списке ветки (прогон
 * 17.09.2026).
 *
 * Карточка говорила «Срок: на неделе с 21.09» и «в октябре», а список
 * ветки — «· 21.09» у обоих: своя раскладка в каждом месте, и число
 * читалось как день. Неделя хранится понедельником, месяц — первым
 * числом (`dates.ts`); называть их числом нельзя — напоминание по нему
 * сработает не тогда.
 */
export function shortDate(at: Date, timeZone: string): string {
  const parts = localDateParts(at, timeZone);
  return `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}`;
}

/** Месяц в предложном падеже: «в октябре». Не реплика — склонение. */
const MONTHS_IN = [
  'январе',
  'феврале',
  'марте',
  'апреле',
  'мае',
  'июне',
  'июле',
  'августе',
  'сентябре',
  'октябре',
  'ноябре',
  'декабре',
] as const;

export function monthNameIn(at: Date, timeZone: string): string {
  return MONTHS_IN[localDateParts(at, timeZone).month - 1] ?? '';
}

export function deadlineWords(
  item: { readonly deadlineAt: Date; readonly deadlineAccuracy: string | null },
  timeZone: string,
  texts: TextProfile,
): string {
  const date = shortDate(item.deadlineAt, timeZone);

  return item.deadlineAccuracy === 'week'
    ? texts.card.deadlineWeek(date)
    : item.deadlineAccuracy === 'month'
      ? texts.card.deadlineMonth(monthNameIn(item.deadlineAt, timeZone))
      : date;
}

/**
 * Срок относительно сегодняшнего дня — для списков, где заголовок уже
 * про сегодня («На сегодня я бы взяла вот это:», Никита 17.09.2026).
 *
 * Сегодня — ничего: хвост «· сегодня» под таким заголовком лишний.
 * Завтра — словом, дальше — числом, как в списке ветки; неделя и месяц
 * — словами карточки. Просроченное — числом: видно, что день прошёл.
 */
export function dueWords(
  item: { readonly deadlineAt: Date; readonly deadlineAccuracy: string | null },
  context: { readonly now: Date; readonly timeZone: string },
  texts: TextProfile,
): string | undefined {
  if (item.deadlineAccuracy === 'week' || item.deadlineAccuracy === 'month') {
    return deadlineWords(item, context.timeZone, texts);
  }

  const today = startOfDayInZone(localDateParts(context.now, context.timeZone), context.timeZone);
  const target = startOfDayInZone(
    localDateParts(item.deadlineAt, context.timeZone),
    context.timeZone,
  );
  const days = Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60_000));

  if (days === 0) return undefined;
  if (days === 1) return 'завтра';

  return shortDate(item.deadlineAt, context.timeZone);
}
