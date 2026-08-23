import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Express } from 'express';
import type { UserFromGetMe } from 'grammy/types';
import { afterEach, describe, expect, it } from 'vitest';

import { WEBHOOK_PATH } from '../config/env.js';
import { createServer } from '../http/server.js';
import { createBot } from './bot.js';
import { createWebhookHandler } from './webhook.js';

/** Заведомо ненастоящий токен: репозиторий публичный. */
const FAKE_TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SECRET = 'a'.repeat(32);

/** botInfo задан вручную, поэтому bot.init() не ходит в сеть. */
const BOT_INFO: UserFromGetMe = {
  id: 123_456_789,
  is_bot: true,
  first_name: 'Выдох',
  username: 'aividoh_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  // Bot API 9.3+: режим тем в личных чатах. У боевого бота включён,
  // создание тем пользователем запрещено (§8.1 ТЗ).
  has_topics_enabled: true,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

const running: Server[] = [];

async function listen(app: Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  running.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

interface Harness {
  readonly base: string;
  readonly seen: string[];
}

async function harness(): Promise<Harness> {
  const seen: string[] = [];
  const bot = createBot(FAKE_TOKEN, BOT_INFO);

  bot.on('message:text', (ctx) => {
    seen.push(ctx.message.text);
  });

  const app = createServer({
    healthChecks: [],
    webhookPath: WEBHOOK_PATH,
    webhookHandler: createWebhookHandler(bot, SECRET),
  });

  return { base: await listen(app), seen };
}

function update(text: string, id = 1): string {
  return JSON.stringify({
    update_id: id,
    message: {
      message_id: 1,
      date: 1_700_000_000,
      chat: { id: 500, type: 'private' },
      from: { id: 500, is_bot: false, first_name: 'Аня' },
      text,
    },
  });
}

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

describe('проверка секрета вебхука', () => {
  it('запрос без заголовка секрета отвергается и не доходит до обработчиков', async () => {
    const { base, seen } = await harness();

    const response = await fetch(`${base}${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: update('чужой запрос'),
    });

    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('запрос с неверным секретом отвергается', async () => {
    const { base, seen } = await harness();

    const response = await fetch(`${base}${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'b'.repeat(32),
      },
      body: update('подделка'),
    });

    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('запрос с верным секретом принимается и доходит до обработчика', async () => {
    const { base, seen } = await harness();

    const response = await fetch(`${base}${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': SECRET,
      },
      body: update('купить продукты'),
    });

    expect(response.status).toBe(200);
    expect(seen).toEqual(['купить продукты']);
  });
});
