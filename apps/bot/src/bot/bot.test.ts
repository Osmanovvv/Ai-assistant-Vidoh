import { createServer, type Server } from 'node:http';

import { GrammyError } from 'grammy';
import { afterEach, describe, expect, it } from 'vitest';

import { createBot } from './bot.js';

/**
 * Правило «та же правка — не ошибка» подключено к боту (задача 3.73).
 *
 * **Зачем отдельная проверка.** Правило держится на одной строке в
 * `createBot`. Его логика проверена в `same-content.test.ts`, но если
 * строка подключения пропадёт при правке, тест логики останется зелёным,
 * а бот вернётся к прежнему поведению: отказ посреди обработчика.
 *
 * **Проверяется через поддельный Telegram, а не через внутренности
 * grammY.** Список подключённых преобразователей там объявлен массивом, а
 * на деле оказался функцией — опираться на такое расхождение значит
 * проверять библиотеку вместо своего кода. Здесь бот делает настоящий
 * вызов, а на другом конце отвечает наш сервер.
 */

const FAKE_TOKEN = '123456789:TESTTESTTESTTESTTESTTESTTESTTEST';

const BOT_INFO = {
  id: 123_456_789,
  is_bot: true as const,
  first_name: 'Выдох',
  username: 'vydoh_test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

let server: Server | undefined;

/** Поддельный Telegram, отвечающий одним и тем же телом на любой вызов. */
async function telegramAnswering(status: number, body: unknown): Promise<string> {
  const listener = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });

  server = listener;
  await new Promise<void>((resolve) => {
    listener.listen(0, '127.0.0.1', resolve);
  });

  const address = listener.address();
  if (address === null || typeof address === 'string') {
    throw new Error('поддельный Telegram не занял порт');
  }

  return `http://127.0.0.1:${String(address.port)}`;
}

afterEach(async () => {
  const listener = server;
  server = undefined;
  if (listener) {
    await new Promise<void>((resolve) => {
      listener.close(() => {
        resolve();
      });
    });
  }
});

describe('createBot', () => {
  it('правка тем же содержимым не роняет обработчик', async () => {
    const apiRoot = await telegramAnswering(400, {
      ok: false,
      error_code: 400,
      description:
        'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
    });
    const bot = createBot(FAKE_TOKEN, { botInfo: BOT_INFO, apiRoot });

    await expect(bot.api.editMessageText(1, 2, 'то же самое')).resolves.toBe(true);
  });

  it('остальные отказы Telegram поднимаются как раньше', async () => {
    /**
     * Половина смысла правила — здесь. «Сообщение не найдено» значит, что
     * бот потерял из вида то, что правит, и молчать об этом нельзя.
     */
    const apiRoot = await telegramAnswering(400, {
      ok: false,
      error_code: 400,
      description: 'Bad Request: message to edit not found',
    });
    const bot = createBot(FAKE_TOKEN, { botInfo: BOT_INFO, apiRoot });

    await expect(bot.api.editMessageText(1, 2, 'текст')).rejects.toBeInstanceOf(GrammyError);
  });
});
