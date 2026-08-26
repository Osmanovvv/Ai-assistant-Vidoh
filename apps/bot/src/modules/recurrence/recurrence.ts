import { z } from 'zod';

import { localDateParts, startOfDayInZone, type DateParts } from '../classifier/dates.js';

/**
 * Правило повторения (задача 2.18а, запрос на изменение №1).
 *
 * Сейчас «каждый вторник вожу сына на плавание» разбирается в обычную
 * задачу со сроком на ближайший вторник. Ошибки не видно: запись создана,
 * срок есть, тест зелёный. Регулярность просто исчезает, и человек через
 * неделю обнаруживает, что бот её не помнит.
 *
 * **Правило — закрытый набор, а не RRULE.** Полный стандарт RFC 5545 тут
 * ловушка: модель начнёт возвращать строки, которые мы не умеем
 * проверять, а «каждый второй вторник месяца кроме августа» живой человек
 * не говорит.
 *
 * **Правило опирается на срок, который модель уже вернула.** Это главное
 * решение здесь. «Каждый вторник» — это вид повторения плюс дата первого
 * вторника, и дату модель и так возвращает полем срока. Значит день
 * недели, число месяца и месяц выводятся из неё, а не запрашиваются
 * отдельно: чем меньше полей модель заполняет, тем меньше ей есть где
 * ошибиться. Заодно правило не может разойтись со сроком — они одно.
 *
 * **Чего набор не умеет.** «Каждый вторник и четверг», «раз в три месяца
 * по чётным» и прочие составные — их модель обязана пометить как
 * непонятые, и тогда фраза сохраняется текстом без правила. Выдумать
 * правило, которого мы не умеем воспроизвести, хуже, чем признаться, что
 * не разобрали. Насколько такие фразы частые, покажет контрольный набор
 * (2.19) — по нему и решать, расширять ли набор.
 */

/**
 * Виды повторения.
 *
 * `weekdays` — это «по будням», отдельный вид, а не список дней: он самый
 * частый из составных и выражается без единого лишнего поля.
 */
export const RECURRENCE_KINDS = [
  'none',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'yearly',
  'unclear',
] as const;

export type RecurrenceKind = (typeof RECURRENCE_KINDS)[number];

/** Виды, из которых получается работающее правило. */
const RULED_KINDS = new Set<RecurrenceKind>(['daily', 'weekdays', 'weekly', 'monthly', 'yearly']);

/** Каким из четырёх способов запроса на изменение появилась регулярность. */
export const RECURRENCE_SOURCES = ['stated', 'asked', 'noticed', 'history'] as const;
export type RecurrenceSource = (typeof RECURRENCE_SOURCES)[number];

/**
 * Правило в том виде, в каком оно ложится в базу.
 *
 * `anchor` — дата первого повторения в поясе человека, ГГГГ-ММ-ДД. Из неё
 * берутся день недели, число месяца и месяц: отдельных полей под них нет
 * намеренно.
 */
export const recurrenceRuleSchema = z.object({
  kind: z.enum(['daily', 'weekdays', 'weekly', 'monthly', 'yearly']),
  /** Через сколько периодов повторять: «раз в две недели» — это два. */
  interval: z.number().int().min(1).max(99),
  anchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
});

export type RecurrenceRule = z.infer<typeof recurrenceRuleSchema>;

export interface RecurrenceFromModel {
  readonly kind: RecurrenceKind;
  readonly interval: number;
  /** Как сказал человек: «каждый вторник», «раз в месяц». */
  readonly text: string;
  /** Срок, который модель вернула той же записи, ГГГГ-ММ-ДД или пусто. */
  readonly deadline: string;
}

export interface ResolvedRecurrence {
  /** Правило, если оно получилось. */
  readonly rule?: RecurrenceRule | undefined;
  /** Фраза человека. Сохраняется и без правила. */
  readonly text?: string | undefined;
  readonly source?: RecurrenceSource | undefined;
  /** Почему правила нет, если фраза есть. Идёт в лог, не человеку. */
  readonly problem?: string | undefined;
}

const NOT_RECURRING: ResolvedRecurrence = {};

/**
 * Приводит ответ модели к правилу.
 *
 * Возвращает не-исключение в любом случае: регулярность — не то, из-за
 * чего стоит терять запись. Не получилось правило — остаётся фраза.
 */
export function resolveRecurrence(raw: RecurrenceFromModel): ResolvedRecurrence {
  const text = raw.text.trim();

  if (raw.kind === 'none') {
    // Модель может вернуть фразу и при этом сказать «не регулярное» —
    // верим виду, а не фразе: вид она выбирает из списка, фразу пишет
    // свободно.
    return NOT_RECURRING;
  }

  if (text === '') {
    // Вид без фразы — рассогласование в ответе. Показывать человеку
    // «регулярное» без того, что он сказал, нельзя: он не узнает своих слов.
    return { problem: 'вид повторения без фразы человека' };
  }

  if (raw.kind === 'unclear') {
    return { text, source: 'stated', problem: 'правило не выражается закрытым набором' };
  }

  if (!RULED_KINDS.has(raw.kind)) {
    return { text, source: 'stated', problem: `неизвестный вид повторения «${raw.kind}»` };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/u.test(raw.deadline)) {
    // Правило опирается на срок: без него неизвестен ни день недели, ни
    // число месяца. Фраза сохраняется, правило — нет.
    return { text, source: 'stated', problem: 'нет срока, на который опереться' };
  }

  const interval = Number.isInteger(raw.interval) && raw.interval >= 1 ? raw.interval : 1;

  const parsed = recurrenceRuleSchema.safeParse({
    kind: raw.kind,
    interval: Math.min(interval, 99),
    anchor: raw.deadline,
  });

  if (!parsed.success) {
    return { text, source: 'stated', problem: 'правило не прошло проверку схемы' };
  }

  return { rule: parsed.data, text, source: 'stated' };
}

/** Правило из базы: приходит как `unknown`, потому что это jsonb. */
export function parseStoredRule(value: unknown): RecurrenceRule | undefined {
  const parsed = recurrenceRuleSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Понедельник — единица, воскресенье — семь. */
function weekdayOf(parts: DateParts): number {
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

function partsFromIso(iso: string): DateParts {
  const [year, month, day] = iso.split('-').map(Number);
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 };
}

/** Сколько дней в месяце. Нужно, чтобы 31 число не уехало на 3 марта. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(parts: DateParts, days: number): DateParts {
  const at = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}

function addMonths(parts: DateParts, months: number): DateParts {
  const total = parts.year * 12 + (parts.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;

  // 31 января плюс месяц — это 28 или 29 февраля, а не 3 марта. Молчаливый
  // переход через край месяца мы уже разбирали на задаче 2.7.
  return { year, month, day: Math.min(parts.day, daysInMonth(year, month)) };
}

function compare(left: DateParts, right: DateParts): number {
  return (
    Date.UTC(left.year, left.month - 1, left.day) - Date.UTC(right.year, right.month - 1, right.day)
  );
}

/**
 * Следующее повторение после указанного момента.
 *
 * Возвращает начало суток в поясе человека — то же представление, в каком
 * хранится срок (2.7). Правило говорит про календарные дни, а не про
 * мгновения: «каждый вторник» — это вторник, во сколько бы человек ни
 * вспомнил о деле.
 *
 * Переход на летнее время учитывается тем же кодом, что и сроки: начало
 * суток считается через `Intl`, и своей таблицы поясов у нас нет.
 */
export function nextOccurrence(
  rule: RecurrenceRule,
  params: { readonly after: Date; readonly timeZone: string },
): Date {
  const anchor = partsFromIso(rule.anchor);
  const today = localDateParts(params.after, params.timeZone);

  // Якорь ещё не наступил — он и есть следующее повторение.
  if (compare(anchor, today) > 0) return startOfDayInZone(anchor, params.timeZone);

  let candidate = anchor;
  // Предел на случай странного правила: год ежедневных шагов заведомо
  // перекрывает любой разумный интервал, а бесконечного цикла не будет.
  const LIMIT = 400;

  for (let step = 0; step < LIMIT; step++) {
    candidate = advance(rule, candidate);
    if (compare(candidate, today) > 0) return startOfDayInZone(candidate, params.timeZone);
  }

  return startOfDayInZone(candidate, params.timeZone);
}

function advance(rule: RecurrenceRule, from: DateParts): DateParts {
  switch (rule.kind) {
    case 'daily':
      return addDays(from, rule.interval);

    case 'weekdays': {
      // Следующий рабочий день: суббота и воскресенье пропускаются.
      let next = addDays(from, 1);
      while (weekdayOf(next) > 5) next = addDays(next, 1);
      return next;
    }

    case 'weekly':
      return addDays(from, 7 * rule.interval);

    case 'monthly':
      return addMonths(from, rule.interval);

    case 'yearly':
      return addMonths(from, 12 * rule.interval);
  }
}

/**
 * Уже ли пройдено повторение. Нужно третьему этапу: отметка выполнения
 * двигает срок вперёд, а не создаёт вторую запись.
 */
export function isRuled(kind: RecurrenceKind): boolean {
  return RULED_KINDS.has(kind);
}
