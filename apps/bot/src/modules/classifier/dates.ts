import type { DeadlineAccuracy } from '../ai/schemas/classifier.js';
import { hasTimeWord, weekdaysIn } from './time-words.js';

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
}

export type DeadlineOutcome =
  | {
      readonly ok: true;
      readonly deadline: ResolvedDeadline;
      /**
       * Что пришлось поправить за моделью. Пока одно: день недели не
       * совпал с названным человеком, и дата пересчитана кодом.
       */
      readonly corrected?: 'weekday' | undefined;
    }
  | { readonly ok: false; readonly reason: string }
  /** Срока просто нет — это не ошибка. */
  | { readonly ok: true; readonly deadline: undefined };

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;

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
 * Описание «сейчас» для промпта.
 *
 * День недели здесь обязателен: без него модель не сможет разрешить «в
 * четверг», а именно такие формулировки человек и произносит.
 */
export function describeNow(now: Date, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(now);

  return `Сейчас ${formatted}, часовой пояс ${timeZone}.`;
}

/** День недели даты в поясе человека: 0 — воскресенье, как у JS. */
export function weekdayOf(instant: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(instant);
  const order = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return Math.max(0, order.indexOf(name));
}

/**
 * Ближайшая дата с нужным днём недели, начиная с сегодня.
 *
 * «В четверг», сказанное в четверг, — это сегодня, а не через неделю:
 * человек говорит о ближайшем, иначе он сказал бы «в следующий».
 */
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
     * Плата за строгость: если модель вынесла дату в соседнюю единицу,
     * настоящий срок потеряется. Это верный выбор — ТЗ прямо говорит,
     * что неверный срок хуже отсутствующего, а потеря видна в отчёте
     * стенда как точность срока.
     *
     * Не задан — проверка не работает, и срок принимается как раньше.
     */
    readonly said?: string | undefined;
  },
): DeadlineOutcome {
  const text = raw.deadline.trim();

  if (text === '' || raw.accuracy === 'none') {
    // Одно без другого — рассогласование в ответе модели, но не повод
    // терять запись: считаем, что срока нет.
    return { ok: true, deadline: undefined };
  }

  const matched = DATE_ONLY.exec(text);
  if (!matched) {
    return { ok: false, reason: `срок «${text}» не в виде ГГГГ-ММ-ДД` };
  }

  const parts: DateParts = {
    year: Number(matched[1]),
    month: Number(matched[2]),
    day: Number(matched[3]),
  };

  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) {
    return { ok: false, reason: `срок «${text}» не существует` };
  }

  const at = startOfDayInZone(parts, context.timeZone);

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

  /**
   * Срок без слов о времени в речи человека — выдуманный (задача 2.7).
   *
   * Замер 27.08.2026: десять таких сроков из сорока трёх дел. Семи
   * покупкам подряд модель поставила «на этой неделе», хотя человек не
   * назвал ни одной даты, — и они вытеснили из выдачи ортопеда,
   * стоматолога и витамины.
   */
  if (context.said !== undefined) {
    if (!hasTimeWord(context.said)) {
      return { ok: false, reason: `срок «${text}» человеком не назван` };
    }

    /**
     * Если человек назвал день недели, дата обязана быть этим днём.
     *
     * Замер того же дня: на «записаться к стоматологу в четверг» модель
     * вернула среду. Считать день недели — работа кода: он это делает
     * точно, а модель ошибается молча.
     */
    const named = weekdaysIn(context.said);
    if (named.length > 0 && !named.includes(weekdayOf(at, context.timeZone))) {
      /**
       * Дата обязана быть одним из названных дней.
       *
       * Названо два («вторник и четверг») — берём ближайший из них:
       * выбрать за человека нельзя, но поставить дату на понедельник —
       * тем более. Замер 27.08.2026: на «каждый вторник и четверг»
       * модель вернула понедельник.
       */
      const nearest = named
        .map((weekday) => nearestWeekday(weekday, context))
        .sort((left, right) => left.getTime() - right.getTime())[0];

      if (nearest !== undefined) {
        return {
          ok: true,
          deadline: { at: nearest, accuracy: raw.accuracy },
          corrected: 'weekday',
        };
      }
    }
  }

  return { ok: true, deadline: { at, accuracy: raw.accuracy } };
}
