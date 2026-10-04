import { and, eq, inArray } from 'drizzle-orm';

import { items, type Item } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { recordRevision } from './revisions.repo.js';

/** Результат безопасной групповой правки срока. */
export type BulkDeadlineOutcome =
  | {
      readonly kind: 'applied';
      readonly changed: readonly Item[];
      readonly unchanged: readonly Item[];
    }
  | { readonly kind: 'missing' };

/**
 * Ставит один и тот же день выбранным делам одной транзакцией.
 *
 * Все цели сначала блокируются и проверяются. Если хотя бы одна исчезла,
 * транзакция ничего не меняет — частичное назначение даты человеку нельзя
 * выдавать за успешное.
 */
export async function applyBulkDeadline(
  db: Executor,
  params: {
    readonly userId: string;
    readonly itemIds: readonly string[];
    readonly deadlineAt: Date;
    readonly sourceMessageId?: string | undefined;
    readonly now?: Date | undefined;
  },
): Promise<BulkDeadlineOutcome> {
  const ids = [...new Set(params.itemIds)];
  if (ids.length === 0) return { kind: 'missing' };
  const now = params.now ?? new Date();

  return await db.transaction(async (tx): Promise<BulkDeadlineOutcome> => {
    const rows = await tx
      .select()
      .from(items)
      .where(and(eq(items.userId, params.userId), inArray(items.id, ids)))
      .for('update');

    if (rows.length !== ids.length) return { kind: 'missing' };

    const changed: Item[] = [];
    const unchanged: Item[] = [];

    for (const row of rows) {
      if (
        row.deadlineAt?.getTime() === params.deadlineAt.getTime() &&
        row.deadlineAccuracy === 'day'
      ) {
        unchanged.push(row);
        continue;
      }

      const [after] = await tx
        .update(items)
        .set({ deadlineAt: params.deadlineAt, deadlineAccuracy: 'day', updatedAt: now })
        .where(and(eq(items.id, row.id), eq(items.userId, params.userId)))
        .returning();

      if (after === undefined) return { kind: 'missing' };
      await recordRevision(tx, {
        itemId: row.id,
        userId: params.userId,
        changedBy: 'resolver',
        before: row,
        after,
        reason: 'дата назначена группе дел из ответа на сообщение',
        sourceMessageId: params.sourceMessageId,
      });
      changed.push(after);
    }

    return { kind: 'applied', changed, unchanged };
  });
}
