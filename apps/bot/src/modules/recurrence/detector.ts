import type { RecurrenceKind } from './recurrence.js';

/**
 * Бот замечает повторяемость (запрос на изменение №1, способ третий,
 * задача 3.8в).
 *
 * Человек в четвёртый раз выгружает «надо оплатить садик». Бот замечает и
 * предлагает запомнить это как ежемесячное.
 *
 * **Порог — три повторения, а не два.** Через две точки проходит прямая
 * любой периодичности: два случая с промежутком в месяц одинаково хорошо
 * объясняются и «каждый месяц», и совпадением. Три — уже наблюдение.
 *
 * **Разброс важнее среднего.** «Примерно каждый месяц» — это
 * регулярность. «Месяц, потом три дня, потом полгода» — нет, хотя
 * среднее у них может совпасть. Поэтому условие ставится на разброс
 * промежутков: он должен быть меньше четверти медианы.
 *
 * **Определитель ничего не решает и ни к кому не ходит.** Он получает
 * даты и отвечает, есть ли в них ритм. Поиск близких записей, бюджет
 * вопроса, память об отказах — снаружи: смешав это, мы получили бы
 * функцию, которую нельзя проверить таблицей случаев.
 */

/** Сколько повторений нужно, чтобы говорить о ритме. */
export const MIN_OCCURRENCES = 3;

/** Насколько промежутки могут гулять: доля от медианы. */
export const MAX_SPREAD = 0.25;

/** Ниже этого промежутка речь о ритме не идёт: это один и тот же день. */
const MIN_GAP_DAYS = 1;

export interface Rhythm {
  readonly kind: Exclude<RecurrenceKind, 'none' | 'unclear' | 'weekdays'>;
  readonly interval: number;
  /** Медианный промежуток в днях — по нему и назван вид. */
  readonly medianDays: number;
}

const DAY_MS = 24 * 60 * 60_000;

/** Промежутки между соседними датами в днях. */
function gapsOf(dates: readonly Date[]): number[] {
  const sorted = [...dates].sort((left, right) => left.getTime() - right.getTime());
  const gaps: number[] = [];

  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous === undefined || current === undefined) continue;

    gaps.push(Math.round((current.getTime() - previous.getTime()) / DAY_MS));
  }

  return gaps;
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Как назвать найденный ритм.
 *
 * Границы широкие намеренно: человек живёт не по календарю. «Каждый
 * месяц» с промежутками 28 и 33 дня — это каждый месяц, а не «каждые
 * 30,5 дня». Назвать точнее, чем человек думает, значит соврать точностью.
 */
function nameOf(medianDays: number): Rhythm | undefined {
  if (medianDays >= 6 && medianDays <= 8) return { kind: 'weekly', interval: 1, medianDays };
  if (medianDays >= 13 && medianDays <= 16) return { kind: 'weekly', interval: 2, medianDays };
  if (medianDays >= 26 && medianDays <= 35) return { kind: 'monthly', interval: 1, medianDays };
  if (medianDays >= 55 && medianDays <= 70) return { kind: 'monthly', interval: 2, medianDays };
  if (medianDays >= 350 && medianDays <= 380) return { kind: 'yearly', interval: 1, medianDays };

  return undefined;
}

/**
 * Есть ли в датах ритм, о котором стоит спросить.
 *
 * `undefined` — ритма нет. Это нормальный и самый частый ответ: большая
 * часть дел не повторяется, и предлагать им регулярность значит
 * раздражать без пользы.
 */
export function detectRhythm(dates: readonly Date[]): Rhythm | undefined {
  if (dates.length < MIN_OCCURRENCES) return undefined;

  const gaps = gapsOf(dates);
  if (gaps.some((gap) => gap < MIN_GAP_DAYS)) return undefined;

  const median = medianOf(gaps);
  if (median <= 0) return undefined;

  /**
   * Разброс считается как наибольшее отклонение от медианы, а не как
   * стандартное. Одно выпадающее значение из четырёх — это и есть повод
   * усомниться, а стандартное отклонение его усреднит и спрячет.
   */
  const spread = Math.max(...gaps.map((gap) => Math.abs(gap - median))) / median;
  if (spread > MAX_SPREAD) return undefined;

  return nameOf(median);
}
