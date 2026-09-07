import { InputFile, type Bot } from 'grammy';
import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import { deleteUserData, exportUserData } from '../../modules/privacy/privacy.service.js';
import { stopAllRenewals } from '../../modules/billing/subscription.service.js';
import type { PaymentProvider } from '../../modules/billing/provider.js';
import type { Rail } from '../../modules/billing/tariffs.js';
import type { TopicGateway } from '../../modules/topics/gateway.js';
import { removeThread } from '../../modules/topics/topics.service.js';
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

    /**
     * Продление отменяется **до** удаления и **до** транзакции.
     *
     * До удаления — потому что ключ отмены уходит каскадом вместе с
     * человеком. До транзакции — потому что держать замок на его строках,
     * пока отвечает Telegram, значило бы поставить право на удаление в
     * зависимость от чужой доступности.
     */
    const renewals =
      deps.providers === undefined
        ? { stopped: [], failed: [] }
        : await stopAllRenewals(db, {
            userId: user.id,
            tgId,
            providers: deps.providers,
            logger,
          });

    const report = await deleteUserData(db, user.id);
    logger.info(
      {
        tgId,
        messages: report.messages,
        dumps: report.dumps,
        threads: report.threadIds.length,
        renewalsStopped: renewals.stopped.length,
        renewalsLeft: renewals.failed.length,
      },
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
      /**
       * Итог уборки — в журнал на уровне `info`, отказы — `warn`.
       *
       * Раньше отказ писался как `debug`, то есть в бою был невидим: когда
       * 03.09.2026 человек после удаления увидел ветки на месте, ответить,
       * удалял ли их бот, было нечем — пришлось звать Telegram напрямую.
       * (Удалял: ветки были уже сняты, а клиент показывал кэш.)
       */
      let deleted = 0;
      let gone = 0;
      let failed = 0;

      for (const threadId of report.threadIds) {
        try {
          const outcome = await removeThread(
            { db, gateway: deps.topics, logger },
            { chatId, threadId },
          );
          if (outcome === 'deleted') deleted++;
          else gone++;
        } catch (error) {
          failed++;
          logger.warn({ err: error, threadId }, 'Ветка не удалилась, данные это не меняет');
        }
      }

      logger.info({ tgId, deleted, gone, failed }, 'Ветки после удаления данных');
    }

    /**
     * Если продление отменить не удалось — говорим об этом словами.
     *
     * «Готово. Всё удалено.» при продолжающихся списаниях — самая
     * дорогая неправда, какую может сказать этот бот: человек узнает
     * обратное из своего счёта. Право на удаление при этом не отменяется
     * — оно уже исполнено.
     */
    await ctx.editMessageText(
      renewals.failed.length > 0
        ? texts.privacy.deleteDoneSubscriptionLeft
        : texts.privacy.deleteDone,
    );
  });

  bot.callbackQuery(DELETE_CANCEL, async (ctx) => {
    await ctx.answerCallbackQuery();
    const texts = await textsOf(ctx.from.id);

    await ctx.editMessageText(texts.privacy.deleteCancelled);
  });
}
