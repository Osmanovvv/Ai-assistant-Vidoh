import type { Redis } from 'ioredis';

import type { AlertMemory } from './monitoring.js';

/**
 * Память дребезга оповещений в Redis (бой 25.09.2026).
 *
 * «Баланс ниже порога» пришёл в 03:47 и снова в 03:51: выкладка
 * перезапустила бота, а «уже оповестили» жило в памяти процесса. Здесь —
 * время последнего оповещения по ключу, со сроком жизни ровно в паузу:
 * дольше оно никому не нужно, и Redis убирает его сам.
 */
export function redisAlertMemory(redis: Redis, prefix = 'monitor:alerted:'): AlertMemory {
  return {
    last: async (key) => {
      const value = Number(await redis.get(`${prefix}${key}`));
      // Нет ключа или не число — оповещения не было: лучше лишнее, чем тишина.
      return Number.isFinite(value) && value > 0 ? value : undefined;
    },
    remember: async (key, at, ttlMs) => {
      await redis.set(`${prefix}${key}`, String(at), 'PX', Math.max(1, Math.round(ttlMs)));
    },
    forget: async (key) => {
      await redis.del(`${prefix}${key}`);
    },
  };
}
