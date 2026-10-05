import { InputFile, type Bot } from 'grammy';
import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import { eraseUser, forgetDialog } from '../../modules/privacy/erase.service.js';
import { exportUserData } from '../../modules/privacy/privacy.service.js';
import type { PaymentProvider } from '../../modules/billing/provider.js';
import type { Rail } from '../../modules/billing/tariffs.js';
import type { DialogStore } from '../../modules/dialog/dialog.store.js';
import type { TopicGateway } from '../../modules/topics/gateway.js';
import { textProfileByTgId } from '../../modules/users/settings.repo.js';
import { findByTgId } from '../../modules/users/users.repo.js';
import { textsFor, type TextProfile } from '../../texts/index.js';
import { fitKeyboard } from '../../modules/presenter/keyboard.js';
import { clearKnownChatHistory } from '../../modules/privacy/chat-history.service.js';

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
export const CLEAR_HISTORY_STEP_ONE = 'privacy:history:1';
export const CLEAR_HISTORY_STEP_TWO = 'privacy:history:2';
export const CLEAR_HISTORY_CANCEL = 'privacy:history:cancel';

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
  /**
   * Провайдеры оплаты — чтобы отменить продление ДО удаления (§16, §14).
   *
   * Ключ отмены лежит в подписке, а она уходит каскадом вместе с
   * человеком: не отмени мы продление заранее, списания продолжатся, и
   * остановить их не сможет никто — ни он, ни мы, ни панель.
   *
   * Необязательны: без них удаление работает как прежде, и это законное
   * состояние до подключения оплаты.
   */
  readonly providers?: Partial<Record<Rail, PaymentProvider>> | undefined;
  /** Хвост разговора стирается вместе с данными (план docs/26). */
  readonly dialog?: DialogStore | undefined;
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

  bot.command('clear_chat', async (ctx) => {
    const texts = await textsOf(ctx.from?.id);
    await ctx.reply(texts.privacy.clearHistoryFirstStep, {
      reply_markup: fitKeyboard([
        [
          { label: texts.privacy.clearHistoryConfirmButton, action: CLEAR_HISTORY_STEP_ONE },
          { label: texts.privacy.clearHistoryCancelButton, action: CLEAR_HISTORY_CANCEL },
        ],
      ]),
    });
  });

  bot.callbackQuery(CLEAR_HISTORY_STEP_ONE, async (ctx) => {
    await ctx.answerCallbackQuery();
    const texts = await textsOf(ctx.from.id);
    await ctx.editMessageText(texts.privacy.clearHistorySecondStep, {
      reply_markup: fitKeyboard([
        [
          { label: texts.privacy.clearHistoryFinalButton, action: CLEAR_HISTORY_STEP_TWO },
          { label: texts.privacy.clearHistoryCancelButton, action: CLEAR_HISTORY_CANCEL },
        ],
      ]),
    });
  });

  bot.callbackQuery(CLEAR_HISTORY_STEP_TWO, async (ctx) => {
    await ctx.answerCallbackQuery();
    const tgId = ctx.from.id;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    const texts = await textsOf(tgId);
    const user = await findByTgId(db, tgId);
    if (user) {
      let recent = [] as Awaited<ReturnType<DialogStore['recent']>>;
      if (deps.dialog !== undefined) {
        try {
          recent = await deps.dialog.recent(chatId, new Date());
        } catch (error: unknown) {
          logger.debug({ err: error, tgId }, 'Недавние реплики не получены при очистке переписки');
        }
      }
      await clearKnownChatHistory(db, {
        userId: user.id,
        chatId,
        deleteMessage: (targetChatId, messageId) => ctx.api.deleteMessage(targetChatId, messageId),
        logger,
        extraMessageIds: recent.flatMap((turn) =>
          turn.messageId === undefined ? [] : [turn.messageId],
        ),
      });
    }
    await forgetDialog(deps, { tgId, chatId });
    await ctx.editMessageText(texts.privacy.clearHistoryDone);
  });

  bot.callbackQuery(CLEAR_HISTORY_CANCEL, async (ctx) => {
    await ctx.answerCallbackQuery();
    const texts = await textsOf(ctx.from.id);
    await ctx.editMessageText(texts.privacy.clearHistoryCancelled);
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
      // Человека уже нет — и ключ с его чатом не заводится (см. ниже).
      await forgetDialog(deps, { tgId, chatId: ctx.chat?.id });
      return;
    }

    // Один путь стирания на команду и на удаление после тишины: продления,
    // база, ветки — см. `eraseUser`.
    const { renewals } = await eraseUser(
      { db, logger, topics: deps.topics, providers: deps.providers, dialog: deps.dialog },
      { userId: user.id, tgId, chatId: ctx.chat?.id, why: 'по его запросу' },
    );

    /**
     * Если продление отменить не удалось — говорим об этом словами.
     *
     * «Готово. Всё удалено.» при продолжающихся списаниях — самая
     * дорогая неправда, какую может сказать этот бот: человек узнает
     * обратное из своего счёта. Право на удаление при этом не отменяется
     * — оно уже исполнено.
     *
     * Реплика — про звёзды, и это не небрежность: в `failed` попадает
     * только рельс, где списывает провайдер (`RENEWAL_CHARGED_BY`), а
     * такой сегодня один. Робокассу отменяет наша же отметка, и в
     * `failed` ей не бывать — прежде бывало, и рублёвый подписчик читал
     * «Мои звёзды → Подписки» (дефект №20 ревизии). Рельс, где подписку
     * держит провайдер, потребует своей реплики со своим путём отмены.
     */
    await ctx.editMessageText(
      renewals.failed.length > 0
        ? texts.privacy.deleteDoneSubscriptionLeft
        : texts.privacy.deleteDone,
    );

    /**
     * Прощание уходит после стирания, и перехват ответов бота кладёт его в
     * хвост разговора заново: ключ с чатом человека жил ещё полчаса после
     * «всё удалено» (проверка Никиты «с нуля», часть Б, 25.09.2026). Хвост
     * стирается ещё раз — после последней реплики.
     */
    await forgetDialog(deps, { tgId, chatId: ctx.chat?.id });
  });

  bot.callbackQuery(DELETE_CANCEL, async (ctx) => {
    await ctx.answerCallbackQuery();
    const texts = await textsOf(ctx.from.id);

    await ctx.editMessageText(texts.privacy.deleteCancelled);
  });
}
