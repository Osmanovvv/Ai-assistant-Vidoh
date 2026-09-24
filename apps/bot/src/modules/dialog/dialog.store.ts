import type { Redis } from 'ioredis';

import { recentDialog, type DialogTurn } from './dialog.js';

/**
 * Хвост разговора в Redis (решение Никиты 24.09.2026, план docs/26, задача 6).
 *
 * Хранится коротко и сам себя стирает: полчаса и не больше двенадцати
 * записей на чат. Модели нужны четыре реплики за четверть часа (`dialog.ts`);
 * запас — на правки «Слушаю…» → итог, которые пишутся отдельной записью и
 * склеиваются при чтении. Не база: для хвоста разговора таблица с
 * миграцией и удалением по §16 — лишний вес, а срок жизни Redis даёт сам.
 *
 * Ключ — чат Telegram: его знают и перехват ответов бота (`chat_id`), и
 * конвейер (`target.chatId`).
 */

export const DIALOG_KEEP = 12;
export const DIALOG_TTL_MS = 30 * 60_000;

export interface DialogStore {
  remember(chatId: number, turn: DialogTurn): Promise<void>;
  recent(chatId: number, now: Date): Promise<DialogTurn[]>;
  forget(chatId: number): Promise<void>;
}

interface StoredTurn {
  readonly role?: unknown;
  readonly text?: unknown;
  readonly at?: unknown;
  readonly messageId?: unknown;
}

/** Запись из Redis — в реплику; всё, что на реплику не похоже, пропускается. */
function parseTurn(raw: string): DialogTurn | undefined {
  let value: StoredTurn;
  try {
    value = JSON.parse(raw) as StoredTurn;
  } catch {
    return undefined;
  }

  if (value.role !== 'person' && value.role !== 'bot') return undefined;
  if (typeof value.text !== 'string' || typeof value.at !== 'string') return undefined;

  const at = new Date(value.at);
  if (Number.isNaN(at.getTime())) return undefined;

  return {
    role: value.role,
    text: value.text,
    at,
    ...(typeof value.messageId === 'number' ? { messageId: value.messageId } : {}),
  };
}

export function redisDialogStore(
  redis: Redis,
  options: { readonly prefix?: string } = {},
): DialogStore {
  const prefix = options.prefix ?? 'dialog:';
  const keyOf = (chatId: number): string => `${prefix}${String(chatId)}`;

  return {
    async remember(chatId, turn) {
      const key = keyOf(chatId);
      await redis
        .multi()
        .rpush(key, JSON.stringify({ ...turn, at: turn.at.toISOString() }))
        .ltrim(key, -DIALOG_KEEP, -1)
        .pexpire(key, DIALOG_TTL_MS)
        .exec();
    },

    async recent(chatId, now) {
      const raw = await redis.lrange(keyOf(chatId), 0, -1);
      const turns = raw.map(parseTurn).filter((turn): turn is DialogTurn => turn !== undefined);
      return recentDialog(turns, now);
    },

    async forget(chatId) {
      await redis.del(keyOf(chatId));
    },
  };
}
