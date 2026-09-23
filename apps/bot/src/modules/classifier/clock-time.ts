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
const SPOKEN = /(?<!\p{L})(?:в|на|к|до|около|после)\s+(\d{1,2})\s+(0\s+0|\d{2})(?!\d)/gu;
/** «в 15 часов», «в 15», «в 9» — час без минут, после предлога времени. */
const BARE = /(?<!\p{L})(?:в|к|до|около|после)\s+(\d{1,2})(?:\s+час(?:ов|а)?)?(?![\d:.]|\s+\d)/gu;
/**
 * «На 12 часов», «на 15 часов» — час после «на» (живой прогон Никиты
 * 23.09.2026: «перенеси посылку на завтра на 12 часов» час не читался).
 * Только со словом «часов»: голое «перенеси на 12» — это ещё и
 * двенадцатое число, и угадывать нельзя.
 */
const AFTER_NA =
  /(?<!\p{L})на\s+(\d{1,2})(?![\d:.])\s+час(?:ов|а)?(?!\p{L})(?!\s+\d|\s+(?:позже|раньше|вперед|вперёд|назад))/gu;
/** «В полдень», «на полдень» — 12:00, одно чтение. */
const NOON_WORD = /(?<!\p{L})полдень(?!\p{L})/gu;
/** «В полночь» — 00:00, одно чтение (23.09.2026). */
const MIDNIGHT_WORD = /(?<!\p{L})полночь(?!\p{L})/gu;
/** «с 9 до 10» — промежуток: оба числа часы. */
const RANGE = /(?<!\p{L})с\s+(\d{1,2})\s+до\s+(\d{1,2})(?![\d:.]|\s+\d)/gu;

/** Предлог времени перед числом: «в 3 дня», «до 5 дня». */
/**
 * Разговорные формы часа (22.09.2026, по слову Никиты): «в половине
 * десятого», «в пол шестого», «без пятнадцати семь», «без двадцати
 * восемь». Вслух так говорят чаще, чем «в 21:30».
 *
 * Половина и «без стольких-то» — всегда про **следующий** час:
 * «половина десятого» — 9:30, «без пятнадцати семь» — 6:45. Утро это
 * или вечер, из слов не видно — как у голого «в 9», поэтому чтений два.
 */
const ORDINALS: readonly (readonly [RegExp, number])[] = [
  [/^перв/u, 1],
  [/^втор/u, 2],
  [/^трет/u, 3],
  [/^четв[её]рт/u, 4],
  [/^пят/u, 5],
  [/^шест/u, 6],
  [/^седьм/u, 7],
  [/^восьм/u, 8],
  [/^девят/u, 9],
  [/^десят/u, 10],
  [/^одиннадцат/u, 11],
  [/^двенадцат/u, 12],
];

const CARDINALS: readonly (readonly [RegExp, number])[] = [
  [/^час(?!ов|а)/u, 1],
  [/^дв[ае](?!надцат)|^двух/u, 2],
  [/^три|^тр[её]х/u, 3],
  [/^четыр/u, 4],
  [/^пят[ьи]/u, 5],
  [/^шест[ьи]/u, 6],
  [/^сем[ьи]/u, 7],
  [/^восем|^восьм/u, 8],
  [/^девят[ьи]/u, 9],
  [/^десят[ьи]/u, 10],
  [/^одиннадцат/u, 11],
  [/^двенадцат/u, 12],
];

const MINUTE_WORDS: readonly (readonly [RegExp, number])[] = [
  [/^пят(?:ь|и)(?!надцат|десят)/u, 5],
  [/^десят/u, 10],
  [/^пятнадцат|^четверт/u, 15],
  [/^двадцат(?:ь|и)(?!\s*пят)/u, 20],
  [/^двадцат(?:ь|и)\s*пят/u, 25],
];

// Длинные формы первыми: иначе «пол» съедает начало «половине».
const HALF = /(?<!\p{L})(?:в\s+)?(?:половин[аеу]|пол)\s*(\p{L}+|\d{1,2})/giu;
// До трёх слов: «без пятнадцати семь», «без двадцати пяти восемь».
// Минуты цифрой («без 15 6» — так пишет распознавание) и «минут» после
// них («без 15 минут 6») — живой прогон Никиты 23.09.2026.
const WITHOUT =
  /(?<!\p{L})без\s+(\p{L}+|\d{1,2})(?:\s+минут\p{L}*)?\s+(\p{L}+|\d{1,2})(?:\s+(\p{L}+))?/giu;
/** «Четверть седьмого», «в четверть 7» — 6:15. */
const QUARTER = /(?<!\p{L})(?:в\s+)?четверть\s+(\p{L}+|\d{1,2})/giu;
/** «15 минут седьмого», «пять минут десятого» — минуты следующего часа. */
const MINUTES_OF = /(?<!\p{L})(?:в\s+)?(\d{1,2}|\p{L}+)\s+минут\p{L}*\s+(\p{L}+)/giu;
/** «В 6 часов 15 минут» — часы и минуты словами «часов … минут». */
const HOURS_MINUTES =
  /(?<!\p{L})(?:в|на|к|до|около|после)\s+(\d{1,2})\s+час\p{L}*\s+(\d{1,2})\s+минут\p{L}*/giu;
/** «В пять вечера», «к шести», «в час дня» — час словом. */
const WORD_HOUR =
  /(?<!\p{L})(в|к|до|около|после|на)\s+(\p{L}+)(\s+час(?:ов|а)?)?(?:\s+(утра|дня|вечера|ночи))?(?!\p{L})/giu;

/**
 * Число словом или цифрой: «в половине десятого» и «в пол 11» — одно и
 * то же (живой прогон 22.09.2026: цифру правило не понимало).
 */
function valueOf(word: string, table: readonly (readonly [RegExp, number])[]): number | undefined {
  const digits = /^\d{1,2}$/u.exec(word.trim());
  if (digits !== null) {
    const value = Number(digits[0]);
    return value >= 1 && value <= HOURS_IN_DAY ? value : undefined;
  }

  const normalized = word.toLowerCase().replace(/ё/gu, 'е');
  return table.find(([pattern]) => pattern.test(normalized))?.[1];
}

/** Минуты: цифрой — от 1 до 59, словом — из закрытого списка. */
function minuteValue(word: string): number | undefined {
  const digits = /^\d{1,2}$/u.exec(word.trim());
  if (digits !== null) {
    const value = Number(digits[0]);
    return value >= 1 && value < MINUTES_IN_HOUR ? value : undefined;
  }
  return valueOf(word, MINUTE_WORDS);
}

/** Час по названному следующему: «половина десятого» — девятый час. */
function previousHour(next: number): number {
  return next === 1 ? 0 : next - 1;
}

const TIME_PREPOSITION = /(?:^|[^\p{L}])(?:в|к|до|около|после)\s+$/u;

/**
 * Число перед этими словами — не час: «15 сентября», «15 числу», «20
 * лет», «3 магазина», «2 места», «5 раз». Список закрытый: голое «в N»
 * читается часом, и без него «зайти в 3 магазина» стало бы временем.
 */
const NOT_AN_HOUR =
  /^\s*(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр|числ|лет|год|минут|секунд|тысяч|штук|рубл|процент|км|кг|метр|раз|мест|магазин|человек|дет|литр|кило|грамм|стакан|таблет|порци|шаг|этаж|класс|курс|груп|част|комнат|коробк|пакет|точк|подход|захода|заход|недел|месяц|сут)/u;

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

/**
 * Разговорные формы: «в половине десятого» (9:30), «в пол шестого»
 * (17:30 или 5:30), «без пятнадцати семь» (6:45). Часть суток рядом
 * снимает двусмысленность — её ловит общий разбор ниже.
 */
interface SpokenClock {
  /** Где стоит число: по нему совпадения разных форм сверяются. */
  readonly at: number;
  /** Вся фраза — от предлога до части суток: её срезает заголовок. */
  readonly start: number;
  readonly end: number;
  readonly time: ClockTime;
}

function spokenClockTimes(normalized: string): SpokenClock[] {
  const found: SpokenClock[] = [];

  for (const match of normalized.matchAll(HALF)) {
    const next = valueOf(match[1] ?? '', ORDINALS);
    if (next === undefined) continue;
    const hour = previousHour(next);
    const end = match.index + match[0].length;
    const daypart = daypartAfter(normalized, end);
    found.push({
      at: match.index + match[0].indexOf(match[1] ?? ''),
      start: match.index,
      end: end + daypartLength(normalized, end),
      time: readingsOf(hour, MINUTES_IN_HOUR / 2, daypart),
    });
  }

  for (const match of normalized.matchAll(WITHOUT)) {
    const [first, second, third] = [match[1] ?? '', match[2] ?? '', match[3] ?? ''];

    // «без пятнадцати семь» — минуты одним словом; «без двадцати пяти
    // восемь» — двумя. Пробуем короткое чтение, потом длинное.
    let minutes = minuteValue(first);
    let hourWord = second;
    if (minutes === undefined || valueOf(hourWord, CARDINALS) === undefined) {
      minutes = valueOf(`${first} ${second}`, MINUTE_WORDS);
      hourWord = third;
    }
    const next = valueOf(hourWord, CARDINALS);
    if (minutes === undefined || next === undefined) continue;

    const at = normalized.indexOf(hourWord, match.index);
    const after = at + hourWord.length;
    const daypart = daypartAfter(normalized, after);
    found.push({
      at,
      start: match.index,
      end: after + daypartLength(normalized, after),
      time: readingsOf(previousHour(next), MINUTES_IN_HOUR - minutes, daypart),
    });
  }

  // «Четверть седьмого» — 6:15.
  for (const match of normalized.matchAll(QUARTER)) {
    const next = valueOf(match[1] ?? '', ORDINALS);
    if (next === undefined) continue;
    const end = match.index + match[0].length;
    found.push({
      at: match.index + match[0].lastIndexOf(match[1] ?? ''),
      start: match.index,
      end: end + daypartLength(normalized, end),
      time: readingsOf(previousHour(next), MINUTES_IN_HOUR / 4, daypartAfter(normalized, end)),
    });
  }

  // «15 минут седьмого» — 6:15; час обязан быть порядковым: «15 минут
  // назад» — не время.
  for (const match of normalized.matchAll(MINUTES_OF)) {
    const minutes = minuteValue(match[1] ?? '');
    const hourWord = match[2] ?? '';
    const next = /^\d/u.test(hourWord) ? undefined : valueOf(hourWord, ORDINALS);
    if (minutes === undefined || next === undefined) continue;
    const end = match.index + match[0].length;
    found.push({
      at: match.index + match[0].lastIndexOf(hourWord),
      start: match.index,
      end: end + daypartLength(normalized, end),
      time: readingsOf(previousHour(next), minutes, daypartAfter(normalized, end)),
    });
  }

  // «В 6 часов 15 минут» — одно чтение, как «в 6 15».
  for (const match of normalized.matchAll(HOURS_MINUTES)) {
    const time = single(minutesOf(Number(match[1]), Number(match[2])));
    if (time === undefined) continue;
    found.push({
      at: match.index + match[0].indexOf(match[1] ?? ''),
      start: match.index,
      end: match.index + match[0].length,
      time,
    });
  }

  /**
   * Час словом: «в пять вечера», «к шести», «в час дня». После «на» —
   * только с «часов»: «на два дня» — это дни, «на пять человек» — люди.
   * Дальше те же запреты, что у цифры: «в два раза», «до двух недель».
   */
  for (const match of normalized.matchAll(WORD_HOUR)) {
    const [, preposition, word, hoursWord, daypart] = match;
    const hour = valueOf(word ?? '', CARDINALS);
    if (hour === undefined || /^\d/u.test(word ?? '')) continue;
    if (preposition === 'на' && hoursWord === undefined) continue;
    const end = match.index + match[0].length;
    if (daypart === undefined && NOT_AN_HOUR.test(normalized.slice(end))) continue;
    const time = daypart === undefined ? bareHour(hour) : withDaypart(hour, daypart);
    if (time === undefined) continue;
    found.push({
      at: match.index + match[0].indexOf(word ?? ''),
      start: match.index,
      end,
      time,
    });
  }

  return found;
}

/** Часть суток сразу за формой: «в половине десятого вечера». */
function daypartAfter(normalized: string, from: number): string | undefined {
  return /^\s*(утра|дня|вечера|ночи)(?!\p{L})/u.exec(normalized.slice(from))?.[1];
}

/** Сколько знаков занимает часть суток за формой — чтобы срезать её вместе с часом. */
function daypartLength(normalized: string, from: number): number {
  return /^\s*(?:утра|дня|вечера|ночи)(?!\p{L})/u.exec(normalized.slice(from))?.[0].length ?? 0;
}

/**
 * Чтения часа с минутами: без части суток их два (утро и вечер), как у
 * голого «в 9»; с частью суток — одно.
 */
function readingsOf(hour: number, minute: number, daypart: string | undefined): ClockTime {
  const morning = minutesOf(hour, minute);
  const evening = minutesOf((hour + NOON) % HOURS_IN_DAY, minute);
  if (morning === undefined || evening === undefined) return [];

  if (daypart === 'утра' || daypart === 'ночи') return [morning];
  if (daypart === 'дня' || daypart === 'вечера') return [hour >= NOON ? morning : evening];

  return [morning, evening];
}

/** Часы, названные в тексте, по чтениям; порядок — по тексту. */
export function clockTimesIn(text: string): readonly ClockTime[] {
  const normalized = normalize(text);
  const found: { at: number; time: ClockTime }[] = [];
  // Одно число — одно время: форма, узнавшая его первой, и решает.
  const add = (at: number, time: ClockTime | undefined): void => {
    if (time !== undefined && !found.some((one) => one.at === at)) found.push({ at, time });
  };

  /**
   * Разговорные формы — первыми (живой прогон 22.09.2026): иначе «в пол
   * 11 вечера» достаётся разбору «11 вечера» и читается как 23:00.
   * Одно число — одно время, и решает форма, узнавшая его первой.
   */
  for (const spoken of spokenClockTimes(normalized)) add(spoken.at, spoken.time);

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
  for (const match of normalized.matchAll(AFTER_NA)) {
    add(numberAt(match, 1), bareHour(Number(match[1])));
  }
  for (const match of normalized.matchAll(NOON_WORD)) {
    add(match.index, single(NOON * MINUTES_IN_HOUR));
  }
  for (const match of normalized.matchAll(MIDNIGHT_WORD)) {
    add(match.index, single(0));
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

/**
 * Фраза о часе во всём тексте — где она стоит (бой 22.09.2026).
 *
 * Нужна, чтобы срезать час из заголовка, когда он стал сроком: «Позвонить
 * сестре в 3:10 сегодня» уходило в список как есть, а рядом стоял «Срок:
 * 03:10». Те же формы, что читает `clockTimesIn`, и те же исключения
 * («в 3 магазина» — не час); предлог перед числом входит в фразу.
 */
function clockPhraseSpan(
  text: string,
): { readonly start: number; readonly end: number } | undefined {
  const normalized = normalize(text);
  let best: { start: number; end: number } | undefined;
  const offer = (match: RegExpExecArray, time: ClockTime | undefined): void => {
    if (time === undefined) return;
    const start = match.index;
    const end = match.index + match[0].length;
    if (best === undefined || start < best.start) best = { start, end };
  };

  /**
   * Разговорные формы — первыми и целиком (живой прогон 22.09.2026):
   * «в пол 11 вечера забрать посылку» иначе теряло только «11 вечера»
   * и оставляло «В пол забрать посылку».
   */
  for (const spoken of spokenClockTimes(normalized)) {
    if (best === undefined || spoken.start < best.start) {
      best = { start: spoken.start, end: spoken.end };
    }
  }

  for (const match of normalized.matchAll(DAYPART)) {
    const before = normalized.slice(0, match.index);
    if (match[2] === 'дня' && !TIME_PREPOSITION.test(before)) continue;
    offer(match, withDaypart(Number(match[1]), match[2] ?? ''));
  }
  for (const match of normalized.matchAll(COLON)) {
    offer(match, single(minutesOf(Number(match[1]), Number(match[2]))));
  }
  for (const match of normalized.matchAll(DOT)) {
    const minute = Number(match[2]);
    if (minute === 0 || minute > NOON) offer(match, single(minutesOf(Number(match[1]), minute)));
  }
  for (const match of normalized.matchAll(SPOKEN)) {
    const minute = (match[2] ?? '').replace(/\s+/gu, '');
    offer(match, single(minutesOf(Number(match[1]), Number(minute))));
  }
  for (const match of normalized.matchAll(AFTER_NA)) {
    offer(match, bareHour(Number(match[1])));
  }
  for (const match of normalized.matchAll(NOON_WORD)) {
    offer(match, single(NOON * MINUTES_IN_HOUR));
  }
  for (const match of normalized.matchAll(MIDNIGHT_WORD)) {
    offer(match, single(0));
  }
  // «Через полчаса» стало часом дела — в заголовке ему делать нечего.
  for (const match of normalized.matchAll(new RegExp(FROM_NOW.source, 'gu'))) {
    offer(match, single(0));
  }
  for (const match of normalized.matchAll(RANGE)) {
    if (Number(match[1]) < Number(match[2])) offer(match, bareHour(Number(match[1])));
  }
  for (const match of normalized.matchAll(BARE)) {
    const rest = normalized.slice(match.index + match[0].length);
    if (NOT_AN_HOUR.test(rest)) continue;
    offer(match, bareHour(Number(match[1])));
  }
  if (best === undefined) return undefined;

  // Предлог, запятая и слово о дне перед часом — часть фразы: день и час
  // уже в сроке, в заголовке им делать нечего («сегодня без четверти 11»).
  // «Часов» и часть суток после — тоже.
  const head = normalized.slice(0, best.start);
  const lead =
    /(?:(?<!\p{L})(?:сегодня|завтра|послезавтра)\s+)?(?:,\s*)?(?:(?<!\p{L})(?:в|на|к|до|около|после)\s+)?$/u.exec(
      head,
    );
  const start = lead === null ? best.start : best.start - lead[0].length;
  const tail = /^(?:\s+час(?:ов|а)?)?(?:\s+(?:утра|дня|вечера|ночи))?/u.exec(
    normalized.slice(best.end),
  );
  const end = best.end + (tail?.[0].length ?? 0);
  return { start, end };
}

/** Текст без первой фразы о часе; нет её — как есть. */
export function withoutClockPhrase(text: string): string {
  const span = clockPhraseSpan(text);
  if (span === undefined) return text;

  const cut = `${text.slice(0, span.start)} ${text.slice(span.end)}`
    .replace(/\s+/gu, ' ')
    .replace(/\s+,/gu, ',')
    .replace(/^[\s,]+|[\s,]+$/gu, '');
  return cut;
}

/**
 * Час дела — для напоминания в указанный час (ТЗ проджекта 17.09.2026,
 * шаг 5).
 *
 * Первый однозначный час из слов дела; их нет — из своего предложения
 * речи, если оно одно (извлечение переписало «в 9 0 0 отнести компьютер»
 * в «Отнести компьютер»). Двусмысленный час — голое «в 9» — не берётся:
 * напоминание в 08:30 про вечернее дело хуже отсутствия напоминания. У
 * промежутка берётся начало.
 */
export function clockTimeOf(
  itemText: string,
  spoken: string,
  /** Слова соседних записей: предложение, которого касается сосед, — не только моё. */
  siblings: readonly string[] = [],
): number | undefined {
  const own = clockTimesIn(itemText);
  const sentences = ownSentences(itemText, spoken);
  const sentence = sentences[0];
  // Час из предложения — только когда оно принадлежит одному этому делу:
  // «к стоматологу в 13:00 и погулять с собакой» — час стоматолога.
  const shared =
    sentence !== undefined &&
    siblings.some((other) => ownSentences(other, spoken).includes(sentence));
  const times =
    own.length > 0 ? own : sentences.length === 1 && !shared ? clockTimesIn(sentence ?? '') : [];
  const first = times[0];

  return first?.length === 1 ? first[0] : undefined;
}

/** Минуты от полуночи по часам человека. */
export function localMinutes(now: Date, timeZone: string): number {
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

/**
 * Час без дня (решение Никиты 23.09.2026): в словах есть час и нет ни
 * одного дня — ни словом (`namesDay`), ни числом вне часа.
 *
 * Такому сроку от модели верить нельзя: он не сказан. На бою модель
 * дважды подставила свой день — «на пол 1» стало первым октября (число
 * из часа), «на пол 3» — сегодняшним днём, и посылка уехала с 24.09 на
 * 23.09. Правило Никиты: час без дня меняет только час.
 */
export function hourWithoutDay(spoken: string): boolean {
  const rest = withoutClockPhrase(spoken);
  if (rest === spoken) return false;
  if (/\d/u.test(rest)) return false;
  return !namesDay(spoken);
}

/**
 * Сдвиг и «через» (живой прогон Никиты 23.09.2026): «на час позже»,
 * «на полчаса раньше», «через 45 минут». Это не час на циферблате, а
 * отрезок времени: от часа дела — сдвиг, от «сейчас» — «через».
 *
 * Отрезок — только с единицей: «на час позже» — сдвиг, а «на час» без
 * «позже» — ещё и «к часу дня», угадывать нельзя.
 */
const SPAN_WORDS: Readonly<Record<string, number>> = {
  один: 1,
  одну: 1,
  два: 2,
  две: 2,
  три: 3,
  четыре: 4,
  пять: 5,
  десять: 10,
  пятнадцать: 15,
  двадцать: 20,
  тридцать: 30,
  сорок: 40,
};

const SPAN =
  String.raw`(полчаса|пол\s+часа|полтора\s+часа|час|(\d{1,3}|` +
  Object.keys(SPAN_WORDS).join('|') +
  String.raw`)(?:\s+(\d{1,2}|пять))?\s+(час|часа|часов|минут|минуты|минуту))`;

/** Длина отрезка в минутах по его словам. */
function spanMinutes(match: RegExpExecArray, at: number): number | undefined {
  const whole = (match[at] ?? '').replace(/\s+/gu, ' ');
  if (whole === 'полчаса' || whole === 'пол часа') return 30;
  if (whole === 'полтора часа') return 90;
  if (whole === 'час') return 60;

  const countWord = match[at + 1] ?? '';
  const count = /^\d/u.test(countWord) ? Number(countWord) : SPAN_WORDS[countWord];
  if (count === undefined) return undefined;
  const extra =
    match[at + 2] === undefined ? 0 : match[at + 2] === 'пять' ? 5 : Number(match[at + 2]);
  const unit = match[at + 3] ?? '';
  return unit.startsWith('час') ? count * MINUTES_IN_HOUR : count + extra;
}

const SHIFT_AFTER = new RegExp(
  String.raw`(?<!\p{L})на\s+` + SPAN + String.raw`\s+(позже|раньше|вперед|вперёд|назад)(?!\p{L})`,
  'u',
);
const SHIFT_BEFORE = new RegExp(
  String.raw`(?<!\p{L})(позже|раньше)\s+на\s+` + SPAN + String.raw`(?!\p{L})`,
  'u',
);
const FROM_NOW = new RegExp(String.raw`(?<!\p{L})через\s+` + SPAN + String.raw`(?!\p{L})`, 'u');

/** Сдвиг от часа дела в минутах: «на час позже» — 60, «на полчаса раньше» — −30. */
export function timeShiftIn(text: string): number | undefined {
  const normalized = normalize(text);

  const after = SHIFT_AFTER.exec(normalized);
  if (after !== null) {
    const minutes = spanMinutes(after, 1);
    const direction = after[5] ?? '';
    if (minutes === undefined) return undefined;
    return direction === 'раньше' || direction === 'назад' ? -minutes : minutes;
  }

  const before = SHIFT_BEFORE.exec(normalized);
  if (before !== null) {
    const minutes = spanMinutes(before, 2);
    if (minutes === undefined) return undefined;
    return before[1] === 'раньше' ? -minutes : minutes;
  }

  return undefined;
}

/** «Через» от сейчас в минутах: «через час» — 60, «через 45 минут» — 45. */
export function fromNowIn(text: string): number | undefined {
  const match = FROM_NOW.exec(normalize(text));
  return match === null ? undefined : spanMinutes(match, 1);
}

/**
 * Сдвиг или «через» без слова о дне: «на час позже», «через полчаса».
 * Дата от модели при этом не сказана — как у часа без дня (решение Никиты
 * 23.09.2026): день считает код, от часа дела или от «сейчас».
 */
export function relativeWithoutDay(spoken: string): boolean {
  const relative = timeShiftIn(spoken) !== undefined || fromNowIn(spoken) !== undefined;
  return relative && !namesDay(spoken);
}

/**
 * «Через» у нового дела — из его слов или своего предложения речи, по тому
 * же правилу, что час (`clockTimeOf`): «через полчаса позвонить маме» —
 * звонку, а не соседу из общей фразы (23.09.2026).
 */
export function fromNowOf(
  itemText: string,
  spoken: string,
  siblings: readonly string[] = [],
): number | undefined {
  const own = fromNowIn(itemText);
  if (own !== undefined) return own;

  const sentences = ownSentences(itemText, spoken);
  const sentence = sentences[0];
  const shared =
    sentence !== undefined &&
    siblings.some((other) => ownSentences(other, spoken).includes(sentence));

  return sentences.length === 1 && !shared ? fromNowIn(sentence ?? '') : undefined;
}
