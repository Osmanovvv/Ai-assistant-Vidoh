import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, messagesRaw } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { attachMessageToBatch } from '../buffer/buffer.service.js';
import { upsertUser } from '../users/users.repo.js';
import { sweepOnce } from './sweeper.js';

/**
 * Досмотр застрявших выгрузок.
 *
 * Проверяется то, ради чего он появился: выгрузка, о которой очередь
 * забыла, всё равно доходит до обработки — без перезапуска сервиса.
 */

const logger = createLogger({ level: 'silent' });

const T0 = new Date('2026-08-25T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

let userId: string;
let seq = 0;

beforeEach(async () => {
  const user = await upsertUser(testDb(), { tgId: 800, firstName: 'Аня' });
  userId = user.id;
  seq = 0;
});

/** Открытая выгрузка с одним сообщением, полученным в заданный момент. */
async function openBatchAt(offsetMs: number): Promise<string> {
  seq++;
  const [row] = await testDb()
    .insert(messagesRaw)
    .values({
      userId,
      updateId: 8000 + seq,
      tgChatId: 800,
      tgMessageId: seq,
      kind: 'text',
      text: 'мысль',
      receivedAt: at(offsetMs),
    })
    .returning({ id: messagesRaw.id });

  const attached = await attachMessageToBatch(testDb(), {
    userId,
    messageId: row!.id,
    now: at(offsetMs),
  });

  return attached.batchId;
}

async function statusOf(batchId: string): Promise<string | undefined> {
  const [row] = await testDb()
    .select({ status: batches.status })
    .from(batches)
    .where(eq(batches.id, batchId));
  return row?.status;
}

describe('sweepOnce', () => {
  it('подбирает выгрузку, о которой очередь забыла', async () => {
    // Ровно тот случай, ради которого досмотр появился: после перезапуска
    // Redis воркер перестал разбирать отложенные задания, и выгрузка
    // висела бы открытой вечно.
    const batchId = await openBatchAt(0);
    const processed: string[] = [];

    const result = await sweepOnce({
      db: testDb(),
      logger,
      // Тишина уже прошла: последнее сообщение было минуту назад.
      now: () => at(60_000),
      process: (id) => {
        processed.push(id);
        return Promise.resolve();
      },
    });

    expect(result.closed).toBe(1);
    expect(processed).toEqual([userId]);
    expect(await statusOf(batchId)).toBe('queued');
  });

  it('не трогает выгрузку, в которую только что писали', async () => {
    // Иначе досмотр закрывал бы мысль на полуслове.
    const batchId = await openBatchAt(0);
    const processed: string[] = [];

    const result = await sweepOnce({
      db: testDb(),
      logger,
      now: () => at(5_000),
      process: (id) => {
        processed.push(id);
        return Promise.resolve();
      },
    });

    expect(result.users).toBe(0);
    expect(processed).toEqual([]);
    expect(await statusOf(batchId)).toBe('open');
  });

  it('возвращает в очередь выгрузку, застрявшую в обработке', async () => {
    const batchId = await openBatchAt(0);
    await testDb().update(batches).set({ status: 'processing' }).where(eq(batches.id, batchId));

    const result = await sweepOnce({
      db: testDb(),
      logger,
      // Потолок обработки три минуты; четыре — точно застряла (задача 3.58).
      now: () => at(4 * 60_000),
      process: () => Promise.resolve(),
    });

    expect(result.requeued).toBe(1);
    expect(await statusOf(batchId)).toBe('queued');
  });

  it('живую обработку не трогает', async () => {
    /**
     * Боевое 04.09.2026, 18:25:31: досмотр вернул в очередь выгрузку,
     * разбор которой шёл и закончился через четыре секунды. Замок на
     * пользователя спас от двойного ответа, но журнал врал «очередь
     * забыла».
     */
    const batchId = await openBatchAt(0);
    await testDb().update(batches).set({ status: 'processing' }).where(eq(batches.id, batchId));

    const result = await sweepOnce({
      db: testDb(),
      logger,
      now: () => at(60_000),
      process: () => Promise.resolve(),
    });

    expect(result.requeued).toBe(0);
    expect(await statusOf(batchId)).toBe('processing');
  });

  it('на пустой базе ничего не делает и никого не будит', async () => {
    const processed: string[] = [];

    const result = await sweepOnce({
      db: testDb(),
      logger,
      process: (id) => {
        processed.push(id);
        return Promise.resolve();
      },
    });

    expect(result).toEqual({ requeued: 0, closed: 0, users: 0 });
    expect(processed).toEqual([]);
  });

  it('сбой на одном пользователе не останавливает остальных', async () => {
    // Досмотр — последний рубеж. Если он падает на первом же споткнувшемся
    // пользователе, остальные так и остаются без ответа.
    const first = await upsertUser(testDb(), { tgId: 801, firstName: 'Первая' });
    const second = await upsertUser(testDb(), { tgId: 802, firstName: 'Вторая' });

    for (const [index, user] of [first, second].entries()) {
      const [row] = await testDb()
        .insert(messagesRaw)
        .values({
          userId: user.id,
          updateId: 8100 + index,
          tgChatId: 801 + index,
          tgMessageId: 900 + index,
          kind: 'text',
          text: 'мысль',
          receivedAt: at(0),
        })
        .returning({ id: messagesRaw.id });

      await attachMessageToBatch(testDb(), { userId: user.id, messageId: row!.id, now: at(0) });
    }

    const seen: string[] = [];

    const result = await sweepOnce({
      db: testDb(),
      logger,
      now: () => at(60_000),
      process: (id) => {
        seen.push(id);
        return seen.length === 1
          ? Promise.reject(new Error('база моргнула'))
          : Promise.resolve(undefined);
      },
    });

    expect(result.users).toBe(2);
    expect(seen).toHaveLength(2);
  });

  it('подбирает выгрузку, оставшуюся в очереди без задания', async () => {
    // Временный сбой возвращает выгрузку в очередь. Если задание при этом
    // потерялось, подобрать её больше некому — кроме досмотра.
    const batchId = await openBatchAt(0);
    await testDb().update(batches).set({ status: 'queued' }).where(eq(batches.id, batchId));

    const processed: string[] = [];

    const result = await sweepOnce({
      db: testDb(),
      logger,
      process: (id) => {
        processed.push(id);
        return Promise.resolve();
      },
    });

    expect(result.users).toBe(1);
    expect(processed).toEqual([userId]);
  });
});
