import { InlineKeyboard, type Api } from 'grammy';
import type { Logger } from 'pino';

import type { Executor } from '../../infra/db.js';
import { isBlockedError } from '../users/blocked.js';
import { markBlocked } from '../users/users.repo.js';
import type { StatusButton, StatusSender } from './status.service.js';

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

/**
 * Отправка вопроса с кнопками (задача 2.13).
 *
 * Отдельно от статусного отправителя: у статуса кнопок нет и не должно
 * быть — он правится по ходу разбора, а клавиатура на правящемся
 * сообщении мигала бы. Вопрос онбординга наоборот живёт своей репликой.
 */
export interface QuestionSender {
  ask(params: {
    readonly chatId: number;
    readonly threadId?: number | undefined;
    readonly text: string;
    readonly rows: readonly (readonly { readonly label: string; readonly action: string }[])[];
  }): Promise<number>;
}

export function createQuestionSender(deps: TelegramSenderDeps): QuestionSender {
  return {
    async ask({ chatId, threadId, text, rows }) {
      const keyboard = new InlineKeyboard();
      for (const row of rows) {
        for (const button of row) keyboard.text(button.label, button.action);
        keyboard.row();
      }

      try {
        const message = await deps.api.sendMessage(chatId, text, {
          reply_markup: keyboard,
          ...(threadId === undefined ? {} : { message_thread_id: threadId }),
        });
        return message.message_id;
      } catch (error) {
        // Недоставленный вопрос не должен ронять разбор: он важнее.
        if (isBlockedError(error)) {
          deps.logger.info({ chatId }, 'Пользователь заблокировал бота, помечаю');
          await markBlocked(deps.db, chatId);
        } else {
          deps.logger.error({ err: error, chatId }, 'Не удалось отправить вопрос');
        }
        return 0;
      }
    },
  };
}

export interface TelegramSenderDeps {
  readonly api: Api;
  readonly db: Executor;
  readonly logger: Logger;
}

/**
 * Клавиатура под сообщением, если она есть.
 *
 * Кнопки §13.2 идут одной строкой: подписи короткие, а перенос
 * растянул бы ответ там, где ТЗ требует краткости.
 */
function markup(buttons: readonly StatusButton[] | undefined): {
  readonly reply_markup?: InlineKeyboard;
} {
  if (buttons === undefined || buttons.length === 0) return {};

  const keyboard = new InlineKeyboard();
  for (const button of buttons) keyboard.text(button.label, button.action);

  return { reply_markup: keyboard };
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
    async send({ chatId, threadId, text, buttons }) {
      try {
        const message = await deps.api.sendMessage(chatId, text, {
          ...(threadId === undefined ? {} : { message_thread_id: threadId }),
          ...markup(buttons),
        });
        return message.message_id;
      } catch (error) {
        await handle(error, chatId, 'send');
        // Ноль означает «сообщения нет». Вызывающий код это учитывает и
        // не пытается потом править несуществующее сообщение.
        return 0;
      }
    },

    async edit({ chatId, messageId, text, buttons }) {
      try {
        await deps.api.editMessageText(chatId, messageId, text, markup(buttons));
      } catch (error) {
        await handle(error, chatId, 'edit');
      }
    },
  };
}
