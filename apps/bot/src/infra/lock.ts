import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

/**
 * Распределённая блокировка на Redis (задача 1.11).
 *
 * §9.1 ТЗ: обработка внутри одного пользователя строго последовательна.
 * Разбиение очереди по ключу — платная возможность BullMQ Pro, поэтому
 * порядок обеспечивается блокировкой: воркер берёт задание, захватывает
 * замок пользователя и не отпускает до конца работы.
 *
 * Замок живёт ограниченное время и продлевается, пока работа идёт. Так
 * упавший воркер не замораживает пользователя навсегда: замок протухнет
 * сам, и следующий воркер подхватит работу.
 */

/** Снять замок можно только своим токеном: иначе чужой воркер снимет наш. */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`;

export interface LockHandle {
  readonly key: string;
  readonly token: string;
}

export interface WithLockOptions {
  readonly ttlMs?: number;
  /** Как часто продлевать замок во время работы. По умолчанию треть TTL. */
  readonly renewIntervalMs?: number;
}

const DEFAULT_TTL_MS = 30_000;

export class RedisLock {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'lock:',
  ) {}

  async acquire(name: string, ttlMs: number = DEFAULT_TTL_MS): Promise<LockHandle | null> {
    const key = this.prefix + name;
    const token = randomUUID();

    const result = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? { key, token } : null;
  }

  async renew(handle: LockHandle, ttlMs: number = DEFAULT_TTL_MS): Promise<boolean> {
    const result = await this.redis.eval(RENEW_SCRIPT, 1, handle.key, handle.token, String(ttlMs));
    return result === 1;
  }

  async release(handle: LockHandle): Promise<boolean> {
    const result = await this.redis.eval(RELEASE_SCRIPT, 1, handle.key, handle.token);
    return result === 1;
  }

  /**
   * Выполняет работу под замком. Если замок занят — возвращает
   * { acquired: false } и не ждёт: очередь поставит задание заново.
   */
  async withLock<T>(
    name: string,
    fn: () => Promise<T>,
    options: WithLockOptions = {},
  ): Promise<{ acquired: false } | { acquired: true; result: T }> {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const renewIntervalMs = options.renewIntervalMs ?? Math.max(1_000, Math.floor(ttlMs / 3));

    const handle = await this.acquire(name, ttlMs);
    if (!handle) {
      return { acquired: false };
    }

    // Продление на случай долгой работы: расшифровка длинного голосового
    // может занять больше TTL, и замок не должен протухнуть под нами.
    const heartbeat = setInterval(() => {
      void this.renew(handle, ttlMs).catch(() => {
        // Продлить не удалось — работа всё равно завершится, а замок
        // протухнет сам. Ронять из-за этого обработку незачем.
      });
    }, renewIntervalMs);
    heartbeat.unref();

    try {
      return { acquired: true, result: await fn() };
    } finally {
      clearInterval(heartbeat);
      await this.release(handle);
    }
  }
}
