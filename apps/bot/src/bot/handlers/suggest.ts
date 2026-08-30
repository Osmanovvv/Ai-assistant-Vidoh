import { eq } from 'drizzle-orm';
import { type Bot } from 'grammy';
import type { Logger } from 'pino';

import { items } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { resolveRecurrence } from '../../modules/recurrence/recurrence.js';
import { SUGGEST_ACTION } from '../../modules/recurrence/suggest-text.js';
import { resolveOffer } from '../../modules/recurrence/suggestions.repo.js';
import { applyDecision } from '../../modules/resolver/patch.js';
import { undoKeyboard } from './undo.js';
import { fromShortId } from '../../modules/shared/short-id.js';
import { outputContextOf } from '../../modules/users/state.repo.js';
import { findByTgId } from '../../modules/users/users.repo.js';
import { textsFor } from '../../texts/index.js';

/**
 * Ответ на предложение запомнить регулярность (задача 3.8в).
 *
 * Две кнопки, и обе что-то делают. «Да, запомни» выставляет правило —
 * через то же применение, что и правка, значит с ревизией и откатом.
 * «Не надо» запоминается **навсегда**: эта связка больше не предлагается
 * никогда, и в этом половина задачи. Функция, которая раз в неделю
 * переспрашивает одно и то же, становится ненавистной за месяц.
 */

export function registerSuggestHandlers(bot: Bot, db: Database, logger: Logger): void {
  async function acting(tgId: number) {
    const user = await findByTgId(db, tgId);
    if (!user) return undefined;

    const context = await outputContextOf(db, user.id);
    return { userId: user.id, texts: textsFor(context.textProfile), timeZone: context.timeZone };
  }

  bot.callbackQuery(new RegExp(`^${SUGGEST_ACTION.accept}[A-Za-z0-9_-]{22}$`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();

    const active = await acting(ctx.from.id);
    if (!active) return;

    const id = fromShortId(ctx.callbackQuery.data.slice(SUGGEST_ACTION.accept.length));
    if (id === undefined) return;

    const offer = await resolveOffer(db, {
      suggestionId: id,
      userId: active.userId,
      outcome: 'accepted',
    });

    if (!offer) {
      await ctx.editMessageText(active.texts.resolver.questionStale);
      return;
    }

    const [item] = await db.select().from(items).where(eq(items.id, offer.itemId));
    if (!item) {
      await ctx.editMessageText(active.texts.card.gone);
      return;
    }

    /**
     * Правило опирается на срок, а у замеченного дела его может не быть.
     *
     * Тогда якорем становится сегодня: человек только что сказал о деле,
     * и следующее повторение отсчитывается отсюда. Выдумывать прошлое
     * ради ровной даты значило бы поставить напоминание не в тот день.
     */
    const anchor = (item.deadlineAt ?? new Date()).toISOString().slice(0, 10);

    const resolved = resolveRecurrence({
      kind: offer.kind as 'daily' | 'weekly' | 'monthly' | 'yearly',
      interval: offer.interval,
      text: '',
      deadline: anchor,
    });

    const applied = await applyDecision(db, {
      userId: active.userId,
      itemId: offer.itemId,
      action: 'update',
      changes: {
        note: '',
        text: '',
        deadline: anchor,
        deadlineAccuracy: 'day',
        recurrenceKind: offer.kind as 'monthly',
        recurrenceInterval: offer.interval,
        // Слова человека здесь взять неоткуда: правило заметил бот.
        // Поэтому фраза наша, и источник — `noticed`, а не `asked`.
        recurrenceText: resolved.text ?? '',
      },
      timeZone: active.timeZone,
      reason: 'бот заметил повторяемость, человек подтвердил',
      changedBy: 'user',
    });

    logger.info(
      { userId: active.userId, itemId: offer.itemId, applied: applied !== undefined },
      'Человек согласился запомнить регулярность',
    );

    if (applied === undefined) {
      await ctx.editMessageText(active.texts.resolver.rememberedIt);
      return;
    }

    await ctx.editMessageText(active.texts.resolver.rememberedIt, {
      reply_markup: undoKeyboard(applied.revisionId, active.texts),
    });
  });

  bot.callbackQuery(
    new RegExp(`^${SUGGEST_ACTION.decline}[A-Za-z0-9_-]{22}$`, 'u'),
    async (ctx) => {
      await ctx.answerCallbackQuery();

      const active = await acting(ctx.from.id);
      if (!active) return;

      const id = fromShortId(ctx.callbackQuery.data.slice(SUGGEST_ACTION.decline.length));
      if (id === undefined) return;

      await resolveOffer(db, {
        suggestionId: id,
        userId: active.userId,
        outcome: 'declined',
      });

      logger.info({ userId: active.userId }, 'Человек отказался запоминать регулярность');
      await ctx.editMessageText(active.texts.resolver.notRemembered);
    },
  );
}
