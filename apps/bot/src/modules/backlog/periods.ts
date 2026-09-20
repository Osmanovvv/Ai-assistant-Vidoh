import type { TextProfile } from '../../texts/types.js';
import {
  localDateParts,
  namedWeekday,
  startOfDayAfter,
  startOfDayInZone,
} from '../classifier/dates.js';
import { FRAME_WORDS, normalizeText, wordsOf } from './question-words.js';

/**
 * Отрезки времени в вопросах к бэклогу: разбор фразы, окно, подпись.
 *
 * Вынесено из `query.service.ts` 21.09.2026: вопросы-списки по признаку
 * («что я сделала за неделю») тоже называют отрезок, и им нужен тот же
 * разбор без базы и без ответов.
 */

/**
 * О каком отрезке спросили, кроме сегодняшнего (ревизия этапа 3, F2;
 * расширено 21.09.2026 по вопросу Никиты «а на 3 дня, месяц, во вторник
 * отвечает?»).
 *
 * Строкой, а не объектом: отрезок — ключ в наборе «один день — один
 * вопрос» у маршрутизатора и поле ответа; ему нужно сравниваться.
 * Закрытый список рамок: `days:N` — «на N дней», «на ближайшие дни»;
 * `month` — «на месяц», `month:M` — «в октябре»; `weekday:D` — «во
 * вторник», `weekday:D:next` — «в следующий вторник».
 */
export type AskedPeriod =
  | 'tomorrow'
  | 'afterTomorrow'
  | 'weekend'
  | 'week'
  | 'nextWeek'
  | 'month'
  | `days:${number}`
  | `month:${number}`
  | `weekday:${number}`
  | `weekday:${number}:next`;

/**
 * «Сейчас» отсюда убрано (ТЗ проджекта 17.09.2026, 2.4): «Что у меня
 * сейчас есть?» — вопрос обо всём, а не про сегодня; «на сегодня» так и
 * говорят «на сегодня».
 */
/**
 * Время суток — тоже сегодня (21.09.2026): «что вечером», «что утром»,
 * «что до конца дня». «Дня» — ради «до конца дня»: «на 3 дня» разбирается
 * раньше рамкой отрезка, а «в течение дня» несёт предмет.
 */
const TODAY_WORDS = [
  'сегодня',
  'на сегодня',
  'ближайшее',
  'ближайшие',
  'вечером',
  'утром',
  'днем',
  'дня',
];

/** Слова о другом дне — каждое ведёт к своему отрезку (F2). */
const PERIOD_WORDS: Readonly<Record<string, AskedPeriod>> = {
  завтра: 'tomorrow',
  выходные: 'weekend',
  выходных: 'weekend',
  неделе: 'week',
  неделю: 'week',
  неделя: 'week',
  недели: 'week',
};

type BacklogTexts = TextProfile['backlog'];

/** Числительные в рамке «на N дней»: закрытый список. */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  один: 1,
  одну: 1,
  два: 2,
  две: 2,
  три: 3,
  четыре: 4,
  пять: 5,
  шесть: 6,
  семь: 7,
  восемь: 8,
  девять: 9,
  десять: 10,
  пару: 2,
  несколько: 3,
};

/** «На ближайшие дни» без числа — три дня. */
const NEAREST_DAYS = 3;

/** Больше месяца днями не спрашивают; ноль — не отрезок. */
const MAX_DAYS = 31;

/**
 * Рамки отрезков (21.09.2026). Каждая — закрытое правило со своей
 * причиной; текст без предмета за вычетом рамки должен остаться рамкой
 * вопроса — это проверяется ниже, как и у прежних слов о времени.
 */
const DAYS_PHRASE =
  /(?<!\p{L})(?:на|за)\s+(?:(эти|ближайшие|следующие)\s+)?(\d{1,2}|один|одну|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|пару|несколько)?\s*(?:ближайших\s+|ближайшие\s+)?(?:дня|дней|день|дни)(?!\p{L})/u;
const AFTER_TOMORROW = /(?<!\p{L})послезавтра(?!\p{L})/u;
const NEXT_WEEK = /(?<!\p{L})(?:на\s+)?следующ\p{L}*\s+недел\p{L}*(?!\p{L})/u;
const MONTH_PLAIN =
  /(?<!\p{L})(?:на|в|за)\s+(?:этот\s+|этом\s+|ближайший\s+)?месяц\p{L}*(?!\p{L})/u;
const MONTH_NAMES = [
  'январ',
  'феврал',
  'март',
  'апрел',
  'ма[йея]',
  'июн',
  'июл',
  'август',
  'сентябр',
  'октябр',
  'ноябр',
  'декабр',
] as const;
const MONTH_NAMED = new RegExp(
  String.raw`(?<!\p{L})(?:в|на|за)\s+(${MONTH_NAMES.join('|')})(?:\p{L}*)(?!\p{L})`,
  'u',
);
/** Дни недели в винительном/предложном: индекс — как у `Date#getDay`. */
const WEEKDAY_NAMES = [
  'воскресенье',
  'понедельник',
  'вторник',
  'сред[ау]',
  'четверг',
  'пятниц[ау]',
  'суббот[ау]',
] as const;
const WEEKDAY_NAMED = new RegExp(
  String.raw`(?<!\p{L})(?:в|во|на)\s+(?:(следующ\p{L}*|ближайш\p{L}*|эт\p{L}*)\s+)?(${WEEKDAY_NAMES.join('|')})(?!\p{L})`,
  'u',
);

/**
 * Ключи отрезков с числом — одним местом, чтобы разбор и окно не
 * разошлись в записи. Число целое, диапазон проверен вызывающим.
 */
function daysPeriod(count: number): AskedPeriod {
  return `days:${String(count)}` as `days:${number}`;
}
function monthPeriod(month: number): AskedPeriod {
  return `month:${String(month)}` as `month:${number}`;
}
function weekdayPeriod(weekday: number, next: boolean): AskedPeriod {
  return next
    ? (`weekday:${String(weekday)}:next` as `weekday:${number}:next`)
    : (`weekday:${String(weekday)}` as `weekday:${number}`);
}

/** Рамка отрезка в тексте: что спросили и какими словами. */
function periodPhrase(
  normalized: string,
): { readonly period: AskedPeriod; readonly phrase: string } | undefined {
  const days = DAYS_PHRASE.exec(normalized);
  if (days !== null) {
    const [phrase, prefix, number] = days;
    const count =
      number === undefined
        ? prefix === undefined
          ? undefined
          : NEAREST_DAYS
        : (NUMBER_WORDS[number] ?? Number(number));
    if (count === undefined || !Number.isInteger(count) || count < 1 || count > MAX_DAYS) {
      return undefined;
    }
    return { period: daysPeriod(count), phrase };
  }

  const after = AFTER_TOMORROW.exec(normalized);
  if (after !== null) return { period: 'afterTomorrow', phrase: after[0] };

  const nextWeek = NEXT_WEEK.exec(normalized);
  if (nextWeek !== null) return { period: 'nextWeek', phrase: nextWeek[0] };

  const monthNamed = MONTH_NAMED.exec(normalized);
  if (monthNamed !== null) {
    const stem = monthNamed[1] ?? '';
    const index = MONTH_NAMES.findIndex((name) => new RegExp(`^${name}$`, 'u').test(stem));
    if (index >= 0) return { period: monthPeriod(index + 1), phrase: monthNamed[0] };
  }

  const monthPlain = MONTH_PLAIN.exec(normalized);
  if (monthPlain !== null) return { period: 'month', phrase: monthPlain[0] };

  const weekday = WEEKDAY_NAMED.exec(normalized);
  if (weekday !== null) {
    const [phrase, qualifier, name] = weekday;
    const index = WEEKDAY_NAMES.findIndex((one) => new RegExp(`^${one}$`, 'u').test(name ?? ''));
    if (index >= 0) {
      const next = qualifier?.startsWith('следующ') ?? false;
      return { period: weekdayPeriod(index, next), phrase };
    }
  }

  return undefined;
}

/**
 * Спрашивают про сегодняшний день, а не про конкретное дело.
 *
 * Два условия, и второе появилось из живого прогона (задача 3.66):
 * слово о времени есть, а предмета — нет. «Что на сегодня?» и «Что у меня
 * сейчас?» спрашивают про день; «Что у меня сейчас по сайту?» — про сайт,
 * и отвечать на него списком дел на сегодня значит не ответить.
 */
export function asksAboutToday(text: string): boolean {
  return askedDay(text) === 'today';
}

/**
 * О каком дне спросили — или ни о каком (тогда это вопрос про дело).
 *
 * Правило одно на «сегодня» и остальные дни (F2): слово о времени есть,
 * а предмета — нет. «Что на завтра?» — про завтра; «что завтра по сайту?»
 * — про сайт.
 */
export function askedDay(text: string): 'today' | AskedPeriod | undefined {
  const normalized = normalizeText(text);
  const frame = new Set(FRAME_WORDS.map((word) => word.replace(/ё/gu, 'е')));
  const today = new Set(TODAY_WORDS.map((word) => word.replace(/ё/gu, 'е')));
  const isTime = (word: string): boolean => today.has(word) || word in PERIOD_WORDS;

  /**
   * Рамки отрезков — первыми (21.09.2026): «на следующей неделе» содержит
   * «неделе», «на ближайшие дни» — «ближайшие», и словарный путь ниже
   * прочёл бы их как неделю и сегодня. Рамка вырезается, остаток
   * проверяется тем же правилом: всё, что не о времени и не из рамки
   * вопроса, — предмет, и тогда вопрос про предмет.
   */
  const framed = periodPhrase(normalized);
  if (framed !== undefined) {
    const rest = wordsOf(normalized.replace(framed.phrase, ' '));
    if (rest.some((word) => !isTime(word) && !frame.has(word))) return undefined;
    return framed.period;
  }

  const words = wordsOf(normalized);
  const period = words.map((word) => PERIOD_WORDS[word]).find((one) => one !== undefined);
  const isToday = words.some((word) => today.has(word));
  if (!isToday && period === undefined) return undefined;

  // Предмет — слово, которое не о времени и не из рамки вопроса.
  if (words.some((word) => !isTime(word) && !frame.has(word))) return undefined;

  return period ?? 'today';
}

/** День недели местной даты: суббота — 6, воскресенье — 0. */
function localWeekday(now: Date, timeZone: string): number {
  const parts = localDateParts(now, timeZone);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

/**
 * Окно отрезка: [от, до) в поясе человека.
 *
 * Завтра и послезавтра — по одному дню; выходные — ближайшие суббота и
 * воскресенье (в выходные — эти); неделя — семь дней от сегодня;
 * следующая неделя — календарная, с понедельника; «на N дней» — N дней
 * от сегодня; месяц без имени — тридцать дней; названный — календарный,
 * ближайший такой (в текущем — его остаток); день недели — ближайший
 * названный по тому же правилу, что у разбора сроков (сегодняшний —
 * сегодня только до полудня), «следующий» — через неделю после него.
 */
export function periodWindow(
  period: AskedPeriod,
  context: { readonly now: Date; readonly timeZone: string },
): { readonly from: Date; readonly to: Date } {
  const { now, timeZone } = context;
  const todayStart = startOfDayInZone(localDateParts(now, timeZone), timeZone);
  const after = (days: number): Date => startOfDayAfter(now, days, timeZone);

  if (period === 'tomorrow') return { from: after(1), to: after(2) };
  if (period === 'afterTomorrow') return { from: after(2), to: after(3) };
  if (period === 'week') return { from: todayStart, to: after(7) };
  if (period === 'month') return { from: todayStart, to: after(30) };

  if (period === 'weekend') {
    const weekday = localWeekday(now, timeZone);
    const untilSaturday = weekday === 0 ? -1 : 6 - weekday;
    return { from: after(untilSaturday), to: after(untilSaturday + 2) };
  }

  if (period === 'nextWeek') {
    // До следующего понедельника: в понедельник — семь дней, в воскресенье — один.
    const weekday = localWeekday(now, timeZone);
    const untilMonday = weekday === 0 ? 1 : 8 - weekday;
    return { from: after(untilMonday), to: after(untilMonday + 7) };
  }

  const [kind, value, qualifier] = period.split(':');
  const number = Number(value);

  if (kind === 'days') return { from: todayStart, to: after(number) };

  if (kind === 'month') {
    const parts = localDateParts(now, timeZone);
    const year = number >= parts.month ? parts.year : parts.year + 1;
    const start = startOfDayInZone({ year, month: number, day: 1 }, timeZone);
    const end =
      number === 12
        ? startOfDayInZone({ year: year + 1, month: 1, day: 1 }, timeZone)
        : startOfDayInZone({ year, month: number + 1, day: 1 }, timeZone);
    return { from: start.getTime() > todayStart.getTime() ? start : todayStart, to: end };
  }

  // weekday:D[:next]
  const day = namedWeekday(number, context);
  const from = qualifier === 'next' ? startOfDayAfter(day, 7, timeZone) : day;
  return { from, to: startOfDayAfter(from, 1, timeZone) };
}

/** Как назвать отрезок после «На …»: из текстов, по виду отрезка. */
export function periodLabel(period: AskedPeriod, texts: BacklogTexts): string {
  if (period === 'tomorrow') return texts.labelTomorrow;
  if (period === 'afterTomorrow') return texts.labelAfterTomorrow;
  if (period === 'weekend') return texts.labelWeekend;
  if (period === 'week') return texts.labelWeek;
  if (period === 'nextWeek') return texts.labelNextWeek;
  if (period === 'month') return texts.labelMonth;

  const [kind, value, qualifier] = period.split(':');
  const number = Number(value);

  if (kind === 'days') return texts.labelDays(number);
  if (kind === 'month') return texts.labelMonths[number - 1] ?? texts.labelMonth;

  const weekdays = qualifier === 'next' ? texts.labelNextWeekdays : texts.labelWeekdays;
  return weekdays[number] ?? texts.labelWeek;
}

/** Отрезок вопроса «что я сделала»: отрезки времени плюс «сегодня» и «вчера». */
export type DonePeriod = 'today' | 'yesterday' | AskedPeriod;

/**
 * Окно «что я сделала за …» — назад от сегодня (21.09.2026).
 *
 * У `periodWindow` окна смотрят вперёд: «на неделе» — семь дней от
 * сегодня. Сделанное лежит в прошлом: «за неделю» — семь дней по
 * сегодня включительно, «за месяц» — тридцать, «в августе» — прошедший
 * август (текущий месяц — с его начала по сегодня), «во вторник» —
 * последний вторник. Рамки только про будущее («завтра», «на следующей
 * неделе») сделанному не подходят и читаются как неделя.
 */
export function doneWindow(
  period: DonePeriod,
  context: { readonly now: Date; readonly timeZone: string },
): { readonly from: Date; readonly to: Date } {
  const { now, timeZone } = context;
  const todayStart = startOfDayInZone(localDateParts(now, timeZone), timeZone);
  const after = (days: number): Date => startOfDayAfter(now, days, timeZone);
  const lastDays = (count: number): { from: Date; to: Date } => ({
    from: after(1 - count),
    to: after(1),
  });

  if (period === 'today') return lastDays(1);
  if (period === 'yesterday') return { from: after(-1), to: todayStart };
  if (period === 'month') return lastDays(30);

  if (period === 'weekend') {
    // Последние суббота и воскресенье; в выходные — эти, по сегодня.
    const weekday = localWeekday(now, timeZone);
    const sinceSaturday = weekday === 0 ? 1 : weekday === 6 ? 0 : weekday + 1;
    const from = after(-sinceSaturday);
    const to = weekday === 0 || weekday === 6 ? after(1) : after(-sinceSaturday + 2);
    return { from, to };
  }

  const [kind, value] = period.split(':');
  const number = Number(value);

  if (kind === 'days') return lastDays(number);

  if (kind === 'month') {
    const parts = localDateParts(now, timeZone);
    const year = number <= parts.month ? parts.year : parts.year - 1;
    const start = startOfDayInZone({ year, month: number, day: 1 }, timeZone);
    const end =
      number === 12
        ? startOfDayInZone({ year: year + 1, month: 1, day: 1 }, timeZone)
        : startOfDayInZone({ year, month: number + 1, day: 1 }, timeZone);
    return { from: start, to: end.getTime() > after(1).getTime() ? after(1) : end };
  }

  if (kind === 'weekday') {
    const weekday = localWeekday(now, timeZone);
    const back = (weekday - number + 7) % 7;
    return { from: after(-back), to: after(-back + 1) };
  }

  // 'week', 'tomorrow', 'afterTomorrow', 'nextWeek' — семь дней по сегодня.
  return lastDays(7);
}
