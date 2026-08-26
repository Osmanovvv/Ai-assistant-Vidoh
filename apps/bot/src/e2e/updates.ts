import { WEBHOOK_PATH } from '../config/env.js';

/**
 * Апдейты Telegram для сквозных тестов (задачи 1.24 и 2.23).
 *
 * Настоящее сообщение может прислать только настоящий человек, а путь
 * «вебхук → база → очередь → воркер → разбор → ответ» проверить надо до
 * того, как этот человек появится. Апдейт идёт тем же путём, что и
 * настоящий: по HTTP с секретом в заголовке. Внутренние функции напрямую
 * не дёргаются — иначе тест проверял бы не то, что работает в бою.
 */

/**
 * Команду Telegram помечает служебной разметкой bot_command, и grammY
 * ищет именно её. Без разметки обработчик команды не сработает — на этом
 * однажды уже споткнулся тест.
 */
export function commandEntities(
  text: string,
): readonly { type: string; offset: number; length: number }[] | undefined {
  // Разметку Telegram ставит не на всё, что начинается со слэша:
  // «/ надо бы разобраться» — это текст, а не команда.
  if (!/^\/[A-Za-z0-9_]{1,64}(?:@[A-Za-z0-9_]+)?(?:$|\s)/u.test(text)) return undefined;
  const word = text.split(' ')[0] ?? text;
  return [{ type: 'bot_command', offset: 0, length: word.length }];
}

export interface UpdateInput {
  readonly chatId: number;
  readonly messageId: number;
  /** Секунды эпохи. Передаётся снаружи: тест должен быть повторяемым. */
  readonly date?: number | undefined;
  readonly firstName?: string | undefined;
}

/**
 * Идентификатор апдейта выводится из идентификатора сообщения: повторный
 * запуск с тем же номером должен отсечься дедупликацией, а не создать
 * вторую выгрузку. Диапазон 900000000+ отведён под тесты.
 */
export function updateIdOf(messageId: number): number {
  return 900_000_000 + messageId;
}

export function textUpdate(input: UpdateInput, text: string): Record<string, unknown> {
  const from = { id: input.chatId, is_bot: false, first_name: input.firstName ?? 'Сквозной тест' };
  const chat = { id: input.chatId, type: 'private', first_name: from.first_name };
  const entities = commandEntities(text);

  return {
    update_id: updateIdOf(input.messageId),
    message: {
      message_id: input.messageId,
      date: input.date ?? Math.floor(Date.now() / 1000),
      chat,
      from,
      text,
      ...(entities === undefined ? {} : { entities }),
    },
  };
}

export function callbackUpdate(input: UpdateInput, data: string): Record<string, unknown> {
  const from = { id: input.chatId, is_bot: false, first_name: input.firstName ?? 'Сквозной тест' };
  const chat = { id: input.chatId, type: 'private', first_name: from.first_name };

  return {
    update_id: updateIdOf(input.messageId),
    callback_query: {
      id: String(input.messageId),
      from,
      chat_instance: 'test',
      data,
      message: {
        message_id: input.messageId,
        date: input.date ?? Math.floor(Date.now() / 1000),
        chat,
      },
    },
  };
}

/** Отправляет апдейт в вебхук так же, как это делает Telegram. */
export async function postUpdate(
  options: { readonly baseUrl: string; readonly secret: string },
  update: Record<string, unknown>,
): Promise<number> {
  const response = await fetch(`${options.baseUrl}${WEBHOOK_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': options.secret,
    },
    body: JSON.stringify(update),
  });

  return response.status;
}
