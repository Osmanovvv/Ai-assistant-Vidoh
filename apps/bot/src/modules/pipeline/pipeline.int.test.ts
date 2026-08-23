import { setTimeout as delay } from 'node:timers/promises';

import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { batches, messagesRaw, type Batch } from '../../db/schema.js';
import { RedisLock } from '../../infra/lock.js';
import { createRedis } from '../../infra/redis.js';
import { testDb } from '../../test/db.js';
import { attachMessageToBatch, closeBatchOnSilence } from '../buffer/buffer.service.js';
import { upsertUser } from '../users/users.repo.js';
import { processUserBatches } from './pipeline.service.js';

const redis: Redis = createRedis(process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379');
const lock = new RedisLock(redis, 'test-pipe:');

const T0 = new Date('2026-08-23T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

let userId: string;
let seq = 0;

beforeEach(async () => {
  const keys = await redis.keys('test-pipe:*');
  if (keys.length > 0) await redis.del(...keys);
  const user = await upsertUser(testDb(), { tgId: 500, firstName: 'Аня' });
  userId = user.id;
  seq = 0;
});

afterAll(async () => {
  await redis.quit();
});

/** Готовая к обработке выгрузка с одним сообщением. */
async function queuedBatch(text: string, offsetMs: number): Promise<string> {
  seq++;
  const [message] = await testDb()
    .insert(messagesRaw)
    .values({
      userId,
      updateId: 9000 + seq,
      tgChatId: 500,
      tgMessageId: seq,
      kind: 'text',
      text,
      receivedAt: at(offsetMs),
    })
    .returning({ id: messagesRaw.id });

  const { batchId } = await attachMessageToBatch(testDb(), {
    userId,
    messageId: message!.id,
    now: at(offsetMs),
  });
  await closeBatchOnSilence(testDb(), batchId, { now: at(offsetMs + 31_000) });
  return batchId;
}

async function batchById(id: string): Promise<Batch | undefined> {
  const [row] = await testDb().select().from(batches).where(eq(batches.id, id));
  return row;
}

describe('processUserBatches', () => {
  it('обрабатывает готовую выгрузку и склеивает текст', async () => {
    const batchId = await queuedBatch('купить продукты', 0);

    const result = await processUserBatches({ db: testDb(), lock }, userId);

    expect(result).toEqual({ processed: 1, skipped: false });
    const batch = await batchById(batchId);
    expect(batch?.status).toBe('done');
    expect(batch?.combinedText).toBe('купить продукты');
    expect(batch?.processedAt).toBeInstanceOf(Date);
  });

  it('ничего не делает, когда готовых выгрузок нет', async () => {
    await expect(processUserBatches({ db: testDb(), lock }, userId)).resolves.toEqual({
      processed: 0,
      skipped: false,
    });
  });

  it('обрабатывает накопившиеся выгрузки в порядке открытия', async () => {
    const order: string[] = [];
    const first = await queuedBatch('первая', 0);
    const second = await queuedBatch('вторая', 60_000);

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: (_db, batch) => {
          order.push(batch.id);
          return Promise.resolve();
        },
      },
      userId,
    );

    expect(order).toEqual([first, second]);
  });

  it('за один заход забирает выгрузку, закрывшуюся во время работы', async () => {
    await queuedBatch('первая', 0);

    let handled = 0;
    const result = await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: async () => {
          handled++;
          // Пока обрабатываем первую, пользователь прислал вторую.
          if (handled === 1) await queuedBatch('вторая', 60_000);
        },
      },
      userId,
    );

    expect(result.processed).toBe(2);
  });

  it('второй воркер не лезет в работу первого', async () => {
    await queuedBatch('первая', 0);

    const slow = processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: async () => {
          await delay(150);
        },
        lockTtlMs: 5_000,
      },
      userId,
    );
    await delay(30);

    const second = await processUserBatches({ db: testDb(), lock }, userId);
    await slow;

    expect(second).toEqual({ processed: 0, skipped: true });
  });

  it('сбой обработки помечает выгрузку и не теряет её', async () => {
    const batchId = await queuedBatch('сломается', 0);

    await expect(
      processUserBatches(
        { db: testDb(), lock, handleBatch: () => Promise.reject(new Error('модель недоступна')) },
        userId,
      ),
    ).rejects.toThrow('модель недоступна');

    const batch = await batchById(batchId);
    expect(batch?.status).toBe('failed');
    expect(batch?.error).toBe('модель недоступна');
  });

  it('замок освобождается после сбоя, следующий заход работает', async () => {
    await queuedBatch('сломается', 0);

    await expect(
      processUserBatches(
        { db: testDb(), lock, handleBatch: () => Promise.reject(new Error('сбой')) },
        userId,
      ),
    ).rejects.toThrow();

    // Замок не залип: заход проходит, просто сбойная выгрузка уже не queued.
    await expect(processUserBatches({ db: testDb(), lock }, userId)).resolves.toEqual({
      processed: 0,
      skipped: false,
    });
  });

  it('выгрузки разных пользователей не блокируют друг друга', async () => {
    const other = await upsertUser(testDb(), { tgId: 501, firstName: 'Оля' });
    await queuedBatch('моя', 0);

    const [mine, theirs] = await Promise.all([
      processUserBatches({ db: testDb(), lock }, userId),
      processUserBatches({ db: testDb(), lock }, other.id),
    ]);

    expect(mine.skipped).toBe(false);
    expect(theirs.skipped).toBe(false);
  });
});
