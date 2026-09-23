import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm';

import { batches, items } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { SEARCHABLE_STATUSES } from '../embedder/embedder.service.js';
import { startsWithRecordCommand } from '../router/append.js';
import type { Candidate } from './candidates.js';

/**
 * О каком деле бот говорил в последний раз (живой прогон Никиты
 * 23.09.2026, 03:41 → 03:47).
 *
 * «Перенеси посылку на пол 1» — «Там уже так — менять нечего», через
 * шесть минут «Удали это дело» — «Какое дело?». «Это» считалось по
 * изменениям записи, а «менять нечего» запись не меняет. Для человека же
 * разговор был про посылку.
 *
 * Два следа последнего разговора, и берётся более поздний:
 *
 * 1. **Выгрузка** — дела, о которых бот говорил в ответе
 *    (`batches.mentioned_item_ids`): правка, «менять нечего», новые записи.
 * 2. **Правка записи** — кнопкой под напоминанием, в карточке: выгрузки у
 *    неё нет, есть только отметка времени изменения.
 *
 * Если оба следа об одном разговоре (в пределах минуты), дела
 * объединяются. Дел больше одного — «это» неоднозначно, и решать не нам.
 */

/** Разница, в пределах которой выгрузка и правка — один разговор. */
const SAME_TALK_MS = 60_000;

export async function lastDiscussed(
  db: Executor,
  params: {
    readonly userId: string;
    /** Текущая выгрузка — её собственные упоминания ещё не сохранены. */
    readonly batchId: string;
    readonly now: Date;
    readonly windowMs: number;
  },
): Promise<readonly Candidate[]> {
  const since = new Date(params.now.getTime() - params.windowMs);
  const talkedAt = sql<Date>`coalesce(${batches.closedAt}, ${batches.openedAt})`;

  const [talk] = await db
    .select({ ids: batches.mentionedItemIds, at: talkedAt })
    .from(batches)
    .where(
      and(
        eq(batches.userId, params.userId),
        ne(batches.id, params.batchId),
        isNotNull(batches.mentionedItemIds),
        sql`cardinality(${batches.mentionedItemIds}) > 0`,
        gte(talkedAt, since),
      ),
    )
    .orderBy(desc(talkedAt))
    .limit(1);

  const touched = await db
    .select({ id: items.id, updatedAt: items.updatedAt })
    .from(items)
    .where(
      and(
        eq(items.userId, params.userId),
        eq(items.isDraft, false),
        gte(items.updatedAt, since),
        inArray(items.status, [...SEARCHABLE_STATUSES]),
      ),
    )
    .orderBy(desc(items.updatedAt))
    .limit(10);

  const latestTouch = touched[0]?.updatedAt.getTime();
  const talkTime = talk === undefined ? undefined : new Date(talk.at).getTime();
  const recentTouches = (from: number): string[] =>
    touched.filter((one) => one.updatedAt.getTime() >= from - SAME_TALK_MS).map((one) => one.id);

  let ids: readonly string[];
  if (talkTime === undefined) {
    ids = latestTouch === undefined ? [] : recentTouches(latestTouch);
  } else if (latestTouch === undefined || latestTouch <= talkTime + SAME_TALK_MS) {
    ids = talk?.ids ?? [];
  } else {
    ids = recentTouches(latestTouch);
  }

  if (ids.length === 0) return [];

  const rows = await db
    .select({
      id: items.id,
      text: items.text,
      topic: items.topic,
      deadlineAt: items.deadlineAt,
      status: items.status,
      updatedAt: items.updatedAt,
    })
    .from(items)
    .where(
      and(
        eq(items.userId, params.userId),
        eq(items.isDraft, false),
        inArray(items.id, [...new Set(ids)]),
        inArray(items.status, [...SEARCHABLE_STATUSES]),
      ),
    );

  // Запись-эхо целью не бывает ни откуда (см. `candidates.ts`).
  return rows
    .filter((row) => !startsWithRecordCommand(row.text))
    .map((row) => ({ ...row, similarity: null, sources: ['session'] as const }));
}
