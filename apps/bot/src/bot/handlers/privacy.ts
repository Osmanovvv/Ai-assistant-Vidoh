import { InputFile, type Bot } from 'grammy';
import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import { deleteUserData, exportUserData } from '../../modules/privacy/privacy.service.js';
import type { TopicGateway } from '../../modules/topics/gateway.js';
import { textProfileByTgId } from '../../modules/users/settings.repo.js';
import { findByTgId } from '../../modules/users/users.repo.js';
import { textsFor, type TextProfile } from '../../texts/index.js';
import { fitKeyboard } from '../../modules/presenter/keyboard.js';

/**
 * Удаление и экспорт данных (задача 1.20).
 *
 * §16 ТЗ: удаление с подтверждением в два шага, экспорт в машиночитаемом
 * формате. Два шага здесь не формальность: операция необратима, а кнопка
 * живёт в меню рядом с обычными.
 */

export const DELETE_STEP_ONE = 'privacy:delete:1';
export const DELETE_STEP_TWO = 'privacy:delete:2';
export const DELETE_CANCEL = 'privacy:delete:cancel';

export interface PrivacyDeps {
  readonly db: Database;
  readonly logger: Logger;
  /**
   * Шлюз веток нужен удалению, а не экспорту.
   *
   * Без него удаление чистило базу и оставляло в чате ветки тем с
   * закреплёнными сводками — то есть со списком дел человека, который
   * только что попросил всё стереть.
   */
  readonly topics: TopicGateway;
}

export function registerPrivacyHandlers(bot: Bot, deps: PrivacyDeps): void {
  const { db, logger } = deps;
  /**
   * Профиль текстов человека (§13.8). Отдельный запрос на команду: команды
   * приходят редко, а тащить настройки через весь поток сообщений ради
   * двух реплик дороже, чем спросить у базы.
   */
  const textsOf = async (tgId: number | undefined): Promise<TextProfile> =>
    textsFor(tgId === undefined ? null : await textProfileByTgId(db, tgId));

  bot.command('delete_my_data', async (ctx) => {
    const texts = await textsOf(ctx.from?.id);

    await ctx.reply(texts.privacy.deleteFirstStep, {
      reply_markup: fitKeyboard([
        [
          { label: texts.privacy.deleteConfirmButton, action: DELETE_STEP_ONE },
          { label: texts.privacy.deleteCancelButton, action: DELETE_CANCEL },
        ],
      ]),
    });
  });

  bot.command('export_my_data', async (ctx) => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) return;

    const texts = await textsOf(tgId);

    const user = await findByTgId(db, tgId);
    if (!user) {
      await ctx.reply(texts.privacy.nothingToExport);
      return;
    }

    const data = await exportUserData(db, user.id);
    if (!data) {
      await ctx.reply(texts.privacy.nothingToExport);
      return;
    }

    const json = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
    await ctx.replyWithDocument(new InputFile(json, `vydoh-export-${String(tgId)}.json`), {
      caption: texts.privacy.exportReady,
    });
  });

  // Первый шаг: предупреждение о необратимости.
  bot.callbackQuery(DELETE_STEP_ONE, async (ctx) => {
    await ctx.answerCallbackQuery();
    const texts = await textsOf(ctx.from.id);

    await ctx.editMessageText(texts.privacy.deleteSecondStep, {
      /**
       * «Да, удалить безвозвратно» — двадцать четыре знака: рядом с
       * «Отмена» на телефоне читалось как «Да, удали…». Согласие на
       * необратимое удаление нельзя давать по огрызку подписи.
       */
      reply_markup: fitKeyboard([
        [
          { label: texts.privacy.deleteFinalButton, action: DELETE_STEP_TWO },
          { label: texts.privacy.deleteCancelButton, action: DELETE_CANCEL },
        ],
      ]),
    });
  });

  // Второй шаг: удаление.
  bot.callbackQuery(DELETE_STEP_TWO, async (ctx) => {
    await ctx.answerCallbackQuery();

    const tgId = ctx.from.id;
    const texts = await textsOf(tgId);
    const user = await findByTgId(db, tgId);
    if (!user) {
      await ctx.editMessageText(texts.privacy.nothingToDelete);
      return;
    }

    const report = await deleteUserData(db, user.id);
    logger.info(
      { tgId, messages: report.messages, dumps: report.dumps, threads: report.threadIds.length },
      'Данные пользователя удалены по его запросу',
    );

    /**
     * Ветки чистятся после базы, а не до, и поштучно в try/catch.
     *
     * Порядок такой потому, что главное здесь — удалить данные. Если
     * Telegram откажет (режим тем выключен, ветку уже снесли руками, у
     * бота нет прав), человек всё равно должен остаться удалённым:
     * несработавшая уборка чата — это неопрятность, а несработавшее
     * удаление — нарушение §16.
     */
    const chatId = ctx.chat?.id;

    if (chatId !== undefined) {
      for (const threadId of report.threadIds) {
        try {
          await deps.topics.deleteThread({ chatId, threadId });
        } catch (error) {
          logger.debug({ err: error, threadId }, 'Ветка не удалилась, данные это не меняет');
        }
      }
    }

    await ctx.editMessageText(texts.privacy.deleteDone);
  });

  bot.callbackQuery(DELETE_CANCEL, async (ctx) => {
    await ctx.answerCallbackQuery();
    const texts = await textsOf(ctx.from.id);

    await ctx.editMessageText(texts.privacy.deleteCancelled);
  });
}
