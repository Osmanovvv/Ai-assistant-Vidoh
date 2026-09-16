import { count, desc, eq, gte } from 'drizzle-orm';

import { misunderstood, users } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';

/**
 * Журнал непонятого (заказчица, 16.09.2026, панель п. 3).
 *
 * Пишется конвейером в момент отправки реплики сдачи — см.
 * `FALLBACK_REPLIES` в словаре и `tell` в обработчике выгрузки. Читается
 * обзором панели (число за период) и списком по клику.
 */

export interface MisunderstoodToRecord {
  readonly userId: string;
  readonly batchId?: string | undefined;
  /** Что человек написал или наговорил — целиком. */
  readonly said: string;
  /** Что ответил бот — дословно. */
  readonly replied: string;
  /** Путь реплики сдачи в словаре. */
  readonly reason: string;
}

export async function recordMisunderstood(
  db: Executor,
  params: MisunderstoodToRecord,
): Promise<void> {
  await db.insert(misunderstood).values({
    userId: params.userId,
    batchId: params.batchId ?? null,
    said: params.said,
    replied: params.replied,
    reason: params.reason,
  });
}

/** Сколько раз бот сдался с момента `since`. */
export async function misunderstoodCount(db: Executor, since: Date): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(misunderstood)
    .where(gte(misunderstood.createdAt, since));

  return row?.total ?? 0;
}

export interface MisunderstoodRow {
  readonly at: Date;
  /** Имя человека, как в списке людей; без имени — телеграмное. */
  readonly who: string;
  readonly userId: string;
  readonly said: string;
  readonly replied: string;
  readonly reason: string;
}

/** Список за период, свежее сверху. Предел — чтобы страница не росла без края. */
export async function misunderstoodList(
  db: Executor,
  params: { readonly days: number; readonly limit?: number },
): Promise<MisunderstoodRow[]> {
  const since = new Date(Date.now() - params.days * 24 * 3_600_000);

  const rows = await db
    .select({
      at: misunderstood.createdAt,
      firstName: users.firstName,
      username: users.username,
      userId: misunderstood.userId,
      said: misunderstood.said,
      replied: misunderstood.replied,
      reason: misunderstood.reason,
    })
    .from(misunderstood)
    .innerJoin(users, eq(users.id, misunderstood.userId))
    .where(gte(misunderstood.createdAt, since))
    .orderBy(desc(misunderstood.createdAt))
    .limit(params.limit ?? 200);

  return rows.map((row) => ({
    at: row.at,
    who: row.firstName ?? row.username ?? '—',
    userId: row.userId,
    said: row.said,
    replied: row.replied,
    reason: row.reason,
  }));
}
