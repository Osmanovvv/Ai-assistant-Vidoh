import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import { items, type Item } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { localDateParts, startOfDayInZone } from '../classifier/dates.js';
import { OPEN_STATUSES } from '../items/items.repo.js';

/**
 * Разбор вчерашнего вместо хвоста (запрос на изменение №4, решение
 * заказчицы 13.09.2026, ответы 1.1–1.2).
 *
 * Просроченное больше не висит первым в «Сегодня» день за днём. Вместо
 * этого — один разбор: «Вчера не дошли руки до: …» с тремя кнопками на
 * дело («На сегодня», «Позже», «Убрать»). Показывается один раз; что не
 * разобрано к следующему утру — само уходит в «Позже», без повторного
 * вопроса: ВЫДОХ помнит, человек не обязан всё разбирать.
 *
 * «Позже» — снять дату, оставить дело. Оно возвращается само: утром,
 * когда актуальных дел меньше трёх, — одно из отложенного отдельной
 * строкой как необязательное, каждое не чаще раза в неделю, по кругу от
 * самого давнего.
 */

/** Больше за одно утро не показывается — остальное подождёт следующего. */
export const REVIEW_LIMIT = 5;
/** Одно и то же дело из «Позже» не предлагается чаще раза в неделю. */
export const OFFER_AGAIN_AFTER_DAYS = 7;

export interface Review {
  /** «Вчера не дошли руки» — когда всё из вчерашнего; иначе без «вчера». */
  readonly since: 'yesterday' | 'earlier';
  readonly items: readonly Item[];
}

/** Открытое, не в фоне, не черновик: то, что вообще показывается. */
function live(userId: string): ReturnType<typeof and> {
  return and(
    eq(items.userId, userId),
    eq(items.isDraft, false),
    isNull(items.backgroundedAt),
    inArray(items.status, [...OPEN_STATUSES]),
  );
}

/**
 * Что показать в разборе: открытые дела с точным сроком раньше
 * сегодняшнего местного дня, ещё не показанные, — по сроку, не больше
 * `REVIEW_LIMIT`. Неточные сроки («на неделе», «в сентябре») в разбор не
 * попадают: они не «вчера», у них есть свой отрезок.
 */
export async function reviewDue(
  db: Executor,
  params: { readonly userId: string; readonly now: Date; readonly timeZone: string },
): Promise<Review | undefined> {
  const todayStart = startOfDayInZone(localDateParts(params.now, params.timeZone), params.timeZone);

  const due = await db
    .select()
    .from(items)
    .where(
      and(
        live(params.userId),
        isNull(items.reviewedAt),
        eq(items.deadlineAccuracy, 'day'),
        lt(items.deadlineAt, todayStart),
      ),
    )
    .orderBy(asc(items.deadlineAt))
    .limit(REVIEW_LIMIT);

  if (due.length === 0) return undefined;

  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60_000);
  const allYesterday = due.every(
    (one) => one.deadlineAt !== null && one.deadlineAt.getTime() >= yesterdayStart.getTime(),
  );

  return { since: allYesterday ? 'yesterday' : 'earlier', items: due };
}

/** Показано в разборе — отметка, чтобы не показывать снова. */
export async function markReviewed(db: Executor, ids: readonly string[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(items)
    .set({ reviewedAt: now })
    .where(inArray(items.id, [...ids]));
}

/**
 * Показанное до сегодняшнего дня и всё ещё просроченное — в «Позже»
 * (ответ 1.2). Без реплики и без ревизии: это не решение человека, а
 * обещанное умолчание; откатывать тут нечего — дело на месте, только без
 * даты. Нажатое «На сегодня» сюда не попадает: срок у него уже не в
 * прошлом.
 */
export async function autoDeferReviewed(
  db: Executor,
  params: { readonly userId: string; readonly now: Date; readonly timeZone: string },
): Promise<number> {
  const todayStart = startOfDayInZone(localDateParts(params.now, params.timeZone), params.timeZone);

  const moved = await db
    .update(items)
    .set({
      deadlineAt: null,
      deadlineAccuracy: null,
      priority: 'LATER',
      deferredAt: params.now,
      // Уснувшее кнопкой «Отложить» просыпается: «Позже» — не сон.
      status: sql`case when ${items.status} = 'snoozed' then 'active' else ${items.status} end`,
      updatedAt: params.now,
    })
    .where(
      and(
        live(params.userId),
        isNotNull(items.reviewedAt),
        lt(items.reviewedAt, todayStart),
        lt(items.deadlineAt, todayStart),
      ),
    )
    .returning({ id: items.id });

  return moved.length;
}

/**
 * Одно дело из «Позже» для утреннего, когда актуальных дел мало: то, что
 * не предлагали дольше всех, — сперва никогда не предлагавшиеся, от самого
 * давнего, — и никогда чаще раза в неделю.
 */
export async function offerFromLater(
  db: Executor,
  params: { readonly userId: string; readonly now: Date },
): Promise<Item | undefined> {
  const threshold = new Date(params.now.getTime() - OFFER_AGAIN_AFTER_DAYS * 24 * 60 * 60_000);

  const [row] = await db
    .select()
    .from(items)
    .where(
      and(
        live(params.userId),
        isNotNull(items.deferredAt),
        or(isNull(items.offeredAt), lt(items.offeredAt, threshold)),
      ),
    )
    .orderBy(sql`${items.offeredAt} asc nulls first`, asc(items.deferredAt))
    .limit(1);

  return row;
}

/** Предложено утром — отметка, чтобы не повторять неделю. */
export async function markOffered(db: Executor, id: string, now: Date): Promise<void> {
  await db.update(items).set({ offeredAt: now }).where(eq(items.id, id));
}
