import { and, asc, eq } from 'drizzle-orm';

import { batches, type Batch } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import type { RedisLock } from '../../infra/lock.js';
import { combineBatch } from '../buffer/buffer.service.js';

/**
 * Последовательная обработка выгрузок пользователя (задача 1.11).
 *
 * §9.1 ТЗ: обработка внутри одного пользователя строго последовательна,
 * и вторая выгрузка видит всё, что успела создать первая.
 *
 * Задание в очереди несёт только идентификатор пользователя, а не выгрузки.
 * Порядок берётся из базы: под замком обрабатываются все накопившиеся
 * выгрузки по возрастанию времени открытия. Поэтому перестановка заданий
 * в очереди не может нарушить порядок разбора.
 */

/** Что делать с закрытой выгрузкой. На этапе 2 сюда встанет разбор. */
export type BatchHandler = (db: Database, batch: Batch) => Promise<void>;

export interface PipelineDeps {
  readonly db: Database;
  readonly lock: RedisLock;
  readonly handleBatch?: BatchHandler;
  readonly lockTtlMs?: number;
}

export interface ProcessUserResult {
  /** Сколько выгрузок обработано за этот заход. */
  readonly processed: number;
  /** Замок занят другим воркером: работу выполнит он. */
  readonly skipped: boolean;
}

/** Обработка по умолчанию для этапа 1: склейка текста выгрузки. */
const combineOnly: BatchHandler = async (db, batch) => {
  await combineBatch(db, batch.id);
};

async function nextQueuedBatch(db: Database, userId: string): Promise<Batch | undefined> {
  const [batch] = await db
    .select()
    .from(batches)
    .where(and(eq(batches.userId, userId), eq(batches.status, 'queued')))
    .orderBy(asc(batches.openedAt))
    .limit(1);

  return batch;
}

export async function processUserBatches(
  deps: PipelineDeps,
  userId: string,
): Promise<ProcessUserResult> {
  const { db, lock } = deps;
  const handle = deps.handleBatch ?? combineOnly;

  const outcome = await lock.withLock(
    `user:${userId}`,
    async () => {
      let processed = 0;

      // Цикл, а не одна выгрузка: пока мы работали, могла закрыться
      // следующая. Забирать её сразу дешевле, чем ждать нового задания.
      for (;;) {
        const batch = await nextQueuedBatch(db, userId);
        if (!batch) break;

        await db.update(batches).set({ status: 'processing' }).where(eq(batches.id, batch.id));

        try {
          await handle(db, batch);
          await db
            .update(batches)
            .set({ status: 'done', processedAt: new Date(), error: null })
            .where(eq(batches.id, batch.id));
        } catch (error) {
          // Выгрузка помечается сбойной, но не теряется: её видно
          // в админке и можно перезапустить (§17 ТЗ).
          await db
            .update(batches)
            .set({
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            })
            .where(eq(batches.id, batch.id));
          throw error;
        }

        processed++;
      }

      return processed;
    },
    deps.lockTtlMs === undefined ? {} : { ttlMs: deps.lockTtlMs },
  );

  return outcome.acquired
    ? { processed: outcome.result, skipped: false }
    : { processed: 0, skipped: true };
}
