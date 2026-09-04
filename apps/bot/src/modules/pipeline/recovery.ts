import { and, eq, lt, or, sql } from 'drizzle-orm';

import { batches } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { DEFAULT_LIMITS, type BufferLimits } from '../buffer/buffer.service.js';

/**
 * Восстановление после перезапуска (задача 1.18).
 *
 * §9.1 правило 4 ТЗ: выгрузки в обработке переподхватываются при старте
 * сервиса, незавершённая обработка возобновляется, а не теряется.
 *
 * Второй сценарий, которого в §17 ТЗ нет: потеря Redis. Очередь и
 * отложенные задания живут там, и после очистки Redis открытая выгрузка
 * никогда не закроется — закрывающее задание исчезло вместе с очередью.
 * Поэтому при старте мы дозакрываем всё, что провисело дольше потолка.
 */

export interface RecoveryReport {
  /** Выгрузки, застрявшие в обработке из-за падения процесса. */
  readonly requeuedProcessing: number;
  /** Открытые выгрузки, чьё закрывающее задание потерялось. */
  readonly closedOrphanedOpen: number;
  /** Пользователи, которых надо поставить в очередь заново. */
  readonly userIds: readonly string[];
}

export async function recoverStuckBatches(
  db: Database,
  params: { readonly now?: Date; readonly limits?: BufferLimits } = {},
): Promise<RecoveryReport> {
  const now = params.now ?? new Date();
  const limits = params.limits ?? DEFAULT_LIMITS;

  return await db.transaction(async (tx): Promise<RecoveryReport> => {
    /**
     * Процесс умер посреди обработки: статус processing остался висеть.
     * Возвращаем в очередь — обработка идемпотентна на уровне выгрузки.
     *
     * **Но только застрявшую, а не идущую.** Досмотр зовёт это правило
     * каждые полминуты, и без порога оно возвращало в очередь живой
     * разбор: боевое 04.09.2026, 18:25:31 — выгрузка закрыта в 18:24:49,
     * разбор шёл, и через сорок секунд досмотр счёл его умершим. Замок на
     * пользователя спас от двойного ответа, но журнал врал «очередь
     * забыла», а с потерянным замком ответ пришёл бы дважды.
     *
     * Возраст считается от закрытия: обработка начинается сразу за ним.
     * Открытая дата — на случай выгрузки, закрытой не через очередь.
     */
    const processingThreshold = new Date(now.getTime() - limits.maxProcessingMs);

    const requeued = await tx
      .update(batches)
      .set({ status: 'queued' })
      .where(
        and(
          eq(batches.status, 'processing'),
          sql`coalesce(${batches.closedAt}, ${batches.openedAt}) <= ${processingThreshold}`,
        ),
      )
      .returning({ userId: batches.userId });

    // Открытая выгрузка старше жёсткого потолка: либо Redis потерял
    // задание, либо процесс не дожил до его постановки. Закрываем.
    const staleThreshold = new Date(now.getTime() - limits.maxBatchAgeMs);
    const silenceThreshold = new Date(now.getTime() - limits.silenceWindowMs);

    const closed = await tx
      .update(batches)
      .set({ status: 'queued', closedAt: now })
      .where(
        and(
          eq(batches.status, 'open'),
          or(
            lt(batches.openedAt, staleThreshold),
            sql`${batches.lastMessageAt} <= ${silenceThreshold}`,
          ),
        ),
      )
      .returning({ userId: batches.userId });

    const userIds = [...new Set([...requeued, ...closed].map((row) => row.userId))];

    return {
      requeuedProcessing: requeued.length,
      closedOrphanedOpen: closed.length,
      userIds,
    };
  });
}
