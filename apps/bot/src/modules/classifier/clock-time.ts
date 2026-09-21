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
 * нет «сегодня»; самый поздний из названных часов уже позади по часам
 * человека. Иначе правило молчит, и решает модель.
 *
 * Часы читаются только в формах, где число — точно час, а не дата и не
 * количество: «13:00», «9.30», «9 0 0» (так расшифровка пишет «девять
 * ноль ноль»), «6 вечера», «15 часов», «в 15», «с 9 до 10». Голое «в 9»
 * — не час: утро это или вечер, отсюда не видно.
 */

const MINUTES_IN_HOUR = 60;
const HOURS_IN_DAY = 24;
const NOON = 12;

/** Часть суток после числа: «6 вечера», «9 утра». */
const DAYPART = /(?<!\d)(\d{1,2})\s*(?:час(?:ов|а)?\s*)?(утра|дня|вечера|ночи)(?!\p{L})/gu;
/** «13:00», «9.30». Точка — только с минутами, непохожими на месяц: «21.09» — дата. */
const COLON = /(?<!\d)(\d{1,2}):(\d{2})(?!\d)/gu;
const DOT = /(?<!\d)(\d{1,2})\.(\d{2})(?!\d)/gu;
/** Расшифровка: «в 13 0 0», «в 9 30» — после предлога. */
const SPOKEN = /(?<!\p{L})(?:в|к|до|около|после)\s+(\d{1,2})\s+(0\s+0|\d{2})(?!\d)/gu;
/** «в 15 часов», «в 15» — час без минут: точно час только с 13 по 23. */
const BARE = /(?<!\p{L})(?:в|к|до|около|после)\s+(\d{1,2})(?:\s+час(?:ов|а)?)?(?![\d:.]|\s+\d)/gu;
/** «с 9 до 10» — промежуток: оба числа часы. */
const RANGE = /(?<!\p{L})с\s+(\d{1,2})\s+до\s+(\d{1,2})(?![\d:.]|\s+\d)/gu;

/** Предлог времени перед числом: «в 3 дня», «до 5 дня». */
const TIME_PREPOSITION = /(?:^|[^\p{L}])(?:в|к|до|около|после)\s+$/u;

/** Число перед этими словами — не час: «15 сентября», «15 числу», «20 лет». */
const NOT_AN_HOUR =
  /^\s*(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр|числ|лет|год|минут|тысяч|штук|рубл|процент|км|кг|метр)/u;

function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/gu, 'е');
}

function minutesOf(hour: number, minute: number): number | undefined {
  if (hour >= HOURS_IN_DAY || minute >= MINUTES_IN_HOUR) return undefined;
  return hour * MINUTES_IN_HOUR + minute;
}

function withDaypart(hour: number, daypart: string): number | undefined {
  if (hour > NOON) return undefined;
  if (daypart === 'утра') return hour === NOON ? undefined : minutesOf(hour, 0);
  if (daypart === 'ночи') return minutesOf(hour === NOON ? 0 : hour, 0);
  // «дня» и «вечера»: «12 дня» — полдень, «6 вечера» — 18.
  return minutesOf(hour === NOON ? NOON : hour + NOON, 0);
}

/** Часы, названные в тексте, в минутах от полуночи; порядок — по тексту. */
export function clockTimesIn(text: string): readonly number[] {
  const normalized = normalize(text);
  const found: { at: number; minutes: number }[] = [];
  const add = (index: number, minutes: number | undefined): void => {
    if (minutes !== undefined && !found.some((one) => one.at === index)) {
      found.push({ at: index, minutes });
    }
  };

  for (const match of normalized.matchAll(DAYPART)) {
    // «На 3 дня», «через 2 дня» — дни, а не «3 часа дня»: «дня» читается
    // часом только после предлога времени.
    const before = normalized.slice(0, match.index);
    if (match[2] === 'дня' && !TIME_PREPOSITION.test(before)) continue;
    add(match.index, withDaypart(Number(match[1]), match[2] ?? ''));
  }
  for (const match of normalized.matchAll(COLON)) {
    add(match.index, minutesOf(Number(match[1]), Number(match[2])));
  }
  for (const match of normalized.matchAll(DOT)) {
    const minute = Number(match[2]);
    // «21.09» — дата: минуты от 01 до 12 читаются как месяц.
    if (minute === 0 || minute > NOON) add(match.index, minutesOf(Number(match[1]), minute));
  }
  for (const match of normalized.matchAll(SPOKEN)) {
    const minute = (match[2] ?? '').replace(/\s+/gu, '');
    add(match.index, minutesOf(Number(match[1]), Number(minute)));
  }
  for (const match of normalized.matchAll(RANGE)) {
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (from < to) {
      add(match.index, minutesOf(from, 0));
      add(match.index + 1, minutesOf(to, 0));
    }
  }
  for (const match of normalized.matchAll(BARE)) {
    const hour = Number(match[1]);
    const rest = normalized.slice(match.index + match[0].length);
    const named = match[0].includes('час');
    if (NOT_AN_HOUR.test(rest)) continue;
    if (hour > NOON || (named && hour > 0)) add(match.index, minutesOf(hour, 0));
  }

  return found.sort((left, right) => left.at - right.at).map((one) => one.minutes);
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

  const latest = Math.max(...times);
  if (localMinutes(params.now, params.timeZone) <= latest) return undefined;

  const today = startOfDayInZone(localDateParts(params.now, params.timeZone), params.timeZone);
  const tomorrow = new Date(today.getTime() + HOURS_IN_DAY * MINUTES_IN_HOUR * 60_000);

  return {
    at: startOfDayInZone(localDateParts(tomorrow, params.timeZone), params.timeZone),
    accuracy: 'day',
  };
}
