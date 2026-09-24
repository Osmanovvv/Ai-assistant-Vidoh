import type { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createRedis } from '../../infra/redis.js';
import type { DialogTurn } from './dialog.js';
import { DIALOG_KEEP, DIALOG_TTL_MS, redisDialogStore } from './dialog.store.js';

/**
 * Хвост разговора в Redis (план docs/26, задача 6).
 *
 * Хранится коротко: полчаса и не больше двенадцати записей — модели нужны
 * четыре реплики за четверть часа, запас — на правки «Слушаю…» → итог.
 */

const url = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379';
const redis: Redis = createRedis(url, { maxReconnectAttempts: 3 });
const PREFIX = 'test-dialog:';
const store = redisDialogStore(redis, { prefix: PREFIX });

const NOW = new Date('2026-09-24T12:00:00.000Z');
const at = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);
const turn = (text: string, minutes: number, role: DialogTurn['role'] = 'bot'): DialogTurn => ({
  role,
  text,
  at: at(minutes),
});

beforeEach(async () => {
  const keys = await redis.keys(`${PREFIX}*`);
  if (keys.length > 0) await redis.del(...keys);
});

afterAll(async () => {
  await redis.quit();
});

describe('хвост разговора в Redis', () => {
  it('помнит реплики обеих сторон и отдаёт свежие по порядку', async () => {
    await store.remember(42, turn('перенеси посылку', 2, 'person'));
    await store.remember(42, { ...turn('Напомню про «Забрать посылку»', 1), messageId: 5 });

    expect(await store.recent(42, NOW)).toEqual([
      { role: 'person', text: 'перенеси посылку', at: at(2) },
      { role: 'bot', text: 'Напомню про «Забрать посылку»', at: at(1), messageId: 5 },
    ]);
  });

  it('чаты не смешиваются', async () => {
    await store.remember(42, turn('мне', 1));
    await store.remember(43, turn('другому', 1));

    expect((await store.recent(42, NOW)).map((one) => one.text)).toEqual(['мне']);
  });

  it('живёт не дольше получаса', async () => {
    await store.remember(42, turn('x', 0));
    const ttl = await redis.pttl(`${PREFIX}42`);

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(DIALOG_TTL_MS);
    expect(DIALOG_TTL_MS).toBe(30 * 60_000);
  });

  it('хранит не больше двенадцати записей — старые уходят', async () => {
    for (let index = 0; index < 20; index += 1) {
      await store.remember(42, turn(String(index), 0));
    }

    expect(await redis.llen(`${PREFIX}42`)).toBe(DIALOG_KEEP);
    expect(DIALOG_KEEP).toBe(12);
    const kept = await redis.lrange(`${PREFIX}42`, 0, 0);
    expect(kept[0]).toContain('"text":"8"');
  });

  it('давнее отдаётся пустым: окно считает `recentDialog`', async () => {
    await store.remember(42, turn('давно', 20));

    expect(await store.recent(42, NOW)).toEqual([]);
  });

  it('forget стирает хвост целиком', async () => {
    await store.remember(42, turn('x', 0));
    await store.forget(42);

    expect(await redis.exists(`${PREFIX}42`)).toBe(0);
  });

  it('битая запись пропускается, а не роняет чтение', async () => {
    await redis.rpush(`${PREFIX}42`, 'не json', JSON.stringify({ role: 'робот', text: 'x' }));
    await store.remember(42, turn('целая', 1));

    expect((await store.recent(42, NOW)).map((one) => one.text)).toEqual(['целая']);
  });
});
