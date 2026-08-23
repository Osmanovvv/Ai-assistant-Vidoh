import { Redis } from 'ioredis';

import { getEnv } from '../config/env.js';

/**
 * Подключение к Redis (задача 1.6, полноценно используется с 1.11).
 *
 * maxRetriesPerRequest: null — требование BullMQ, который придёт на задаче
 * 1.11: буфер выгрузок и последовательная очередь на пользователя.
 */

let client: Redis | undefined;

export function createRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Молча падать нельзя: потеря Redis означает зависшие выгрузки (§9 ТЗ),
    // поэтому переподключаемся, а не сдаёмся.
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
}

export function getRedis(): Redis {
  client ??= createRedis(getEnv().REDIS_URL);
  return client;
}

/**
 * Проверка живости для /health/ready.
 *
 * Сравнивать ответ с PONG незачем: ioredis отклоняет промис, если связи
 * нет, а успешный ответ по контракту всегда PONG. Ошибка сама долетит
 * до обработчика готовности.
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
