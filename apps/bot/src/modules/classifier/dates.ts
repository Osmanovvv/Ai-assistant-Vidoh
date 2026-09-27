import type { DeadlineAccuracy } from '../ai/schemas/classifier.js';
import {
  dayOfMonthIn,
  dayWordsIn,
  hasTimeWord,
  monthsIn,
  quoteClaimedBy,
  relativeDaysIn,
  timeQuoteInSpeech,
  weekdaysIn,
} from './time-words.js';

/**
 * Разрешение сроков (задача 2.7).
 *
 * «В четверг», «на следующей неделе», «через две недели» — самый частый
 * источник тихих ошибок: они не падают, они просто ставят напоминание не
 * в тот день, и человек об этом узнаёт, когда уже поздно.
 *
 * Поэтому превращать относительный срок в дату должна модель, которой
 * передали сегодняшнее число и день недели в поясе человека. Здесь —
 * то, что вокруг: как описать «сейчас» для промпта и как проверить и
 * привязать к поясу то, что модель вернула.
 *
 * Ни одной библиотеки: `Intl` знает все переходы на летнее время, и своя
 * таблица поясов была бы устаревшей копией того, что уже есть в системе.
 */

/** Разобранный срок, привязанный к поясу человека. */
export interface ResolvedDeadline {
  /** Начало названного дня в поясе человека. */
  readonly at: Date;
  readonly accuracy: Exclude<DeadlineAccuracy, 'none'>;
  /**
   * Час внутри дня — минуты от местной полуночи (ТЗ проджекта
   * 17.09.2026, шаг 5). Только у точности «день» и только когда час
   * назван однозначно (`clock-time.ts`); иначе пусто.
   */
  readonly time?: number | undefined;
}

export type DeadlineOutcome =
  | {
      readonly ok: true;
      readonly deadline: ResolvedDeadline;
      /**
       * Что пришлось поправить за моделью. Пока одно: день недели не
       * совпал с названным человеком, и дата пересчитана кодом.
       */
      readonly corrected?: 'weekday' | 'relative' | 'weekend' | 'month' | undefined;
      /**
       * День назван словами человека — в словах дела или в подтверждённой
       * цитате (заказчица, бой 21.09.2026). `false` — срок держится только
       * на словах о времени: цифрах, часах; день модель взяла из контекста,
       * и своё предложение речи вправе его перебить. Без слов человека
       * (проверка не работала) — считается названным: перебивать нечем.
       */
      readonly dayNamed?: boolean | undefined;
    }
  | { readonly ok: false; readonly reason: string }
  /** Срока просто нет — это не ошибка. */
  | { readonly ok: true; readonly deadline: undefined };

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;

/**
 * Месяц без дня — «2026-10» (бой 17.09.2026).
 *
 * Промпт просит ГГГГ-ММ-ДД и первое число для месяца, но на «в октябре»
 * модель ответила «2026-10», и запись осталась без срока: «не в виде
 * ГГГГ-ММ-ДД». Форма — не повод терять названный месяц: это первое число
 * с точностью «месяц», какую бы точность модель ни назвала.
 */
const MONTH_ONLY = /^(\d{4})-(\d{2})$/u;

/** Дальше этого срока планов не бывает: это модель ошиблась в годе. */
const MAX_YEARS_AHEAD = 5;

export interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * Смещение пояса в минутах в конкретный момент.
 *
 * Считается через сравнение того, как один и тот же момент выглядит в
 * поясе и в UTC. `hourCycle: 'h23'` обязателен: без него полночь в части
 * систем приходит как «24», и арифметика уезжает на сутки.
 */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const value = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const asIfUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );

  return (asIfUtc - instant.getTime()) / 60_000;
}

/** Какое сегодня число в поясе человека. */
export function localDateParts(instant: Date, timeZone: string): DateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const value = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  return { year: value('year'), month: value('month'), day: value('day') };
}

/**
 * Дата в поясе человека, ГГГГ-ММ-ДД (задача 3.74).
 *
 * **Нужна потому, что `toISOString()` здесь всегда неверен.** Срок
 * хранится мгновением: полночь 05.09 у омича — это 04.09 18:00 по UTC, и
 * `toISOString().slice(0, 10)` даёт 04.09. Промах не краевой: он бьёт
 * каждый раз у каждого, кто восточнее Гринвича, то есть у всех наших.
 *
 * Собрана на `localDateParts`, а не своим `Intl`: одно понимание «какое
 * сегодня число» на весь бот, а не два похожих.
 */
export function isoDateIn(instant: Date, timeZone: string): string {
  const { year, month, day } = localDateParts(instant, timeZone);
  const pad = (value: number): string => String(value).padStart(2, '0');

  return `${String(year)}-${pad(month)}-${pad(day)}`;
}

/**
 * Начало суток в поясе человека.
 *
 * В два прохода: первое смещение берётся на полночь по UTC, второе — уже
 * на предполагаемом моменте. Разойтись они могут только на самой границе
 * перехода на летнее время, и тогда верно второе.
 */
export function startOfDayInZone(parts: DateParts, timeZone: string): Date {
  const utcMidnight = Date.UTC(parts.year, parts.month - 1, parts.day);

  const firstGuess = new Date(
    utcMidnight - zoneOffsetMinutes(new Date(utcMidnight), timeZone) * 60_000,
  );
  const secondOffset = zoneOffsetMinutes(firstGuess, timeZone);

  return new Date(utcMidnight - secondOffset * 60_000);
}

/**
 * Начало местного дня через `days` дней от дня, в который попадает `from`.
 *
 * Шаг в сутках делается до **полудня**, а не до полуночи: в ночь
 * перевода стрелок назад сутки на час длиннее, и «полночь плюс 24 часа»
 * — это 23:00 того же числа. Так «Перенести» накануне 25.10 оставляло
 * срок на месте, а «Отложить» теряло день (ревизия этапа 3, D6 и C1).
 * От полудня час в любую сторону числа не меняет.
 */
export function startOfDayAfter(from: Date, days: number, timeZone: string): Date {
  const dayStart = startOfDayInZone(localDateParts(from, timeZone), timeZone);
  const noonThen = new Date(dayStart.getTime() + (days * 24 + 12) * 60 * 60_000);

  return startOfDayInZone(localDateParts(noonThen, timeZone), timeZone);
}

/**
 * Описание сегодняшнего дня для промпта.
 *
 * День недели здесь обязателен: без него модель не сможет разрешить «в
 * четверг», а именно такие формулировки человек и произносит.
 *
 * **Часов и минут здесь нет, и это починка (задача 3.23).** Раньше было
 * «Сейчас понедельник, 31 августа 2026 г. в 12:11» — с минутами. На
 * боевом 31.08.2026 человек трижды отправил одно и то же голосовое, в
 * 11:06, 12:03 и 12:11, и получил разные приоритеты: «съездить в
 * магазин» — `LATER`, `LATER`, `SOON`. Выглядело как дребезг модели, а
 * на самом деле **вход был разный**: минута уходила в промпт.
 *
 * Замер это разделил. При одинаковом входе ответ совпал четыре раза из
 * четырёх — и при температуре 0.1, и при нуле. При трёх разных временах
 * того же дня разошлись ровно те две строки, что и в бою.
 *
 * **Минуту убрать можно потому, что модели её нечем выразить.** Срок она
 * возвращает датой, `ГГГГ-ММ-ДД`, — время в схеме не предусмотрено, и
 * `resolveDeadline` ничего другого не принимает. То есть это была
 * точность, которая на решение влиять не могла, а дребезг давала. Ни
 * один промпт на время суток не опирается — проверено по текстам.
 *
 * Теперь один и тот же текст, сказанный дважды за день, разбирается
 * одинаково. Через сутки — уже нет, и так и надо: «в четверг» от разных
 * дней это разные даты.
 *
 * Переименована из `describeNow` намеренно: прежнее имя обещало «сейчас»
 * и приглашало вернуть часы назад.
 */
export function describeToday(now: Date, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);

  return `Сегодня ${formatted}, часовой пояс ${timeZone}.`;
}

/** День недели даты в поясе человека: 0 — воскресенье, как у JS. */
export function weekdayOf(instant: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(instant);
  const order = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return Math.max(0, order.indexOf(name));
}

/**
 * Начало периода неточного срока: неделя — понедельник, месяц — первое
 * число, в поясе человека.
 *
 * Ручной прогон 15.09.2026 (вторник): «на следующей неделе» модель
 * вернула 22.09 — вторник через неделю — с точностью `week`. Всё вокруг
 * считало, что неделя хранится понедельником (`filter.ts`, мягкий
 * возврат планировщика): возврат ушёл бы утром вторника вместо
 * понедельника, карточка говорила бы «около 22 сентября». Дата модели —
 * день внутри периода, хранить надо начало периода — и считать его
 * должен код, а не модель.
 */
export function periodStartOf(at: Date, accuracy: 'week' | 'month', timeZone: string): Date {
  if (accuracy === 'month') {
    const parts = localDateParts(at, timeZone);
    return startOfDayInZone({ year: parts.year, month: parts.month, day: 1 }, timeZone);
  }

  // Понедельник — 1, воскресенье — 0: до понедельника назад 0…6 дней.
  const back = (weekdayOf(at, timeZone) + 6) % 7;
  return back === 0 ? at : startOfDayAfter(at, -back, timeZone);
}

/**
 * Ближайшая дата с нужным днём недели, начиная с сегодня.
 *
 * «В четверг», сказанное в четверг, — это сегодня, а не через неделю:
 * человек говорит о ближайшем, иначе он сказал бы «в следующий».
 */
/**
 * Человек сам сказал «в следующий» — дальний день его выбор.
 *
 * Список закрытый: это правило, а не догадка. Одно на классификацию и на
 * правку словами (ревизия этапа 3, A1-средняя): «перенеси на следующую
 * пятницу» уводило на ближайшую, потому что у правки этого исключения не
 * было.
 */
export function saysDistantWeek(words: string): boolean {
  return /следующ|через недел|через две недел|через полторы недел|на той недел/iu.test(words);
}

export function nearestWeekday(
  weekday: number,
  context: { readonly now: Date; readonly timeZone: string },
): Date {
  const today = startOfDayInZone(localDateParts(context.now, context.timeZone), context.timeZone);

  for (let shift = 0; shift < 7; shift++) {
    const candidate = new Date(today.getTime() + shift * 24 * 60 * 60_000);
    const parts = localDateParts(candidate, context.timeZone);
    const at = startOfDayInZone(parts, context.timeZone);
    if (weekdayOf(at, context.timeZone) === weekday) return at;
  }

  return today;
}

/** Час по поясу человека: 0–23. */
function localHourOf(instant: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(instant)
    .find((part) => part.type === 'hour')?.value;

  return Number(hour ?? '0');
}

/** До этого часа сегодняшний день недели ещё «сегодня». */
const NOON = 12;

/**
 * **Названный** день недели: «в пятницу», «во вторник».
 *
 * Отличается от `nearestWeekday` одним: сегодняшний день недели — это
 * сегодня только **до полудня**. Голос 10 Никиты (пятница 18.09.2026,
 * 18:21): «…хотя нет, к врачу лучше в пятницу» — модель отдала 25.09,
 * код «поправил» на ближайшую пятницу, то есть на сегодняшний вечер.
 * Проджект 03.09 (четверг, 20:00): «в четверг съездить к родителям» —
 * модель дала 10.09, код вернул на сегодня. Оба раза модель была права:
 * о сегодняшнем вечере человек говорит «сегодня», а «в пятницу» в
 * пятницу вечером — следующая пятница.
 *
 * Полдень — закрытое правило, а не догадка по обстоятельствам: до него
 * «в четверг заберу справку» в четверг может быть про сегодня, после —
 * уже нет. Периодов это не касается: «на выходных» в субботу вечером —
 * эти выходные, там остаётся `nearestWeekday`.
 */
export function namedWeekday(
  weekday: number,
  context: { readonly now: Date; readonly timeZone: string },
): Date {
  const today = startOfDayInZone(localDateParts(context.now, context.timeZone), context.timeZone);

  if (weekdayOf(today, context.timeZone) === weekday) {
    if (localHourOf(context.now, context.timeZone) < NOON) return today;

    return nearestWeekday(weekday, {
      now: startOfDayAfter(today, 1, context.timeZone),
      timeZone: context.timeZone,
    });
  }

  return nearestWeekday(weekday, context);
}

/**
 * Ближайший из названных дней недели.
 *
 * Названо два («вторник и четверг») — берём ближайший из них: выбрать за
 * человека нельзя, но поставить дату на понедельник — тем более. Замер
 * 27.08.2026: на «каждый вторник и четверг» модель вернула понедельник.
 */
function nearestWeekdayAmong(
  named: readonly number[],
  context: { readonly now: Date; readonly timeZone: string },
): Date {
  const days = named
    .map((weekday) => namedWeekday(weekday, context))
    .sort((left, right) => left.getTime() - right.getTime());

  // Пустым список сюда не приходит: вызов стоит под проверкой длины. Но
  // типы об этом не знают, а `noUncheckedIndexedAccess` — тем более.
  return (
    days[0] ?? startOfDayInZone(localDateParts(context.now, context.timeZone), context.timeZone)
  );
}

/**
 * Проверяет и привязывает к поясу то, что вернула модель.
 *
 * Пустой срок — не ошибка: у большинства мыслей срока нет. А вот срок в
 * прошлом ошибка почти наверняка: человек не ставит задачи на вчера, и
 * такое означает, что модель неверно разрешила «в четверг». Лучше
 * сохранить запись без срока, чем с неверным: напоминание, пришедшее не
 * вовремя, хуже не пришедшего.
 */
export function resolveDeadline(
  raw: { readonly deadline: string; readonly accuracy: DeadlineAccuracy },
  context: {
    readonly now: Date;
    readonly timeZone: string;
    /**
     * Текст самого дела — то, что человек сказал про него.
     *
     * Только он, без остальной выгрузки. Сначала проверялась вся
     * выгрузка тоже, и это оказалось дырой: одного слова «успеть» или
     * одной цифры «1968 года» где-нибудь в потоке хватало, чтобы
     * пропустить выдуманные сроки у двадцати других дел. Замер поймал
     * это сразу: семь придуманных сроков вернулись.
     *
     * Плата за строгость: если слово о времени осталось в соседней
     * единице или было выброшено извлечением, настоящий срок
     * потеряется. Живой журнал 02.09.2026 показал цену — шесть верных
     * дат за сутки. Поэтому рядом появилась вторая дорога: `quoted` и
     * `spoken` ниже. Она не смягчает эту проверку, а добавляет свою,
     * тоже проверяемую кодом.
     *
     * Не задан — проверка не работает, и срок принимается как раньше.
     */
    readonly said?: string | undefined;
    /**
     * Слова человека о времени, как их привела модель (задача 3.37).
     *
     * Дословная цитата из речи, а не пересказ: код проверяет её
     * присутствие в речи и только тогда признаёт срок. Так проверка
     * получает связь мысли с предложением речи, не догадываясь о ней.
     */
    readonly quoted?: string | undefined;
    /**
     * Речь человека целиком — то, в чём цитата обязана найтись.
     *
     * Не задана — ветка цитаты не работает, и остаётся прежнее правило.
     */
    readonly spoken?: string | undefined;
    /**
     * Слова соседних записей той же выгрузки: цитата, которую они
     * содержат, принадлежит им, а не этой записи (`quoteClaimedBy`).
     */
    readonly siblings?: readonly string[] | undefined;
  },
): DeadlineOutcome {
  const text = raw.deadline.trim();

  if (text === '' || raw.accuracy === 'none') {
    // Одно без другого — рассогласование в ответе модели, но не повод
    // терять запись: считаем, что срока нет.
    return { ok: true, deadline: undefined };
  }

  const monthOnly = MONTH_ONLY.exec(text);
  const matched = monthOnly ?? DATE_ONLY.exec(text);
  if (!matched) {
    return { ok: false, reason: `срок «${text}» не в виде ГГГГ-ММ-ДД` };
  }

  const parts: DateParts = {
    year: Number(matched[1]),
    month: Number(matched[2]),
    day: monthOnly ? 1 : Number(matched[3]),
  };
  const accuracy: DeadlineAccuracy = monthOnly ? 'month' : raw.accuracy;

  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) {
    return { ok: false, reason: `срок «${text}» не существует` };
  }

  const at = startOfDayInZone(parts, context.timeZone);

  /**
   * Неточный срок укладывается на начало периода (см. `periodStartOf`).
   * «На выходных» — исключение: там период начинается субботой, её
   * ставит ветка ниже; недельную точность от модели при слове «выходные»
   * тоже оставляем как есть.
   */
  const weekendSaid =
    context.said !== undefined && /(?<!\p{L})выходн/u.test(context.said.toLowerCase());
  const settled = (instant: Date): Date =>
    accuracy === 'month' || (accuracy === 'week' && !weekendSaid)
      ? periodStartOf(instant, accuracy, context.timeZone)
      : instant;

  // Проверка на существование числа: 31 февраля превратится в 3 марта,
  // и такой срок принимать нельзя.
  const back = localDateParts(at, context.timeZone);
  if (back.year !== parts.year || back.month !== parts.month || back.day !== parts.day) {
    return { ok: false, reason: `срок «${text}» не существует` };
  }

  const today = startOfDayInZone(localDateParts(context.now, context.timeZone), context.timeZone);

  if (at.getTime() < today.getTime()) {
    return { ok: false, reason: `срок «${text}» в прошлом` };
  }

  const limit = new Date(today);
  limit.setUTCFullYear(limit.getUTCFullYear() + MAX_YEARS_AHEAD);
  if (at.getTime() > limit.getTime()) {
    return { ok: false, reason: `срок «${text}» слишком далеко` };
  }

  let dayInWords = true;

  /**
   * Срок без слов о времени в речи человека — выдуманный (задача 2.7).
   *
   * Замер 27.08.2026: десять таких сроков из сорока трёх дел. Семи
   * покупкам подряд модель поставила «на этой неделе», хотя человек не
   * назвал ни одной даты, — и они вытеснили из выдачи ортопеда,
   * стоматолога и витамины.
   */
  if (context.said !== undefined) {
    /**
     * Цитата модели — вторая дорога к сроку (задача 3.37).
     *
     * Первая — слово о времени в словах человека об этом деле — рвётся
     * там, где извлечение ведущее слово выбросило. Вторая цела: модель
     * видит речь целиком и приводит слова человека дословно, а код
     * проверяет, что они в речи действительно есть.
     *
     * Пустая строка — цитаты нет или она не подтвердилась. Тогда всё
     * как прежде.
     */
    const quoted = context.quoted ?? '';
    const spoken = context.spoken ?? '';
    const inSpeech = quoted !== '' && spoken !== '' && timeQuoteInSpeech(quoted, spoken);
    // Цитата, которую содержат слова соседней записи, — её, не эта.
    const claimed = inSpeech && quoteClaimedBy(quoted, context.siblings ?? [], spoken);
    const quote = inSpeech && !claimed ? quoted.trim() : '';

    /**
     * Чужая цитата, с которой дата совпадает, — чужая дата (заказчица,
     * бой 21.09.2026).
     *
     * «Записаться на Хайдру на среду, так? Так завтра. С 9 до 10 не
     * забыть позвонить Елене Михайловне» — звонку модель дала среду с
     * цитатой «на среду», словами соседа. Цитата снималась, но цифры
     * «с 9 до 10» пускали дату и без неё: цифра — слово о времени.
     * Часы дня не называют; дата, совпадающая с чужой цитатой, взята из
     * неё, и держаться ей не на чем. Дата, с цитатой не совпадающая,
     * держится на своих словах, как прежде.
     */
    if (claimed && dateAgreesWith(quoted, at, context)) {
      return {
        ok: false,
        reason: `срок «${text}» опирается на цитату «${quoted.trim()}», которая относится к другой записи`,
      };
    }

    if (!hasTimeWord(context.said) && quote === '') {
      /**
       * Причину различаем: «цитаты не было», «цитата не подтвердилась»
       * и «цитата чужая» — разные неполадки, и лечатся они по-разному.
       * Без этого различия в журнале не понять, промахнулась модель или
       * проверка.
       */
      const attempted = context.quoted?.trim() ?? '';
      const reason =
        attempted === ''
          ? `срок «${text}» человеком не назван`
          : claimed
            ? `срок «${text}» опирается на цитату «${attempted}», которая относится к другой записи`
            : `срок «${text}» опирается на цитату «${attempted}», которой в речи нет`;

      return { ok: false, reason };
    }

    /**
     * Если человек назвал день недели, дата обязана быть этим днём.
     *
     * Замер того же дня: на «записаться к стоматологу в четверг» модель
     * вернула среду. Считать день недели — работа кода: он это делает
     * точно, а модель ошибается молча.
     *
     * Подтверждённая цитата участвует наравне со словами о деле: день
     * недели человек мог назвать только в ней.
     */
    const words = quote === '' ? context.said : `${context.said} ${quote}`;
    const named = weekdaysIn(words);
    // Число месяца словами — тоже названный день (стенд 27.09.2026).
    const ordinals = dayOfMonthIn(words);
    dayInWords = dayWordsIn(words).length > 0 || ordinals.length > 0;

    /**
     * Назван день недели — это день, даже если модель сказала «неделя»
     * (серия голосовых 18.09.2026, голос 4). «По средам английский»:
     * модель дала верную среду с точностью `week`, укладка на начало
     * периода увела срок на понедельник — а с ним и якорь правила «по
     * средам», который берётся из срока. §2.7: `day` — назван конкретный
     * день; начало недели ему не нужно.
     */
    const dayNamed = named.length > 0 && accuracy === 'week';

    /**
     * «Сегодня», «завтра», «послезавтра» — дата считается кодом (3.41).
     *
     * Живая выгрузка проджекта 03.09.2026: «ещё **сегодня** хотел
     * позвонить бабушке» модель датировала **завтрашним** днём. Слово
     * названо прямо, и дата из него следует однозначно — значит это
     * работа кода, ровно как со днём недели.
     *
     * Только когда названо **одно** такое слово и день недели не назван:
     * «сегодня купить продукты на завтра» толковать за человека нельзя,
     * а «в четверг» разбирается правилом ниже.
     *
     * Только при точности `day`: «на этой неделе» и «в сентябре» словом
     * о дне не опровергаются.
     */
    /**
     * «На выходных» — период, а не день (задача 3.50).
     *
     * §2.7 задаёт точность так: `day` — назван конкретный день, `week` —
     * названа неделя. «Выходные» это два дня, и выдавать их за один
     * нельзя: напоминание придёт в субботу к делу, которое человек мог
     * держать на воскресенье, — а он не выбирал.
     *
     * Модель здесь ошибается устойчиво: в контрольном наборе «разобрать
     * балкон на выходных» она четыре прогона подряд отдавала `day`. Дата
     * ставится на субботу — начало периода, — и точность становится
     * недельной.
     *
     * Только когда «выходные» единственное обозначение дня: сказано «в
     * субботу на выходных» — значит день назван, и решает он.
     */
    const weekend = /(?<!\p{L})выходн/u.test(words.toLowerCase());
    const shifts = relativeDaysIn(words);

    /**
     * «До десятого» — число в дате обязано совпасть (стенд 27.09.2026,
     * voice-27-03). Не совпало — срока нет, как было до того, как число
     * словами стали признавать: худший случай равен прежнему.
     */
    if (
      accuracy === 'day' &&
      ordinals.length > 0 &&
      named.length === 0 &&
      shifts.length === 0 &&
      !ordinals.includes(localDateParts(at, context.timeZone).day)
    ) {
      return { ok: false, reason: `срок «${text}» не совпал с числом, названным человеком` };
    }

    if (accuracy === 'day' && weekend && named.length === 0 && shifts.length === 0) {
      return {
        ok: true,
        deadline: { at: nearestWeekday(6, context), accuracy: 'week' },
        corrected: 'weekend',
      };
    }

    if (accuracy === 'day' && named.length === 0 && shifts.length === 1) {
      const shift = shifts[0] ?? 0;
      const wanted = new Date(
        startOfDayInZone(
          localDateParts(context.now, context.timeZone),
          context.timeZone,
        ).getTime() +
          shift * 24 * 60 * 60_000,
      );
      const at2 = startOfDayInZone(localDateParts(wanted, context.timeZone), context.timeZone);

      if (at2.getTime() !== at.getTime()) {
        return { ok: true, deadline: { at: at2, accuracy }, corrected: 'relative' };
      }
    }

    /**
     * Назван день недели — берётся **ближайший** такой день (задача 3.39).
     *
     * Проверка выше требовала, чтобы дата была названным днём, но не
     * требовала, чтобы он был ближайшим. Модель этим и пользовалась:
     * 03.09.2026, в четверг, на «в четверг забрать справку» она вернула
     * **10 сентября** — тоже четверг, проверка пропустила, справка уехала
     * на неделю. Найдено живым прогоном в Telegram.
     *
     * Правило это уже записано у `nearestWeekday`: «человек говорит о
     * ближайшем, иначе он сказал бы „в следующий"». Не хватало только
     * применить его и к дате, которая по дню недели совпала.
     *
     * **Кроме случая, когда человек как раз и сказал „в следующий".**
     * Тогда дальний день — его выбор, и трогать его нельзя. Список
     * закрытый: это правило, а не догадка.
     */
    const distant = saysDistantWeek(words);

    const off =
      named.length > 0 &&
      (!named.includes(weekdayOf(at, context.timeZone)) ||
        (!distant && at.getTime() > nearestWeekdayAmong(named, context).getTime()));

    if (off) {
      /**
       * Дата обязана быть одним из названных дней.
       *
       * Названо два («вторник и четверг») — берём ближайший из них:
       * выбрать за человека нельзя, но поставить дату на понедельник —
       * тем более. Замер 27.08.2026: на «каждый вторник и четверг»
       * модель вернула понедельник.
       */
      const nearest = nearestWeekdayAmong(named, context);

      return {
        ok: true,
        deadline: dayNamed ? { at: nearest, accuracy: 'day' } : { at: settled(nearest), accuracy },
        corrected: 'weekday',
      };
    }

    if (dayNamed) {
      return { ok: true, deadline: { at, accuracy: 'day' }, corrected: 'weekday' };
    }

    /**
     * Назван месяц — срок обязан быть в нём (прогон 17.09.2026).
     *
     * Бой: расшифровка склеила «…к стоматологу давно уже откладываю в
     * октябре пройти диспансеризацию», и на диспансеризацию модель
     * вернула сентябрьскую неделю — срок соседнего дела. Месяц назван
     * прямо, и дата из него следует однозначно: это работа кода, как и
     * день недели выше. Ближайший такой месяц — прошедший в этом году
     * значит следующий год. Точность — месяц: дня человек не называл.
     *
     * Только когда назван **один** месяц и ни дня недели, ни «завтра»:
     * «в пятницу в октябре» и «с сентября по ноябрь» толковать за
     * человека нельзя. Дата уже в названном месяце — не трогается, с
     * точностью модели: «15 октября» остаётся днём.
     */
    const months = monthsIn(words);

    if (months.length === 1 && named.length === 0 && shifts.length === 0) {
      const month = months[0] ?? 0;
      const local = localDateParts(at, context.timeZone);

      if (local.month !== month) {
        return {
          ok: true,
          deadline: { at: nearestMonthStart(month, context), accuracy: 'month' },
          corrected: 'month',
        };
      }
    }
  }

  return { ok: true, deadline: { at: settled(at), accuracy }, dayNamed: dayInWords };
}

/** Дата следует из цитаты: тот же день недели, «завтра» или тот же месяц. */
function dateAgreesWith(
  quote: string,
  at: Date,
  context: { readonly now: Date; readonly timeZone: string },
): boolean {
  if (weekdaysIn(quote).includes(weekdayOf(at, context.timeZone))) return true;

  const today = startOfDayInZone(localDateParts(context.now, context.timeZone), context.timeZone);
  const sameDay = relativeDaysIn(quote).some((shift) => {
    const wanted = new Date(today.getTime() + shift * 24 * 60 * 60_000);
    return (
      startOfDayInZone(localDateParts(wanted, context.timeZone), context.timeZone).getTime() ===
      at.getTime()
    );
  });
  if (sameDay) return true;

  return monthsIn(quote).includes(localDateParts(at, context.timeZone).month);
}

/**
 * Первое число ближайшего названного месяца в поясе человека.
 *
 * Текущий и будущие месяцы — в этом году, прошедший — в следующем: «в
 * сентябре», сказанное в сентябре, — этот сентябрь; «в марте» в сентябре
 * — март следующего года.
 */
export function nearestMonthStart(
  month: number,
  context: { readonly now: Date; readonly timeZone: string },
): Date {
  const today = localDateParts(context.now, context.timeZone);
  const year = month >= today.month ? today.year : today.year + 1;

  return startOfDayInZone({ year, month, day: 1 }, context.timeZone);
}
