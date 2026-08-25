import type { EnergyLevelValue, Item } from '../../db/schema.js';
import { localDateParts, startOfDayInZone } from '../classifier/dates.js';

/**
 * Отбор дел для ответа (задача 2.10).
 *
 * Единственный шаг конвейера §3 ТЗ, у которого нет спецификации, — и при
 * этом именно он определяет, что человек увидит. Поэтому здесь
 * **детерминированный код, а не модель**: иначе выдача плавает между
 * запусками, и критерии приёмки 1 и 7 невоспроизводимы. Один и тот же
 * набор записей при одинаковом уровне сил обязан давать одну и ту же
 * выдачу — всегда.
 *
 * Порядок и лимиты заданы планом, а не выдуманы здесь. Всё, что выбрано
 * произвольно, названо в комментариях явно.
 */

/**
 * Сколько дел показывать при каком уровне сил.
 *
 * §13.2 ТЗ требует ограниченного списка: человек пришёл разгрузить голову,
 * а не получить второй список из двадцати пунктов. При «я на нуле» одно
 * дело — не скупость, а единственное, что в таком состоянии выполнимо.
 */
export const LIMIT_BY_ENERGY: Readonly<Record<EnergyLevelValue, number>> = {
  high: 3,
  normal: 3,
  low: 2,
  empty: 1,
};

/** Статусы, при которых дело ещё ждёт действия. */
const OPEN_STATUSES = new Set(['new', 'active', 'in_progress', 'waiting']);

export interface SelectContext {
  readonly energy: EnergyLevelValue;
  readonly now: Date;
  readonly timeZone: string;
}

export interface SelectionResult {
  /** Что показать. Не длиннее лимита по уровню сил. */
  readonly shown: readonly Item[];
  /**
   * Сколько дел осталось за пределами выдачи. §13.2 требует одной фразы
   * о том, что остальное сохранено, и для неё нужно число.
   */
  readonly hidden: number;
}

/**
 * Очередь важности: чем меньше число, тем раньше показываем.
 *
 * Порядок задан планом: просроченные, срок сегодня, `NOW`, `SOON`
 * с ближайшим сроком, остальное.
 */
const BUCKET = {
  overdue: 0,
  today: 1,
  now: 2,
  soon: 3,
  rest: 4,
} as const;

type Bucket = (typeof BUCKET)[keyof typeof BUCKET];

/**
 * Годится ли запись для выдачи вообще.
 *
 * §6.3 ТЗ: желание, идея, информация и эмоция получают приоритет `NONE`
 * и в выдачу не попадают. Проверяется и по типу, и по приоритету:
 * классификация уже приводит их в согласие, но выдача не должна
 * зависеть от того, что кто-то раньше всё сделал правильно.
 */
export function isShowable(item: Item): boolean {
  if (item.isDraft) return false;
  if (item.type !== 'TASK') return false;
  if (item.priority === 'NONE' || item.priority === null) return false;

  return OPEN_STATUSES.has(item.status);
}

function bucketOf(item: Item, todayStart: Date, tomorrowStart: Date): Bucket {
  const deadline = item.deadlineAt?.getTime();

  if (deadline !== undefined) {
    if (deadline < todayStart.getTime()) return BUCKET.overdue;
    if (deadline < tomorrowStart.getTime()) return BUCKET.today;
  }

  if (item.priority === 'NOW') return BUCKET.now;
  if (item.priority === 'SOON') return BUCKET.soon;

  return BUCKET.rest;
}

/**
 * Порядок внутри очереди.
 *
 * Сначала по сроку: у кого раньше, тот важнее, а бессрочные после
 * срочных. Потом по времени создания и по идентификатору — это и делает
 * выдачу воспроизводимой. Без последнего шага две записи с одинаковым
 * сроком менялись бы местами от запуска к запуску, и критерий
 * «одинаковая выдача» стал бы недостижим.
 */
function compareWithin(left: Item, right: Item): number {
  const leftDeadline = left.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightDeadline = right.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY;

  if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;

  const byCreated = left.createdAt.getTime() - right.createdAt.getTime();
  if (byCreated !== 0) return byCreated;

  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Отбирает дела для ответа.
 *
 * Чистая функция: ни базы, ни модели, ни текущего времени изнутри. Всё,
 * что влияет на результат, приходит параметрами — только так выдачу можно
 * проверить таблицей случаев и повторить в точности.
 */
export function selectForOutput(items: readonly Item[], context: SelectContext): SelectionResult {
  const todayStart = startOfDayInZone(
    localDateParts(context.now, context.timeZone),
    context.timeZone,
  );
  const tomorrow = new Date(todayStart.getTime() + 24 * 60 * 60_000);
  const tomorrowStart = startOfDayInZone(
    localDateParts(tomorrow, context.timeZone),
    context.timeZone,
  );

  const showable = items.filter((item) => isShowable(item));

  const ranked = [...showable].sort((left, right) => {
    const byBucket =
      bucketOf(left, todayStart, tomorrowStart) - bucketOf(right, todayStart, tomorrowStart);
    return byBucket === 0 ? compareWithin(left, right) : byBucket;
  });

  const limit = LIMIT_BY_ENERGY[context.energy];

  return { shown: ranked.slice(0, limit), hidden: Math.max(0, ranked.length - limit) };
}

/**
 * Действующий уровень сил.
 *
 * Названный уровень живёт до конца суток человека: «я на нуле» сказанное
 * утром не должно решать за него неделю. После смены суток выдача снова
 * берёт значение по умолчанию из настроек.
 */
export function effectiveEnergy(
  state: { readonly energy: EnergyLevelValue; readonly energyAt: Date } | undefined,
  fallback: EnergyLevelValue,
  context: { readonly now: Date; readonly timeZone: string },
): EnergyLevelValue {
  if (!state) return fallback;

  const said = localDateParts(state.energyAt, context.timeZone);
  const today = localDateParts(context.now, context.timeZone);

  const sameDay = said.year === today.year && said.month === today.month && said.day === today.day;

  return sameDay ? state.energy : fallback;
}
