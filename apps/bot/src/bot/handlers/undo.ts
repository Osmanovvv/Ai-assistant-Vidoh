import { InlineKeyboard, type Bot } from 'grammy';
import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import { revertRevision } from '../../modules/resolver/revisions.repo.js';
import { outputContextOf } from '../../modules/users/state.repo.js';
import { findByTgId } from '../../modules/users/users.repo.js';
import { textsFor, type TextProfile } from '../../texts/index.js';
import { fromShortId, toShortId } from '../short-id.js';

/**
 * Откат в один тап (§7.3 ТЗ, задача 3.4).
 *
 * «Пользовательница должна иметь возможность откатить любое
 * автоматическое решение за один тап.»
 *
 * Один тап — значит кнопка прямо под сообщением об изменении, а не путь
 * через меню. Поэтому обработчик отдельный, а не часть карточки: карточку
 * ещё надо найти.
 *
 * **Короткий код ревизии, а не UUID** — правило из 2.18: в `callback_data`
 * шестьдесят четыре байта, и UUID съедает больше половины.
 *
 * **Код не заменяет проверку прав.** Он приходит снаружи и подбирается;
 * владелец сверяется в `revertRevision`.
 */

export const UNDO_PREFIX = 'u:';

/** Кнопка отмены под сообщением об изменении. */
export function undoKeyboard(revisionId: string, texts: TextProfile): InlineKeyboard {
  return new InlineKeyboard().text(
    texts.resolver.buttonUndo,
    `${UNDO_PREFIX}${toShortId(revisionId)}`,
  );
}

export function registerUndoHandlers(bot: Bot, db: Database, logger: Logger): void {
  bot.callbackQuery(new RegExp(`^${UNDO_PREFIX}[A-Za-z0-9_-]{22}$`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();

    const user = await findByTgId(db, ctx.from.id);
    if (!user) return;

    const context = await outputContextOf(db, user.id);
    const texts = textsFor(context.textProfile);

    const revisionId = fromShortId(ctx.callbackQuery.data.slice(UNDO_PREFIX.length));

    // Код не разобрался: подделка или обрезанное нажатие. Для человека
    // это то же самое, что исчезнувшее изменение.
    const outcome =
      revisionId === undefined
        ? ({ kind: 'gone' } as const)
        : await revertRevision(db, { revisionId, userId: user.id });

    /**
     * Клавиатура снимается во всех исходах, включая неуспешные.
     *
     * Оставить кнопку — значит пообещать, что нажатие ещё что-то делает.
     * После отката делать нечего, а после «уже отменено» — тем более.
     */
    const reply = {
      reverted: texts.resolver.undone,
      already: texts.resolver.alreadyUndone,
      gone: texts.resolver.undoGone,
    }[outcome.kind];

    await ctx.editMessageText(reply);

    logger.info(
      { userId: user.id, revisionId: revisionId ?? null, outcome: outcome.kind },
      'Человек нажал отмену изменения',
    );
  });
}
