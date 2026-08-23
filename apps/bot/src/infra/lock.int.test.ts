import { setTimeout as delay } from 'node:timers/promises';

import type { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { RedisLock } from './lock.js';
import { createRedis } from './redis.js';

const url = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379';
const redis: Redis = createRedis(url);
const lock = new RedisLock(redis, 'test-lock:');

beforeEach(async () => {
  const keys = await redis.keys('test-lock:*');
  if (keys.length > 0) await redis.del(...keys);
});

afterAll(async () => {
  await redis.quit();
});

describe('acquire', () => {
  it('первый захват удаётся', async () => {
    await expect(lock.acquire('user:1')).resolves.not.toBeNull();
  });

  it('второй захват того же ключа не удаётся', async () => {
    await lock.acquire('user:1');

    await expect(lock.acquire('user:1')).resolves.toBeNull();
  });

  it('разные ключи не мешают друг другу', async () => {
    await expect(lock.acquire('user:1')).resolves.not.toBeNull();
    await expect(lock.acquire('user:2')).resolves.not.toBeNull();
  });

  it('замок освобождается по истечении срока', async () => {
    await lock.acquire('user:1', 120);

    await delay(200);

    await expect(lock.acquire('user:1')).resolves.not.toBeNull();
  });
});

describe('release', () => {
  it('снимает собственный замок', async () => {
    const handle = await lock.acquire('user:1');

    await expect(lock.release(handle!)).resolves.toBe(true);
    await expect(lock.acquire('user:1')).resolves.not.toBeNull();
  });

  it('не снимает чужой замок', async () => {
    await lock.acquire('user:1');
    // Токен другого воркера: попытка снять не должна пройти, иначе один
    // воркер отпустит замок другого и порядок обработки сломается.
    const foreign = { key: 'test-lock:user:1', token: 'чужой-токен' };

    await expect(lock.release(foreign)).resolves.toBe(false);
    await expect(lock.acquire('user:1')).resolves.toBeNull();
  });
});

describe('renew', () => {
  it('продлевает собственный замок', async () => {
    const handle = await lock.acquire('user:1', 150);

    await delay(100);
    await expect(lock.renew(handle!, 500)).resolves.toBe(true);
    await delay(150);

    // Без продления замок бы уже протух.
    await expect(lock.acquire('user:1')).resolves.toBeNull();
  });

  it('не продлевает чужой замок', async () => {
    await lock.acquire('user:1', 500);

    await expect(
      lock.renew({ key: 'test-lock:user:1', token: 'чужой-токен' }, 5_000),
    ).resolves.toBe(false);
  });

  it('не продлевает уже истёкший замок', async () => {
    const handle = await lock.acquire('user:1', 80);
    await delay(150);

    await expect(lock.renew(handle!, 1_000)).resolves.toBe(false);
  });
});

describe('withLock', () => {
  it('выполняет работу и возвращает результат', async () => {
    const outcome = await lock.withLock('user:1', () => Promise.resolve(42));

    expect(outcome).toEqual({ acquired: true, result: 42 });
  });

  it('освобождает замок после работы', async () => {
    await lock.withLock('user:1', () => Promise.resolve());

    await expect(lock.acquire('user:1')).resolves.not.toBeNull();
  });

  it('освобождает замок, даже если работа упала', async () => {
    await expect(
      lock.withLock('user:1', () => Promise.reject(new Error('сбой разбора'))),
    ).rejects.toThrow('сбой разбора');

    await expect(lock.acquire('user:1')).resolves.not.toBeNull();
  });

  it('не ждёт занятый замок, а честно сообщает об этом', async () => {
    await lock.acquire('user:1', 5_000);

    const outcome = await lock.withLock('user:1', () => Promise.resolve('не должно выполниться'));

    expect(outcome).toEqual({ acquired: false });
  });

  it('две задачи одного пользователя выполняются строго по очереди', async () => {
    const order: string[] = [];

    const task = (name: string) => async () => {
      order.push(`${name}:начал`);
      await delay(60);
      order.push(`${name}:кончил`);
    };

    // Вторая задача запускается, пока первая ещё работает: замок занят,
    // поэтому она не выполняется вовсе. Очередь поставит её заново.
    const first = lock.withLock('user:1', task('первая'), { ttlMs: 5_000 });
    await delay(10);
    const second = await lock.withLock('user:1', task('вторая'), { ttlMs: 5_000 });
    await first;

    expect(second).toEqual({ acquired: false });
    expect(order).toEqual(['первая:начал', 'первая:кончил']);
  });

  it('задачи разных пользователей идут параллельно', async () => {
    const started = new Set<string>();

    const task = (name: string) => async () => {
      started.add(name);
      await delay(60);
    };

    const [a, b] = await Promise.all([
      lock.withLock('user:1', task('a')),
      lock.withLock('user:2', task('b')),
    ]);

    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    expect(started).toEqual(new Set(['a', 'b']));
  });

  it('продлевает замок во время долгой работы', async () => {
    // TTL меньше длительности работы: без продления замок протухнет,
    // и параллельный воркер захватит его посреди обработки.
    const outcome = await lock.withLock(
      'user:1',
      async () => {
        await delay(400);
        return 'готово';
      },
      { ttlMs: 200, renewIntervalMs: 60 },
    );

    expect(outcome).toEqual({ acquired: true, result: 'готово' });
  });

  it('замок упавшего воркера протухает и не блокирует пользователя навсегда', async () => {
    // Имитация: замок взят и не снят, потому что процесс умер.
    await lock.acquire('user:1', 150);

    await expect(lock.acquire('user:1')).resolves.toBeNull();
    await delay(220);
    await expect(lock.acquire('user:1')).resolves.not.toBeNull();
  });
});
