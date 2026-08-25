import type { Api } from 'grammy';
import type { Logger } from 'pino';

import type { Executor } from '../../infra/db.js';
import { isBlockedError } from '../users/blocked.js';
import { markBlocked } from '../users/users.repo.js';
import type { StatusSender } from './status.service.js';

/**
 * Отправка статусных сообщений в Telegram (задачи 1.17 и 1.19).
 *
 * Здесь же закрывается второй признак блокировки из §17: апдейт
 * my_chat_member ловит нажатие «Заблокировать», а 403 при отправке — все
 * случаи, когда этот апдейт мы пропустили. Без второго признака бот
 * продолжал бы писать в пустоту и копить ошибки в журнале.
 *
 * Неудачная отправка не роняет обработку. Ответ важен, но выгрузка важнее:
 * человек может вернуться и прочитать разбор позже, а потерянная мысль
 * не вернётся. Поэтому ошибка логируется, а конвейер идёт дальше.
 */

export interface TelegramSenderDeps {
  readonly api: Api;
  readonly db: Executor;
  readonly logger: Logger;
}

export function createTelegramSender(deps: TelegramSenderDeps): StatusSender {
  /** Общая обработка отказа: блокировку помечаем, остальное пишем в лог. */
  async function handle(error: unknown, chatId: number, action: string): Promise<void> {
    if (isBlockedError(error)) {
      deps.logger.info({ chatId }, 'Пользователь заблокировал бота, помечаю');
      await markBlocked(deps.db, chatId);
      return;
    }

    deps.logger.error({ err: error, chatId, action }, 'Не удалось отправить статус');
  }

  return {
    async send({ chatId, threadId, text }) {
      try {
        const message = await deps.api.sendMessage(chatId, text, {
          ...(threadId === undefined ? {} : { message_thread_id: threadId }),
        });
        return message.message_id;
      } catch (error) {
        await handle(error, chatId, 'send');
        // Ноль означает «сообщения нет». Вызывающий код это учитывает и
        // не пытается потом править несуществующее сообщение.
        return 0;
      }
    },

    async edit({ chatId, messageId, text }) {
      try {
        await deps.api.editMessageText(chatId, messageId, text);
      } catch (error) {
        await handle(error, chatId, 'edit');
      }
    },
  };
}
