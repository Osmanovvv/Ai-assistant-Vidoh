import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Перевод строки кодом: обратный слеш по пути сюда теряется. */
const NEWLINE = String.fromCharCode(10);

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
  const bot = createBot(FAKE_TOKEN, { botInfo: BOT_INFO });

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

/**
 * Отказ обработчика не уносит процесс (ревизия первого этапа).
 *
 * **Что было.** У вебхука стоял свой срок ответа — восемь секунд. По его
 * срабатыванию grammY делает два дела: отклоняет внешний промис, и его
 * ловит обработчик ошибок express, — и **отдельной цепочкой** вешает
 * `finally` на всё ещё идущую обработку, без `catch`. Обработка потом
 * отказывает, у второй цепочки приёмника нет, и Node выходит с кодом 1.
 * Падение на одном апдейте убивало бота целиком, вместе с разбором всех,
 * кто в этот миг говорил.
 *
 * Прежний страж покраснеть не мог: он подавал обработчик, который
 * отказывает **сразу**, до срабатывания срока, — то есть мерил первую
 * цепочку и оставался зелёным при живой дыре.
 */
describe('затянувшийся отказ обработчика', () => {
  async function slowFailing(delayMs: number): Promise<Harness> {
    const seen: string[] = [];
    const bot = createBot(FAKE_TOKEN, { botInfo: BOT_INFO });

    bot.on('message:text', async () => {
      await new Promise((done) => setTimeout(done, delayMs));
      throw new Error('обработка отказала уже после ответа');
    });

    const app = createServer({
      healthChecks: [],
      webhookPath: WEBHOOK_PATH,
      webhookHandler: createWebhookHandler(bot, SECRET),
      // Иначе отказ уходит в вывод прогона и читается как поломка набора.
      onError: () => undefined,
    });

    return { base: await listen(app), seen };
  }

  it('отказ доходит до express, а не остаётся без приёмника', async () => {
    /**
     * Ловим отказы без приёмника прямо здесь: именно они и убивали
     * процесс в бою. Срок короче работы обработчика — то самое условие,
     * при котором появлялась вторая цепочка.
     */
    const orphans: unknown[] = [];
    const catchOrphan = (reason: unknown): void => {
      orphans.push(reason);
    };

    process.on('unhandledRejection', catchOrphan);

    try {
      const { base } = await slowFailing(300);

      const response = await fetch(`${base}${WEBHOOK_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': SECRET,
        },
        body: update('мысль, на которой обработчик отказал', 77),
      });

      // Отказ обработки — наш сбой, и он честно пятисотый.
      expect(response.status).toBe(500);

      // Даём отказу время всплыть, если он остался без приёмника.
      await new Promise((done) => setTimeout(done, 400));

      expect(
        orphans,
        'отказ обработчика остался без приёмника: в бою на этом Node процесс выходит с кодом 1, ' +
          'то есть падение на одном апдейте уносит разбор у всех',
      ).toEqual([]);
    } finally {
      process.off('unhandledRejection', catchOrphan);
    }
  });

  it('своего срока ответа у вебхука нет — и это записано причиной', () => {
    /**
     * Страж по исходнику, потому что поведенческий выше ловит только срок
     * короче работы обработчика. Верни восемь секунд — и он останется
     * зелёным, потому что триста миллисекунд в них укладываются.
     */
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'webhook.ts'),
      'utf8',
    );

    /**
     * Комментарии вычитаются: в шапке `webhook.ts` снятый срок назван
     * дословно — иначе следующий не поймёт, почему его там нет. Страж,
     * который не отличает цитату от кода, краснеет на объяснении и учит
     * убирать объяснения.
     */
    /**
     * Комментарии вычитаются построчно: в шапке `webhook.ts` снятый срок
     * назван дословно — иначе следующий не поймёт, почему его там нет.
     * Страж, который не отличает цитату от кода, краснеет на объяснении
     * и тем учит объяснения убирать.
     */
    const code = source
      .split(NEWLINE)
      .filter((line) => {
        const trimmed = line.trim();

        return !trimmed.startsWith('*') && !trimmed.startsWith('/');
      })
      .join(NEWLINE);

    expect(
      code.includes('timeoutMilliseconds'),
      'у вебхука снова свой срок ответа: по его срабатыванию grammY оставляет вторую цепочку ' +
        'без приёмника, и отказ обработки убивает процесс. Telegram ждёт своим сроком, а повтор ' +
        'апдейта отбивается по его идентификатору',
    ).toBe(false);
  });

  it('в боевой сборке стоит последний рубеж от отказов без приёмника', () => {
    // Пущенных и не дождавшихся вызовов в обработчиках десятки; забыть
    // `catch` у одного — вопрос времени, и тогда спасает только рубеж.
    const start = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../index.ts'),
      'utf8',
    );

    expect(
      start.includes("process.on('unhandledRejection'"),
      'в src/index.ts нет обработчика unhandledRejection: один забытый catch снова уносит бота',
    ).toBe(true);
  });
});
