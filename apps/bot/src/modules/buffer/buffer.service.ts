import { and, asc, eq, gte, sql } from 'drizzle-orm';

import type { Database, Executor } from '../../infra/db.js';
import { batches, messagesRaw, type Batch } from '../../db/schema.js';

/**
 * Буфер выгрузки и окно тишины (задачи 1.12 и 1.13).
 *
 * §9.1 правило 2 ТЗ: серия сообщений — это одна мысль. Сообщения копятся
 * в открытую выгрузку, каждое новое перезапускает ожидание тишины.
 * Несколько голосовых подряд дают один разбор и один ответ.
 */

export interface BufferLimits {
  /** Сколько молчать, прежде чем считать выгрузку законченной. */
  readonly silenceWindowMs: number;
  /** Жёсткий потолок: выгрузка не может быть открыта вечно. */
  readonly maxBatchAgeMs: number;
  readonly maxMessagesPerBatch: number;
  /** §10.5 ТЗ: ограничение частоты выгрузок на пользователя. */
  readonly maxDumpsPerDay: number;
}

export const DEFAULT_LIMITS: BufferLimits = {
  silenceWindowMs: 30_000,
  maxBatchAgeMs: 5 * 60_000,
  maxMessagesPerBatch: 15,
  maxDumpsPerDay: 30,
};

export type CloseReason = 'silence' | 'message_limit' | 'age_limit';

export interface AttachResult {
  readonly batchId: string;
  /** Выгрузка закрыта прямо сейчас и готова к обработке. */
  readonly closed: boolean;
  readonly closeReason?: CloseReason;
  readonly messageCount: number;
}

/** Открытая выгрузка пользователя или новая, если открытой нет. */
async function openBatchFor(tx: Executor, userId: string, now: Date): Promise<Batch> {
  // Частичный уникальный индекс не даёт создать вторую открытую выгрузку,
  // поэтому гонка двух воркеров разрешается базой: проигравший увидит
  // конфликт и прочитает уже созданную выгрузку.
  const [created] = await tx
    .insert(batches)
    .values({ userId, openedAt: now, lastMessageAt: now })
    .onConflictDoNothing({
      target: batches.userId,
      // Предикат частичного индекса: без него Postgres не поймёт,
      // с каким именно уникальным ограничением сверять конфликт.
      where: sql`${batches.status} = 'open'`,
    })
    .returning();

  if (created) return created;

  const [existing] = await tx
    .select()
    .from(batches)
    .where(and(eq(batches.userId, userId), eq(batches.status, 'open')))
    .limit(1);

  if (!existing) {
    throw new Error('Открытая выгрузка не найдена после конфликта вставки');
  }

  return existing;
}

/**
 * Присоединяет сообщение к открытой выгрузке. Закрывает её, если достигнут
 * потолок по числу сообщений или по возрасту.
 */
export async function attachMessageToBatch(
  db: Database,
  params: {
    readonly userId: string;
    readonly messageId: string;
    readonly now?: Date;
    readonly limits?: BufferLimits;
  },
): Promise<AttachResult> {
  const limits = params.limits ?? DEFAULT_LIMITS;
  const now = params.now ?? new Date();

  return await db.transaction(async (tx): Promise<AttachResult> => {
    const batch = await openBatchFor(tx, params.userId, now);

    await tx
      .update(messagesRaw)
      .set({ batchId: batch.id })
      .where(eq(messagesRaw.id, params.messageId));

    const messageCount = batch.messageCount + 1;
    const ageMs = now.getTime() - batch.openedAt.getTime();

    const closeReason: CloseReason | undefined =
      messageCount >= limits.maxMessagesPerBatch
        ? 'message_limit'
        : ageMs >= limits.maxBatchAgeMs
          ? 'age_limit'
          : undefined;

    await tx
      .update(batches)
      .set({
        messageCount,
        lastMessageAt: now,
        ...(closeReason ? { status: 'queued' as const, closedAt: now } : {}),
      })
      .where(eq(batches.id, batch.id));

    return {
      batchId: batch.id,
      closed: closeReason !== undefined,
      ...(closeReason ? { closeReason } : {}),
      messageCount,
    };
  });
}

/**
 * Закрывает выгрузку по тишине. Вызывается отложенным заданием.
 *
 * Проверка «последнее сообщение было давно» обязательна: задание могло
 * быть поставлено до того, как пришло очередное сообщение. Без неё
 * выгрузка закрылась бы посреди речи.
 */
export async function closeBatchOnSilence(
  db: Executor,
  batchId: string,
  params: { readonly now?: Date; readonly silenceWindowMs?: number } = {},
): Promise<boolean> {
  const now = params.now ?? new Date();
  const windowMs = params.silenceWindowMs ?? DEFAULT_LIMITS.silenceWindowMs;
  const threshold = new Date(now.getTime() - windowMs);

  const closed = await db
    .update(batches)
    .set({ status: 'queued', closedAt: now })
    .where(
      and(
        eq(batches.id, batchId),
        eq(batches.status, 'open'),
        sql`${batches.lastMessageAt} <= ${threshold}`,
      ),
    )
    .returning({ id: batches.id });

  return closed.length > 0;
}

/**
 * Склейка выгрузки (задача 1.13): расшифровки и тексты в порядке получения.
 *
 * Сообщения без содержимого пропускаются: стикер или неразобранное
 * вложение не должны вставлять пустую строку в середину мысли.
 */
export async function combineBatch(db: Executor, batchId: string): Promise<string> {
  const rows = await db
    .select({
      text: messagesRaw.text,
      transcript: messagesRaw.transcript,
    })
    .from(messagesRaw)
    .where(eq(messagesRaw.batchId, batchId))
    .orderBy(asc(messagesRaw.receivedAt), asc(messagesRaw.tgMessageId));

  const parts = rows
    .map((row) => (row.transcript ?? row.text ?? '').trim())
    .filter((part) => part !== '');

  const combined = parts.join('\n');

  await db.update(batches).set({ combinedText: combined }).where(eq(batches.id, batchId));

  return combined;
}

/** §10.5 ТЗ: сколько выгрузок пользователь сделал за последние сутки. */
export async function countRecentDumps(db: Executor, userId: string, since: Date): Promise<number> {
  const rows = await db
    .select({ id: batches.id })
    .from(batches)
    .where(and(eq(batches.userId, userId), gte(batches.openedAt, since)));

  return rows.length;
}

export async function isOverDumpLimit(
  db: Executor,
  userId: string,
  params: { readonly now?: Date; readonly limits?: BufferLimits } = {},
): Promise<boolean> {
  const limits = params.limits ?? DEFAULT_LIMITS;
  const now = params.now ?? new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60_000);

  return (await countRecentDumps(db, userId, since)) >= limits.maxDumpsPerDay;
}
