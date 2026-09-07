import type { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createBroadcastQueue,
  createBroadcastWorker,
  enqueueBroadcast,
  type BroadcastJob,
} from './queue.js';
import { createRedis } from './redis.js';

/**
 * Очередь рассылки на живом Redis (§15 ТЗ, задача 4.10).
 *
 * **Проверка написана из-за настоящей ошибки, найденной в этой же
 * задаче.** Задание рассылки имело свой идентификатор — по
 * идентификатору рассылки, — чтобы две нажатые кнопки не дали двух
 * заданий. Казалось разумным. Но заход рассылки ставит себя снова, когда
 * порция кончилась, а старое задание в этот момент **ещё
 * выполняется**, — и BullMQ на повторный идентификатор молча отвечает
 * «такое уже есть». Рассылка на тысячу адресов встала бы на второй
 * сотне навсегда, и в панели это выглядело бы как «идёт».
 *
 * Ни один тест на самой рассылке этого не увидел бы: там `sendChunk`
 * зовут в цикле руками. Отсюда то же правило, что и у очереди разбора:
 * постановка задания проверяется настоящей постановкой задания.
 */

const PREFIX = 'test-broadcast';

const redis: Redis = createRedis(process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379', {
  maxReconnectAttempts: 3,
});

let queue: Queue<BroadcastJob>;
const workers: Worker<BroadcastJob>[] = [];

beforeEach(async () => {
  queue = createBroadcastQueue(redis, { prefix: PREFIX });
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

const BROADCAST = '5c7f1a2b-3d4e-4f50-8a9b-0c1d2e3f4a5b';

/** Ждёт условия, пока не сбудется. Воркер работает своим темпом. */
async function until(what: () => boolean, why: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (what()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`не сбылось за пять секунд: ${why}`);
}

describe('очередь рассылки', () => {
  it('ставит задание с идентификатором рассылки', async () => {
    await enqueueBroadcast(queue, BROADCAST);

    const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ kind: 'send', broadcastId: BROADCAST });
  });

  it('заход, поставивший себя снова, действительно продолжается', async () => {
    /**
     * **Главное здесь.** Воркер ставит следующий заход **изнутри
     * обработчика**, то есть пока текущее задание ещё живо. Именно на
     * этом и ломалась рассылка со своим идентификатором задания.
     *
     * Три захода: первый и второй просят продолжения, третий — нет.
     */
    const seen: number[] = [];

    workers.push(
      createBroadcastWorker(
        redis,
        async (job) => {
          seen.push(seen.length + 1);

          if (seen.length < 3) await enqueueBroadcast(queue, job.data.broadcastId);
        },
        { prefix: PREFIX },
      ),
    );

    await enqueueBroadcast(queue, BROADCAST);

    await until(() => seen.length === 3, 'три захода рассылки');

    expect(seen).toEqual([1, 2, 3]);
  });

  it('одна рассылка за раз: два задания не идут одновременно', async () => {
    /**
     * Два воркера на одной рассылке — это два сообщения одному человеку
     * и удвоенная частота обращений к Telegram, то есть 429 при верно
     * заданном темпе. Одновременность воркера единица, и вот проверка.
     */
    let inside = 0;
    let together = 0;

    workers.push(
      createBroadcastWorker(
        redis,
        async () => {
          inside++;
          if (inside > 1) together++;
          await new Promise((resolve) => setTimeout(resolve, 60));
          inside--;
        },
        { prefix: PREFIX },
      ),
    );

    await enqueueBroadcast(queue, BROADCAST);
    await enqueueBroadcast(queue, BROADCAST);
    await enqueueBroadcast(queue, BROADCAST);

    // Счётчик выполненных растёт по мере работы воркера: опрос, а не
    // таймаут — иначе проверка либо флакала бы, либо ждала впустую.
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await queue.getCompletedCount()) === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(await queue.getCompletedCount()).toBe(3);
    expect(together).toBe(0);
  });
});
