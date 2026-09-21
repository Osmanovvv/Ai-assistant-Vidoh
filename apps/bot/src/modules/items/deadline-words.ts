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

/** Запись со сроком — и, возможно, часом внутри дня (шаг 5 ТЗ проджекта 17.09.2026). */
interface Dated {
  readonly deadlineAt: Date;
  readonly deadlineAccuracy: string | null;
  /** Минуты от местной полуночи; пусто — час не назван. */
  readonly deadlineTime?: number | null | undefined;
}

/** «13:00» из минут от полуночи — тем же видом, что в напоминании. */
function clockWords(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Час — только у точного срока: у недели и месяца его не бывает. */
function hourOf(item: Dated): string | undefined {
  return item.deadlineAccuracy === 'day' &&
    item.deadlineTime !== null &&
    item.deadlineTime !== undefined
    ? clockWords(item.deadlineTime)
    : undefined;
}

export function deadlineWords(item: Dated, timeZone: string, texts: TextProfile): string {
  const date = shortDate(item.deadlineAt, timeZone);
  const hour = hourOf(item);

  return item.deadlineAccuracy === 'week'
    ? texts.card.deadlineWeek(date)
    : item.deadlineAccuracy === 'month'
      ? texts.card.deadlineMonth(monthNameIn(item.deadlineAt, timeZone))
      : hour === undefined
        ? date
        : `${date}, ${hour}`;
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
  item: Dated,
  context: { readonly now: Date; readonly timeZone: string },
  texts: TextProfile,
): string | undefined {
  if (item.deadlineAccuracy === 'week' || item.deadlineAccuracy === 'month') {
    return deadlineWords(item, context.timeZone, texts);
  }

  const hour = hourOf(item);

  const today = startOfDayInZone(localDateParts(context.now, context.timeZone), context.timeZone);
  const target = startOfDayInZone(
    localDateParts(item.deadlineAt, context.timeZone),
    context.timeZone,
  );
  const days = Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60_000));

  // Сегодня — только час, если он есть: день под таким заголовком лишний.
  if (days === 0) return hour;
  if (days === 1) return hour === undefined ? 'завтра' : `завтра, ${hour}`;

  const date = shortDate(item.deadlineAt, context.timeZone);
  return hour === undefined ? date : `${date}, ${hour}`;
}
