import type { DeadlineAccuracy } from '../ai/schemas/classifier.js';
import { hasTimeWord, relativeDaysIn, timeQuoteInSpeech, weekdaysIn } from './time-words.js';

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
      readonly corrected?: 'weekday' | 'relative' | 'weekend' | undefined;
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
    .map((weekday) => nearestWeekday(weekday, context))
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
    const quote =
      context.quoted !== undefined &&
      context.spoken !== undefined &&
      timeQuoteInSpeech(context.quoted, context.spoken)
        ? context.quoted.trim()
        : '';

    if (!hasTimeWord(context.said) && quote === '') {
      /**
       * Причину различаем: «цитаты не было» и «цитата не подтвердилась»
       * — разные неполадки, и лечатся они по-разному. Без этого различия
       * в журнале не понять, промахнулась модель или проверка.
       */
      const attempted = context.quoted?.trim() ?? '';
      const reason =
        attempted === ''
          ? `срок «${text}» человеком не назван`
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

    if (raw.accuracy === 'day' && weekend && named.length === 0 && shifts.length === 0) {
      return {
        ok: true,
        deadline: { at: nearestWeekday(6, context), accuracy: 'week' },
        corrected: 'weekend',
      };
    }

    if (raw.accuracy === 'day' && named.length === 0 && shifts.length === 1) {
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
        return { ok: true, deadline: { at: at2, accuracy: raw.accuracy }, corrected: 'relative' };
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
    const distant = /следующ|через недел|через две недел|через полторы недел|на той недел/iu.test(
      words,
    );

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
        deadline: { at: nearest, accuracy: raw.accuracy },
        corrected: 'weekday',
      };
    }
  }

  return { ok: true, deadline: { at, accuracy: raw.accuracy } };
}
