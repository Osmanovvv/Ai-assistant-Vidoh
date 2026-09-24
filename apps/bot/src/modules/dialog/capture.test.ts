import { describe, expect, it } from 'vitest';

import { rememberBotReplies } from './capture.js';
import type { DialogTurn } from './dialog.js';
import type { DialogStore } from './dialog.store.js';

/**
 * Реплики бота ловит одна точка — преобразователь `bot.api` (план docs/26,
 * задача 7). Ответы шлют десятки мест: конвейер, вопросы, карточки,
 * напоминания. Все они идут через `bot.api` — там и ловим, а не в каждом.
 */

const NOW = new Date('2026-09-24T12:00:00.000Z');

function memoryStore(): DialogStore & { readonly turns: (chatId: number) => DialogTurn[] } {
  const saved = new Map<number, DialogTurn[]>();
  return {
    turns: (chatId) => saved.get(chatId) ?? [],
    remember: (chatId, turn) => {
      saved.set(chatId, [...(saved.get(chatId) ?? []), turn]);
      return Promise.resolve();
    },
    recent: (chatId) => Promise.resolve(saved.get(chatId) ?? []),
    forget: (chatId) => {
      saved.delete(chatId);
      return Promise.resolve();
    },
  };
}

type Prev = Parameters<ReturnType<typeof rememberBotReplies>>[0];

/** Поддельный Telegram: отвечает успехом с номером сообщения или отказом. */
function telegram(answer: { ok: true; result: unknown } | { ok: false }): Prev {
  return (() =>
    Promise.resolve(
      answer.ok ? answer : { ok: false, error_code: 400, description: 'Bad Request' },
    )) as unknown as Prev;
}

async function send(
  store: DialogStore,
  method: string,
  payload: Record<string, unknown>,
  answer: { ok: true; result: unknown } | { ok: false } = { ok: true, result: { message_id: 9 } },
): Promise<unknown> {
  const transformer = rememberBotReplies(store, { now: () => NOW });
  return await transformer(telegram(answer), method as never, payload as never, undefined);
}

describe('перехват реплик бота', () => {
  it('отправленный текст в личный чат запоминается с номером сообщения', async () => {
    const store = memoryStore();
    await send(store, 'sendMessage', { chat_id: 42, text: 'Какое дело?' });

    expect(store.turns(42)).toEqual([{ role: 'bot', text: 'Какое дело?', at: NOW, messageId: 9 }]);
  });

  it('правка текста — с номером из запроса: «Слушаю…» → итог склеятся при чтении', async () => {
    const store = memoryStore();
    await send(
      store,
      'editMessageText',
      { chat_id: 42, message_id: 7, text: 'Записала 1 дело' },
      {
        ok: true,
        result: true,
      },
    );

    expect(store.turns(42)).toEqual([
      { role: 'bot', text: 'Записала 1 дело', at: NOW, messageId: 7 },
    ]);
  });

  it('подпись карточки — тоже реплика', async () => {
    const store = memoryStore();
    await send(store, 'sendPhoto', {
      chat_id: 42,
      photo: 'x',
      caption: 'Через 30 минут: Забрать посылку',
    });

    expect(store.turns(42).map((one) => one.text)).toEqual(['Через 30 минут: Забрать посылку']);
  });

  it('отказ Telegram, чужой метод, пустой текст и групповой чат — не запоминаются', async () => {
    const store = memoryStore();
    await send(store, 'sendMessage', { chat_id: 42, text: 'не ушло' }, { ok: false });
    await send(store, 'sendChatAction', { chat_id: 42, action: 'typing' });
    await send(store, 'sendMessage', { chat_id: 42, text: '   ' });
    await send(store, 'sendMessage', { chat_id: -100123, text: 'в группу' });

    expect(store.turns(42)).toEqual([]);
    expect(store.turns(-100123)).toEqual([]);
  });

  it('сбой хранилища не ломает отправку: ответ Telegram возвращается как есть', async () => {
    const broken: DialogStore = {
      remember: () => Promise.reject(new Error('redis down')),
      recent: () => Promise.resolve([]),
      forget: () => Promise.resolve(),
    };

    const answer = await send(broken, 'sendMessage', { chat_id: 42, text: 'x' });

    expect(answer).toEqual({ ok: true, result: { message_id: 9 } });
  });

  it('без хранилища преобразователь просто пропускает вызов', async () => {
    const transformer = rememberBotReplies(undefined);
    const answer = await transformer(
      telegram({ ok: true, result: { message_id: 1 } }),
      'sendMessage' as never,
      { chat_id: 42, text: 'x' } as never,
      undefined,
    );

    expect(answer).toEqual({ ok: true, result: { message_id: 1 } });
  });
});
