import { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';

/**
 * Экземпляр бота (задача 1.7).
 *
 * botInfo передаётся снаружи, если он уже известен: тогда bot.init() не
 * ходит в сеть. Это нужно и тестам, и быстрому старту вебхука, и вторым
 * репликам, которым незачем повторно спрашивать getMe.
 */
export function createBot(token: string, botInfo?: UserFromGetMe): Bot {
  return botInfo ? new Bot(token, { botInfo }) : new Bot(token);
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
