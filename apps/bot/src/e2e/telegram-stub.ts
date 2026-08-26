import { createServer, type Server } from 'node:http';

/**
 * Заглушка Bot API для сквозного теста этапа 2 (задача 2.23).
 *
 * **Почему подменяется Telegram, а не наш код.** Проверять надо ответ
 * человеку целиком: не более трёх действий, желания не стали задачами,
 * записи разложены по темам. Прочитать этот ответ у Telegram нельзя —
 * бот не видит собственных сообщений, а войти пользователем значит
 * вводить код из SMS вручную. Поэтому подменяется ровно граница с
 * Telegram: весь наш путь от вебхука до отправки остаётся настоящим.
 *
 * **Что заглушка делает по-настоящему.** Ведёт счётчики сообщений и
 * ветвей, помнит закреплённое, отвечает так же, как Telegram: `ok` и
 * `result`. Ошибки она не выдумывает — сценарии отказов проверяются
 * своими тестами, а сквозной проверяет счастливый путь на живой системе.
 */

export interface StubCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

export interface TelegramStub {
  readonly url: string;
  readonly calls: readonly StubCall[];
  /** Тексты, ушедшие человеку: sendMessage и editMessageText по порядку. */
  texts(): readonly string[];
  callsOf(method: string): readonly Record<string, unknown>[];
  reset(): void;
  close(): Promise<void>;
}

/** Ветви, которые «создал» Telegram: по ним видно раскладку по темам. */
interface StubState {
  messageId: number;
  threadId: number;
}

export async function startTelegramStub(): Promise<TelegramStub> {
  const calls: StubCall[] = [];
  const state: StubState = { messageId: 1000, threadId: 100 };

  const respond = (method: string, payload: Record<string, unknown>): unknown => {
    switch (method) {
      case 'getMe':
        return { id: 777, is_bot: true, first_name: 'ВЫДОХ', username: 'vydoh_e2e_bot' };

      case 'sendMessage':
      case 'editMessageText':
      case 'sendDocument': {
        state.messageId++;
        return {
          message_id: state.messageId,
          date: 0,
          chat: { id: payload['chat_id'], type: 'private' },
          text: payload['text'] ?? '',
        };
      }

      case 'createForumTopic': {
        state.threadId += 10;
        return { message_thread_id: state.threadId, name: payload['name'] };
      }

      case 'getForumTopicIconStickers':
        // Настоящий Telegram отдаёт 112 значков; тесту хватает формы.
        return [{ emoji: '📌', file_id: 'значок' }];

      case 'setWebhook':
      case 'deleteWebhook':
      case 'setMyCommands':
      case 'setChatMenuButton':
      case 'pinChatMessage':
      case 'unpinChatMessage':
      case 'answerCallbackQuery':
      case 'editForumTopic':
      case 'setMessageReaction':
        return true;

      case 'getFile':
        return { file_id: payload['file_id'], file_unique_id: 'у', file_path: 'voice/file.oga' };

      default:
        // Неизвестный метод — это не «ничего страшного»: значит бот
        // делает то, о чём тест не знает, и молча зелёный тест обманет.
        return undefined;
    }
  };

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      // Адрес вида /bot<токен>/<метод>
      const method = (request.url ?? '').split('/').filter(Boolean).at(-1) ?? '';
      const body = Buffer.concat(chunks).toString('utf8');

      let payload: Record<string, unknown>;
      try {
        payload = body === '' ? {} : (JSON.parse(body) as Record<string, unknown>);
      } catch {
        payload = {};
      }

      calls.push({ method, payload });

      const result = respond(method, payload);

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          result === undefined
            ? { ok: false, error_code: 400, description: `заглушка не знает метода ${method}` }
            : { ok: true, result },
        ),
      );
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    calls,
    texts: () =>
      calls
        .filter((call) => call.method === 'sendMessage' || call.method === 'editMessageText')
        .map((call) => (typeof call.payload['text'] === 'string' ? call.payload['text'] : '')),
    callsOf: (method) => calls.filter((call) => call.method === method).map((call) => call.payload),
    reset: () => {
      calls.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
