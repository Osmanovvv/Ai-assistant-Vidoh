import { InlineKeyboard, InputFile, type Bot } from 'grammy';
import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import { deleteUserData, exportUserData } from '../../modules/privacy/privacy.service.js';
import { findByTgId } from '../../modules/users/users.repo.js';
import { texts } from '../../texts/ru.js';

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

export function registerPrivacyHandlers(bot: Bot, db: Database, logger: Logger): void {
  bot.command('delete_my_data', async (ctx) => {
    await ctx.reply(texts.privacy.deleteFirstStep, {
      reply_markup: new InlineKeyboard()
        .text(texts.privacy.deleteConfirmButton, DELETE_STEP_ONE)
        .text(texts.privacy.deleteCancelButton, DELETE_CANCEL),
    });
  });

  bot.command('export_my_data', async (ctx) => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) return;

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
    await ctx.editMessageText(texts.privacy.deleteSecondStep, {
      reply_markup: new InlineKeyboard()
        .text(texts.privacy.deleteFinalButton, DELETE_STEP_TWO)
        .text(texts.privacy.deleteCancelButton, DELETE_CANCEL),
    });
  });

  // Второй шаг: удаление.
  bot.callbackQuery(DELETE_STEP_TWO, async (ctx) => {
    await ctx.answerCallbackQuery();

    const tgId = ctx.from.id;
    const user = await findByTgId(db, tgId);
    if (!user) {
      await ctx.editMessageText(texts.privacy.nothingToDelete);
      return;
    }

    const report = await deleteUserData(db, user.id);
    logger.info(
      { tgId, messages: report.messages, dumps: report.dumps },
      'Данные пользователя удалены по его запросу',
    );

    await ctx.editMessageText(texts.privacy.deleteDone);
  });

  bot.callbackQuery(DELETE_CANCEL, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(texts.privacy.deleteCancelled);
  });
}
