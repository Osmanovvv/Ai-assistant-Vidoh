import { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';

import { retryOnConnectFailure } from './retry.js';
import { tolerateSameContent } from './same-content.js';

export interface BotOptions {
  /**
   * Известный botInfo: тогда bot.init() не ходит в сеть. Нужен и тестам,
   * и быстрому старту вебхука, и вторым репликам, которым незачем
   * повторно спрашивать getMe.
   */
  readonly botInfo?: UserFromGetMe | undefined;
  /**
   * Адрес Bot API вместо настоящего (задача 2.23).
   *
   * Нужен сквозному тесту: ответы бота проверяются целиком, а прочитать
   * их у Telegram нельзя — бот не видит собственных сообщений, а войти
   * пользователем значит вводить код из SMS. Подменяется здесь именно
   * граница с Telegram, а не наш код, поэтому тест остаётся сквозным.
   *
   * В бою переменная обязана быть пустой — это проверяет конфигурация:
   * подменённый адрес в бою означал бы бота, который «отвечает» в
   * пустоту, и заметили бы это не мы, а живые люди.
   */
  readonly apiRoot?: string | undefined;
}

/** Экземпляр бота (задача 1.7). */
export function createBot(token: string, options: BotOptions = {}): Bot {
  const bot = new Bot(token, {
    ...(options.botInfo === undefined ? {} : { botInfo: options.botInfo }),
    ...(options.apiRoot === undefined ? {} : { client: { apiRoot: options.apiRoot } }),
  });

  // Отказ соединения с Telegram повторяется один раз (задача 3.60):
  // иначе ответ пропадает молча, а человек видит свою команду и тишину.
  bot.api.config.use(retryOnConnectFailure());

  // Правка тем же содержимым — не ошибка (задача 3.73): кнопка с номером
  // страницы ведёт на ту же страницу, и Telegram отвергает такую правку.
  bot.api.config.use(tolerateSameContent());

  return bot;
}

/**
 * Типы апдейтов, которые нам нужны. Список ограничен намеренно: Telegram
 * не будет слать лишнее, а мы не будем платить за его разбор.
 */
export const ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'callback_query',
  'my_chat_member',
] as const;
