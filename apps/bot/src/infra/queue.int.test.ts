import type { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeJobId,
  createQueue,
  createWorker,
  enqueueUserProcessing,
  scheduleBatchClose,
  type PipelineJob,
} from './queue.js';
import { createRedis } from './redis.js';

/**
 * Очередь на живом Redis (задачи 1.11 и 1.24).
 *
 * Этих тестов не было, и зря. Идентификатор задания закрытия содержал
 * двоеточие, BullMQ такие отвергает, и бот падал на первом же входящем
 * сообщении. Всё остальное было покрыто тестами по отдельности, а связка
 * с очередью — нет, поэтому ошибка дожила до боевого сервера.
 *
 * Отсюда правило: постановка задания проверяется настоящей постановкой
 * задания, а не тем, что функция вернула строку нужного вида.
 */

const PREFIX = 'test-queue';

const redis: Redis = createRedis(process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379', {
  maxReconnectAttempts: 3,
});

let queue: Queue<PipelineJob>;
const workers: Worker<PipelineJob>[] = [];

beforeEach(async () => {
  queue = createQueue(redis, { prefix: PREFIX });
  await queue.obliterate({ force: true });
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
});

afterAll(async () => {
  await redis.quit();
});

const BATCH = '0b4d1f2e-8a3c-4f5b-9d6e-7a8b9c0d1e2f';
const USER = 'f1e2d3c4-b5a6-4978-8765-43210fedcba9';

describe('scheduleBatchClose', () => {
  it('ставит задание в очередь', async () => {
    // Тот самый случай: с двоеточием в идентификаторе BullMQ бросает
    // «Custom Id cannot contain :», и обработка входящего обрывается.
    await scheduleBatchClose(queue, { batchId: BATCH, userId: USER, delayMs: 30_000 });

    const job = await queue.getJob(closeJobId(BATCH));

    expect(job).toBeDefined();
    expect(job?.data).toEqual({ kind: 'close-batch', batchId: BATCH, userId: USER });
  });

  it('переставляет срок, а не плодит задания', async () => {
    // §9.1 правило 2 ТЗ: каждое новое сообщение отодвигает закрытие.
    await scheduleBatchClose(queue, { batchId: BATCH, userId: USER, delayMs: 30_000 });
    await scheduleBatchClose(queue, { batchId: BATCH, userId: USER, delayMs: 30_000 });
    await scheduleBatchClose(queue, { batchId: BATCH, userId: USER, delayMs: 30_000 });

    expect(await queue.getDelayedCount()).toBe(1);
  });

  it('разным выгрузкам — разные задания', async () => {
    const other = '11112222-3333-4444-5555-666677778888';

    await scheduleBatchClose(queue, { batchId: BATCH, userId: USER, delayMs: 30_000 });
    await scheduleBatchClose(queue, { batchId: other, userId: USER, delayMs: 30_000 });

    expect(await queue.getDelayedCount()).toBe(2);
  });
});

describe('enqueueUserProcessing', () => {
  it('ставит задание на разбор', async () => {
    const job = await enqueueUserProcessing(queue, USER);

    expect(job.data).toEqual({ kind: 'process-user', userId: USER });
    expect(await queue.getWaitingCount()).toBe(1);
  });
});

describe('очередь и воркер вместе', () => {
  /** Ждёт, пока воркер обработает задание, но не дольше срока. */
  function waitFor<T>(register: (resolve: (value: T) => void) => void, ms = 10_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`не дождались за ${String(ms)} мс`));
      }, ms);

      register((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  it('воркер получает задание и его данные', async () => {
    // Связка «очередь → воркер» до сих пор проверялась только руками.
    const received = waitFor<PipelineJob>((resolve) => {
      const worker = createWorker(
        redis,
        (job) => {
          resolve(job.data);
          return Promise.resolve();
        },
        { prefix: PREFIX, concurrency: 1 },
      );
      workers.push(worker);
    });

    await enqueueUserProcessing(queue, USER);

    expect(await received).toEqual({ kind: 'process-user', userId: USER });
  });

  it('отложенное закрытие доезжает до воркера, когда срок вышел', async () => {
    const received = waitFor<PipelineJob>((resolve) => {
      const worker = createWorker(
        redis,
        (job) => {
          resolve(job.data);
          return Promise.resolve();
        },
        { prefix: PREFIX, concurrency: 1 },
      );
      workers.push(worker);
    });

    // Короткая задержка вместо тридцати секунд: проверяется механизм,
    // а не конкретное окно тишины.
    await scheduleBatchClose(queue, { batchId: BATCH, userId: USER, delayMs: 300 });

    expect(await received).toEqual({ kind: 'close-batch', batchId: BATCH, userId: USER });
  });
});
