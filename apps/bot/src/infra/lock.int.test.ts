import { setTimeout as delay } from 'node:timers/promises';

import type { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { RedisLock } from './lock.js';
import { createRedis } from './redis.js';

const url = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379';
// Предел повторов: тестовый процесс короткий, и отложенное
// переподключение не должно сработать уже после закрытия соединения.
const redis: Redis = createRedis(url, { maxReconnectAttempts: 3 });
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
    //
    // **Смотреть надо на сам замок, а не на возвращённый результат.**
    // Прежняя проверка сверяла только `{ acquired: true, result: 'готово' }`
    // — а этот ответ приходит и без всякого продления: после захвата
    // withLock на замок больше не смотрит, работа просто дорабатывает на
    // протухшем. Проверка оставалась зелёной, даже если весь heartbeat
    // вырезать целиком, — то есть охраняла ровно ничего. А продление это
    // единственное, что не даёт второму воркеру взять ту же выгрузку и
    // разобрать её вторым разом (§9.1 ТЗ: строгая последовательность
    // внутри одного пользователя).
    //
    // Поэтому посреди работы за замком приходит соперник. Пробует он на
    // 1.6×TTL от начала: без продления к этому моменту замок протух
    // давно, с продлением — жив, и захват обязан не удаться.
    const rivals: boolean[] = [];

    const outcome = await lock.withLock(
      'user:1',
      async () => {
        await delay(320);

        // Короткий TTL у соперника: если он всё-таки прорвётся (значит,
        // страж покраснел не зря), его замок не переживёт этот тест.
        const seized = await lock.acquire('user:1', 50);
        rivals.push(seized !== null);
        if (seized) await lock.release(seized);

        await delay(100);
        return 'готово';
      },
      { ttlMs: 200, renewIntervalMs: 60 },
    );

    expect(rivals).toEqual([false]);
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

describe('потеря замка слышна', () => {
  /**
   * Ревизия этапов 1–2, молчаливый отказ.
   *
   * `renew` возвращал `false` в пустоту, и работа дорабатывала без замка:
   * §9.1 — строгая последовательность внутри одного человека — переставал
   * держаться молча. Цена известна: досмотр возвращает выгрузку в
   * очередь, второй воркер разбирает её заново, человек получает ответ
   * дважды, а модель оплачена дважды. В журнале не было ни строки, и
   * связать жалобу «бот ответил дважды» с причиной было нечем.
   *
   * Поведение при этом не изменилось: работа под потерянным замком
   * по-прежнему дорабатывает до конца — бросить разбор посреди значит
   * потерять слова человека (§17).
   */

  it('замок отобрали посреди работы — об этом сказано', async () => {
    const lost: { name: string; reason: string }[] = [];
    const watched = new RedisLock(redis, 'test-lock:', (event) => {
      lost.push({ name: event.name, reason: event.reason });
    });

    const outcome = await watched.withLock(
      'user:lost',
      async () => {
        // Замок уходит к другому: ключа с нашим токеном больше нет.
        await redis.del('test-lock:user:lost');
        await redis.set('test-lock:user:lost', 'чужой-токен', 'PX', 5_000);

        // Ждём удара сердца.
        await delay(120);

        return 'работа доделана';
      },
      { ttlMs: 1_000, renewIntervalMs: 50 },
    );

    // Работа доделана — это главное: слова человека дороже замка.
    expect(outcome).toEqual({ acquired: true, result: 'работа доделана' });

    expect(
      lost.map((one) => one.reason),
      'потеря замка снова прошла молча',
    ).toContain('renew-denied');
    expect(lost[0]?.name).toBe('user:lost');
  });

  it('о каждом поводе говорится один раз, а не на каждый удар сердца', async () => {
    // Громкость, повторяющая себя, читается как шум и перестаёт значить
    // что-либо: продление идёт каждые несколько секунд.
    const lost: string[] = [];
    const watched = new RedisLock(redis, 'test-lock:', (event) => {
      lost.push(event.reason);
    });

    await watched.withLock(
      'user:once',
      async () => {
        await redis.del('test-lock:user:once');
        await delay(300);
      },
      { ttlMs: 1_000, renewIntervalMs: 40 },
    );

    expect(lost.filter((one) => one === 'renew-denied')).toHaveLength(1);
  });

  it('короткая работа, потерявшая замок, тоже не молчит', async () => {
    /**
     * До первого продления дело может и не дойти: разбор короче срока
     * продления. Без проверки на выходе такая потеря не видна вообще
     * ничем — а последствие у неё то же.
     */
    const lost: string[] = [];
    const watched = new RedisLock(redis, 'test-lock:', (event) => {
      lost.push(event.reason);
    });

    await watched.withLock(
      'user:short',
      async () => {
        await redis.del('test-lock:user:short');
      },
      { ttlMs: 30_000, renewIntervalMs: 10_000 },
    );

    expect(lost, 'короткая работа потеряла замок молча').toContain('release-denied');
  });

  it('на здоровом ходу дела не говорится ничего', async () => {
    const lost: string[] = [];
    const watched = new RedisLock(redis, 'test-lock:', (event) => {
      lost.push(event.reason);
    });

    await watched.withLock(
      'user:ok',
      async () => {
        await delay(120);
      },
      { ttlMs: 1_000, renewIntervalMs: 40 },
    );

    expect(lost, 'жалоба на обычном ходу дела — это новая слепота').toEqual([]);
  });
});
