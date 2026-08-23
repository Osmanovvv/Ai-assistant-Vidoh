import { Redis } from 'ioredis';

import { getEnv } from '../config/env.js';

/**
 * Подключение к Redis (задача 1.6, полноценно используется с 1.11).
 *
 * maxRetriesPerRequest: null — требование BullMQ: буфер выгрузок и
 * последовательная очередь на пользователя (§9.1 ТЗ).
 */

export interface RedisConnectionOptions {
  /**
   * Сколько раз пытаться переподключиться. По умолчанию бесконечно:
   * потеря Redis означает зависшие выгрузки, поэтому боевой процесс
   * обязан дожидаться его возвращения, а не сдаваться.
   *
   * Короткоживущим процессам — тестам и разовым скриптам — нужен предел:
   * иначе запланированное переподключение может сработать уже после
   * закрытия соединения и уронить процесс на выходе.
   */
  readonly maxReconnectAttempts?: number | undefined;
}

export function createRedis(url: string, options: RedisConnectionOptions = {}): Redis {
  const { maxReconnectAttempts } = options;

  // Объект передаётся встроенным литералом: под exactOptionalPropertyTypes
  // отдельно объявленный RedisOptions не подходит перегрузкам конструктора.
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number) => {
      if (maxReconnectAttempts !== undefined && times > maxReconnectAttempts) {
        return null;
      }
      return Math.min(times * 200, 5_000);
    },
  });
}

let client: Redis | undefined;

export function getRedis(): Redis {
  client ??= createRedis(getEnv().REDIS_URL);
  return client;
}

/**
 * Проверка живости для /health/ready.
 *
 * Сравнивать ответ с PONG незачем: ioredis отклоняет промис, если связи
 * нет, а успешный ответ по контракту всегда PONG.
 */
export async function pingRedis(redis: Redis = getRedis()): Promise<void> {
  await redis.ping();
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = undefined;
  }
}
