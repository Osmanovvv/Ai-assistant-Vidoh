import type { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { redisAlertMemory } from './alert-memory.js';
import { createRedis } from './redis.js';

/**
 * Память дребезга оповещений в Redis (бой 25.09.2026): «баланс ниже
 * порога» приходил после каждой выкладки — память была в процессе.
 */
const url = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379';
const redis: Redis = createRedis(url, { maxReconnectAttempts: 3 });
const memory = redisAlertMemory(redis, 'test-alerted:');

beforeEach(async () => {
  const keys = await redis.keys('test-alerted:*');
  if (keys.length > 0) await redis.del(...keys);
});

afterAll(async () => {
  await redis.quit();
});

describe('память оповещений в Redis', () => {
  it('помнит время оповещения и живёт не дольше паузы', async () => {
    await memory.remember('yandex-balance-low', 1_790_000_000_000, 60_000);

    expect(await memory.last('yandex-balance-low')).toBe(1_790_000_000_000);
    const ttl = await redis.pttl('test-alerted:yandex-balance-low');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it('не было оповещения — пусто; забытое — пусто', async () => {
    expect(await memory.last('bot-down')).toBeUndefined();

    await memory.remember('bot-down', 5, 60_000);
    await memory.forget('bot-down');

    expect(await memory.last('bot-down')).toBeUndefined();
  });

  it('мусор вместо числа — считается, что оповещения не было', async () => {
    await redis.set('test-alerted:error-rate', 'не число', 'PX', 60_000);

    expect(await memory.last('error-rate')).toBeUndefined();
  });
});
