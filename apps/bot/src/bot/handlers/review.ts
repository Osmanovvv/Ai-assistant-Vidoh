import { and, eq } from 'drizzle-orm';
import type { Bot } from 'grammy';
import type { Logger } from 'pino';

import { items, type Item } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { isoDateIn } from '../../modules/classifier/dates.js';
import { describeChange } from '../../modules/resolver/change-text.js';
import {
  applyDecision,
  emptyChanges,
  type ApplyAction,
  type ApplyParams,
} from '../../modules/resolver/patch.js';
import { REVIEW_ACTION } from '../../modules/scheduler/digest.js';
import { fromShortId } from '../../modules/shared/short-id.js';
import { outputContextOf } from '../../modules/users/state.repo.js';
import { findByTgId } from '../../modules/users/users.repo.js';
import { textsFor, type TextProfile } from '../../texts/index.js';
import { buttonRefusal, nothingChangedReply } from './item-refusal.js';
import { undoKeyboard } from './undo.js';

/**
 * Кнопки разбора вчерашнего (запрос на изменение №4, решение заказчицы
 * 13.09.2026): «На сегодня», «Позже», «Убрать» под утренним. Каждая —
 * решение с ревизией через `applyDecision`, как кнопки карточки: то же
 * слово в ответ, та же кнопка отката.
 *
 * Разбор — одно сообщение на несколько дел, поэтому нажатие **не
 * переписывает** его (иначе остальные кнопки пропали бы), а отвечает
 * отдельной короткой репликой.
 */

const CODE = '(?<code>[A-Za-z0-9_-]{22})';

export function registerReviewHandlers(bot: Bot, db: Database, logger: Logger): void {
  async function ownItem(
    tgId: number,
    code: string,
  ): Promise<{ item: Item; texts: TextProfile; timeZone: string; userId: string } | undefined> {
    const uuid = fromShortId(code);
    if (uuid === undefined) return undefined;

    const user = await findByTgId(db, tgId);
    if (!user) return undefined;

    const [item] = await db
      .select()
      .from(items)
      .where(and(eq(items.id, uuid), eq(items.userId, user.id)))
      .limit(1);
    if (!item) return undefined;

    const context = await outputContextOf(db, user.id);
    return {
      item,
      texts: textsFor(context.textProfile),
      timeZone: context.timeZone,
      userId: user.id,
    };
  }

  const decide = (
    prefix: string,
    action: ApplyAction,
    reason: string,
    changesFor: (timeZone: string, now: Date) => ApplyParams['changes'],
  ): void => {
    bot.callbackQuery(new RegExp(`^${prefix}:${CODE}$`, 'u'), async (ctx) => {
      await ctx.answerCallbackQuery();

      const active = await ownItem(ctx.from.id, ctx.callbackQuery.data.slice(prefix.length + 1));
      if (!active) {
        await ctx.reply(textsFor(null).card.gone);
        return;
      }

      const now = new Date();
      // Закрытое дело кнопками не трогается (C3) — см. `buttonRefusal`.
      const refused = buttonRefusal(action, active.item, active.texts, active.timeZone, now);
      if (refused !== undefined) {
        await ctx.reply(refused);
        return;
      }

      const outcome = await applyDecision(db, {
        userId: active.userId,
        itemId: active.item.id,
        action,
        changes: changesFor(active.timeZone, now),
        timeZone: active.timeZone,
        now,
        reason,
        changedBy: 'user',
      });

      if (outcome.kind !== 'applied') {
        await ctx.reply(
          outcome.kind === 'unchanged'
            ? nothingChangedReply(action, active.item, active.texts, active.timeZone, now)
            : outcome.kind === 'refused'
              ? active.texts.resolver.deadlineRefused
              : active.texts.card.gone,
        );
        return;
      }

      const { applied } = outcome;
      logger.info(
        { userId: active.userId, action, fields: applied.fields },
        'Запись изменена кнопкой разбора вчерашнего',
      );

      await ctx.reply(describeChange(applied, active.texts, active.timeZone), {
        reply_markup: undoKeyboard(applied.revisionId, active.texts),
      });
    });
  };

  decide(
    REVIEW_ACTION.today,
    'update',
    'нажата кнопка «На сегодня» в разборе вчерашнего',
    (tz, now) => ({
      ...emptyChanges(),
      deadline: isoDateIn(now, tz),
      deadlineAccuracy: 'day',
    }),
  );
  decide(REVIEW_ACTION.later, 'later', 'нажата кнопка «Позже» в разборе вчерашнего', () =>
    emptyChanges(),
  );
  decide(REVIEW_ACTION.drop, 'cancel', 'нажата кнопка «Убрать» в разборе вчерашнего', () =>
    emptyChanges(),
  );
}
