import { localDateParts } from '../classifier/dates.js';
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
