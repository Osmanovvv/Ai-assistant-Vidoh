import { localDateParts, startOfDayInZone } from './dates.js';
import { namesDay, ownSentences, type SentenceDay } from './own-sentence.js';

/**
 * Названное время уже прошло — срок не сегодня (проджект, бой 21.09.2026).
 *
 * Выгрузка Никиты в 15:01 по Омску: «…мне сегодня надо будет сходить к
 * стоматологу в 13 0 0. В 9 0 0 мне надо отнести компьютер на чистку…».
 * Компьютер получил срок «сегодня», и проджект спросил: «как он на 9:00
 * записал на сегодня, если уже это время прошло???».
 *
 * Модель не знает, который час: в промпте только дата — минуты в нём
 * давали разный разбор одного и того же текста (см. память «Минуты в
 * промпте»). Значит это работа кода, как и день недели: время названо,
 * оно позади, своего дня у дела нет — ближайшее такое время завтра.
 * Сказанное «сегодня» решает иначе: стоматолог «сегодня в 13:00»
 * остаётся на сегодня, человек так сказал.
 *
 * Условия все проверяемые: в словах дела есть час (закрытые формы
 * ниже); в них нет ни одного обозначения дня; в своих предложениях речи
 * нет «сегодня»; **все** названные часы уже позади по часам человека.
 * Иначе правило молчит, и решает модель.
 *
 * Час читается только там, где число — час, а не дата и не количество:
 * «13:00», «9.30», «9 0 0» (так расшифровка пишет «девять ноль ноль»),
 * «6 вечера», «15 часов», «в 15», «с 9 до 10». **Голое «в 9» — два
 * чтения**, 9:00 и 21:00 (решение Никиты 21.09.2026): утро это или
 * вечер, из текста не видно, и угадывать нельзя. Оба чтения возвращаются,
 * а переносится дело только когда прошли оба: «в 9» в 15:01 остаётся
 * как есть — перенос отнял бы у человека вечернее дело, — а в 22:30 это
 * завтра, и ошибиться тут уже нельзя.
 */

const MINUTES_IN_HOUR = 60;
const HOURS_IN_DAY = 24;
const NOON = 12;

/**
 * Одно названное время — в минутах от полуночи, по чтениям: у «13:00»
 * чтение одно, у голого «в 9» — два. Прошедшим время считается, когда
 * прошли все его чтения.
 */
export type ClockTime = readonly number[];

/** Часть суток после числа: «6 вечера», «9 утра». */
const DAYPART = /(?<!\d)(\d{1,2})\s*(?:час(?:ов|а)?\s*)?(утра|дня|вечера|ночи)(?!\p{L})/gu;
/** «13:00», «9.30». Точка — только с минутами, непохожими на месяц: «21.09» — дата. */
const COLON = /(?<!\d)(\d{1,2}):(\d{2})(?!\d)/gu;
const DOT = /(?<!\d)(\d{1,2})\.(\d{2})(?!\d)/gu;
/** Расшифровка: «в 13 0 0», «в 9 30» — после предлога. */
const SPOKEN = /(?<!\p{L})(?:в|к|до|около|после)\s+(\d{1,2})\s+(0\s+0|\d{2})(?!\d)/gu;
/** «в 15 часов», «в 15», «в 9» — час без минут, после предлога времени. */
const BARE = /(?<!\p{L})(?:в|к|до|около|после)\s+(\d{1,2})(?:\s+час(?:ов|а)?)?(?![\d:.]|\s+\d)/gu;
/** «с 9 до 10» — промежуток: оба числа часы. */
const RANGE = /(?<!\p{L})с\s+(\d{1,2})\s+до\s+(\d{1,2})(?![\d:.]|\s+\d)/gu;

/** Предлог времени перед числом: «в 3 дня», «до 5 дня». */
const TIME_PREPOSITION = /(?:^|[^\p{L}])(?:в|к|до|около|после)\s+$/u;

/**
 * Число перед этими словами — не час: «15 сентября», «15 числу», «20
 * лет», «3 магазина», «2 места», «5 раз». Список закрытый: голое «в N»
 * читается часом, и без него «зайти в 3 магазина» стало бы временем.
 */
const NOT_AN_HOUR =
  /^\s*(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр|числ|лет|год|минут|секунд|тысяч|штук|рубл|процент|км|кг|метр|раз|мест|магазин|человек|дет|литр|кило|грамм|стакан|таблет|порци|шаг|этаж|класс|курс|груп|част|комнат|коробк|пакет|точк|подход|захода|заход)/u;

function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/gu, 'е');
}

function minutesOf(hour: number, minute: number): number | undefined {
  if (hour >= HOURS_IN_DAY || minute >= MINUTES_IN_HOUR) return undefined;
  return hour * MINUTES_IN_HOUR + minute;
}

/** Одно чтение — или ни одного. */
function single(minutes: number | undefined): ClockTime | undefined {
  return minutes === undefined ? undefined : [minutes];
}

function withDaypart(hour: number, daypart: string): ClockTime | undefined {
  if (hour > NOON) return undefined;
  if (daypart === 'утра') return hour === NOON ? undefined : single(minutesOf(hour, 0));
  if (daypart === 'ночи') return single(minutesOf(hour === NOON ? 0 : hour, 0));
  // «дня» и «вечера»: «12 дня» — полдень, «6 вечера» — 18.
  return single(minutesOf(hour === NOON ? NOON : hour + NOON, 0));
}

/**
 * Час без минут и без части суток: с 13 по 23 и полдень — одно чтение,
 * с 1 по 11 — два, утро и вечер.
 */
function bareHour(hour: number): ClockTime | undefined {
  if (hour === 0 || hour >= HOURS_IN_DAY) return undefined;
  if (hour >= NOON) return single(minutesOf(hour, 0));
  return [hour * MINUTES_IN_HOUR, (hour + NOON) * MINUTES_IN_HOUR];
}

/** Где в совпадении стоит число: по нему совпадения разных форм сверяются между собой. */
function numberAt(match: RegExpExecArray, group: number): number {
  const digits = match[group] ?? '';
  return match.index + match[0].indexOf(digits);
}

/** Часы, названные в тексте, по чтениям; порядок — по тексту. */
export function clockTimesIn(text: string): readonly ClockTime[] {
  const normalized = normalize(text);
  const found: { at: number; time: ClockTime }[] = [];
  // Одно число — одно время: форма, узнавшая его первой, и решает.
  const add = (at: number, time: ClockTime | undefined): void => {
    if (time !== undefined && !found.some((one) => one.at === at)) found.push({ at, time });
  };

  for (const match of normalized.matchAll(DAYPART)) {
    // «На 3 дня», «через 2 дня» — дни, а не «3 часа дня»: «дня» читается
    // часом только после предлога времени.
    const before = normalized.slice(0, match.index);
    if (match[2] === 'дня' && !TIME_PREPOSITION.test(before)) continue;
    add(numberAt(match, 1), withDaypart(Number(match[1]), match[2] ?? ''));
  }
  for (const match of normalized.matchAll(COLON)) {
    add(numberAt(match, 1), single(minutesOf(Number(match[1]), Number(match[2]))));
  }
  for (const match of normalized.matchAll(DOT)) {
    const minute = Number(match[2]);
    // «21.09» — дата: минуты от 01 до 12 читаются как месяц.
    if (minute === 0 || minute > NOON) {
      add(numberAt(match, 1), single(minutesOf(Number(match[1]), minute)));
    }
  }
  for (const match of normalized.matchAll(SPOKEN)) {
    const minute = (match[2] ?? '').replace(/\s+/gu, '');
    add(numberAt(match, 1), single(minutesOf(Number(match[1]), Number(minute))));
  }
  for (const match of normalized.matchAll(RANGE)) {
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (from < to) {
      add(numberAt(match, 1), bareHour(from));
      add(numberAt(match, 2), bareHour(to));
    }
  }
  for (const match of normalized.matchAll(BARE)) {
    const rest = normalized.slice(match.index + match[0].length);
    if (NOT_AN_HOUR.test(rest)) continue;
    add(numberAt(match, 1), bareHour(Number(match[1])));
  }

  return found.sort((left, right) => left.at - right.at).map((one) => one.time);
}

/** Минуты от полуночи по часам человека. */
function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const value = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  return value('hour') * MINUTES_IN_HOUR + value('minute');
}

const TODAY = /(?<!\p{L})сегодня(?!\p{L})/u;

export function dayAfterPassedClock(params: {
  readonly itemText: string;
  readonly spoken: string;
  readonly now: Date;
  readonly timeZone: string;
}): SentenceDay | undefined {
  if (namesDay(params.itemText)) return undefined;

  const sentences = ownSentences(params.itemText, params.spoken);
  if (sentences.some((sentence) => TODAY.test(normalize(sentence)))) return undefined;

  let times = clockTimesIn(params.itemText);
  // Час остался только в речи — берётся из своего предложения, если оно одно.
  if (times.length === 0 && sentences.length === 1) times = clockTimesIn(sentences[0] ?? '');
  if (times.length === 0) return undefined;

  // Прошли все времена во всех чтениях — иначе ошибиться можно, и правило молчит.
  const latest = Math.max(...times.flat());
  if (localMinutes(params.now, params.timeZone) <= latest) return undefined;

  const today = startOfDayInZone(localDateParts(params.now, params.timeZone), params.timeZone);
  const tomorrow = new Date(today.getTime() + HOURS_IN_DAY * MINUTES_IN_HOUR * 60_000);

  return {
    at: startOfDayInZone(localDateParts(tomorrow, params.timeZone), params.timeZone),
    accuracy: 'day',
  };
}
