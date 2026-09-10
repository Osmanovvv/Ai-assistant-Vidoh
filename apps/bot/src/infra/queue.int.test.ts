import { setTimeout as delay } from 'node:timers/promises';

import type { Job, Queue, Worker } from 'bullmq';
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

/**
 * Момент, на который назначено закрытие выгрузки: время постановки плюс
 * задержка. Именно он и есть охраняемое свойство переставки — счётчик
 * заданий о нём не говорит ничего, потому что при сломанной переставке
 * задание остаётся ровно одно, просто со старым сроком.
 */
function dueAt(job: Job<PipelineJob>): number {
  return job.timestamp + (job.opts.delay ?? 0);
}

async function closeDueAt(): Promise<number> {
  const job = await queue.getJob(closeJobId(BATCH));
  if (!job) throw new Error('задание закрытия не найдено');

  return dueAt(job);
}

/** Обещание, которое разрешают снаружи: так тест держит задание активным. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  return { promise, resolve };
}

/** Ждёт, пока воркер добьёт взятое задание (успешно или с ошибкой). */
function waitForCompletion(worker: Worker<PipelineJob>, ms = 10_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`задание не завершилось за ${String(ms)} мс`));
    }, ms);

    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };

    worker.once('completed', done);
    worker.once('failed', done);
  });
}

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
    //
    // **Одного `getDelayedCount() === 1` мало.** Единица выходит и в
    // сломанном случае: BullMQ на повторный jobId молча отвечает «такое
    // уже есть» и оставляет задание с ПРЕЖНИМ сроком. Заданий по-прежнему
    // одно — а выгрузка закроется по первому сообщению вместо последнего,
    // то есть человека прервут на полуслове. Прежняя проверка срок задания
    // не читала ни разу, хотя переставку обещала названием: её оставляло
    // зелёной удаление всей переставки из `scheduleBatchClose`.
    //
    // Поэтому сверяется сам момент закрытия. Задержка каждый раз одна и та
    // же (в бою окно тишины постоянно) — двигаться должен момент, потому
    // что заново поставленное задание получает новое время постановки.
    await scheduleBatchClose(queue, { batchId: BATCH, userId: USER, delayMs: 30_000 });
    const first = await closeDueAt();

    await delay(50);
    await scheduleBatchClose(queue, { batchId: BATCH, userId: USER, delayMs: 30_000 });
    const second = await closeDueAt();

    await delay(50);
    await scheduleBatchClose(queue, { batchId: BATCH, userId: USER, delayMs: 30_000 });
    const third = await closeDueAt();

    expect(await queue.getDelayedCount()).toBe(1);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('переставляет срок, даже когда старое задание уже выполняется', async () => {
    /**
     * **Дефект закрыт; проверка стережёт починку.**
     *
     * Случай не выдуманный, а основной путь §9.1 правила 2:
     * `runCloseBatchJob` из close-job.ts, обнаружив, что человек дописал,
     * зовёт `reschedule` → `scheduleBatchClose` **из своего же активного
     * задания**. Задание переставляет само себя.
     *
     * Замерено на живом Redis: состояние задания в этот миг `active`,
     * `existing.remove()` бросает «could not be removed because it is
     * locked by another worker» (падение здесь глушится `.catch`), а
     * `queue.add` на занятый jobId молча возвращает то же активное
     * задание — в Redis не пишется ничего. Отложенных заданий по
     * выгрузке остаётся ноль: закрыть её больше нечему.
     *
     * Возвращённый `add` при этом **врёт**: у локального объекта Job
     * `opts.delay` равен запрошенному, хотя срок никуда не переставлен.
     * Поэтому проверка читает задание из Redis, а не то, что вернул add.
     *
     * **Ловушка, из-за которой правка делалась в двух местах сразу.**
     * Одной переставки мало: `closeBatchOnSilence` отдавал `false` и
     * когда выгрузка уже закрыта другим путём (потолок сообщений или
     * возраста в `attachMessageToBatch`), а `runCloseBatchJob` на любой
     * `false` переставлял задание. Прежде этот круг разрывал сам дефект.
     * Почини переставку, не научив `close-job.ts` различать «человек ещё
     * говорит» и «выгрузка уже закрыта», — и получишь задание, которое
     * переставляет себя каждое окно тишины и не кончается никогда.
     * Поэтому причина отказа теперь названа словом, а не булевым знаком.
     *
     * Прежняя проверка про этот путь не знала вовсе: она звала
     * `scheduleBatchClose` только на свободном задании.
     */
    const held = deferred();
    const active = deferred();

    const worker = createWorker(
      redis,
      async () => {
        active.resolve();
        await held.promise;
      },
      { prefix: PREFIX, concurrency: 1 },
    );
    workers.push(worker);

    // Короткий срок, чтобы воркер взял задание сейчас, а не через полминуты.
    await scheduleBatchClose(queue, { batchId: BATCH, userId: USER, delayMs: 30 });
    await active.promise;

    // Человек дописал, пока закрытие выполнялось: тишину ждём заново.
    await scheduleBatchClose(queue, { batchId: BATCH, userId: USER, delayMs: 30_000 });

    held.resolve();
    await waitForCompletion(worker);

    // Спрашивается не про конкретный jobId, а про сам факт: у выгрузки
    // осталось ровно одно назначенное закрытие, и назначено оно в
    // будущее. Так проверка не диктует, каким приёмом переставку
    // починят, — важно только, что закрытие не потеряно.
    const pending = (await queue.getDelayed()).filter(
      (job) => job.data.kind === 'close-batch' && job.data.batchId === BATCH,
    );

    expect(pending).toHaveLength(1);
    expect(dueAt(pending[0]!)).toBeGreaterThan(Date.now());
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
