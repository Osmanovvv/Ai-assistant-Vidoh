import { and, eq, isNull } from 'drizzle-orm';
import { type Bot } from 'grammy';
import type { Logger } from 'pino';

import { items, projectSteps } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import {
  isoDateIn,
  localDateParts,
  startOfDayAfter,
  startOfDayInZone,
} from '../../modules/classifier/dates.js';
import { applyDecision, emptyChanges } from '../../modules/resolver/patch.js';
import { POSTPONE_DAYS, REMINDER_ACTION } from '../../modules/scheduler/reminder-actions.js';
import { fromShortId } from '../../modules/shared/short-id.js';
import { outputContextOf } from '../../modules/users/state.repo.js';
import { findByTgId } from '../../modules/users/users.repo.js';
import { textsFor } from '../../texts/index.js';
import { buttonRefusal, nothingChangedReply } from './item-refusal.js';
import { undoKeyboard } from './undo.js';

/**
 * Кнопки под напоминаниями (§11 ТЗ, задачи 3.13 и 3.16).
 *
 * «Сделано» и «Перенести» — обе делают ровно то, что обещают, и обе идут
 * через то же применение, что и правка голосом. Значит, у каждой есть
 * ревизия и откат (инвариант 7), и повторение того же кода здесь не нужно.
 *
 * Кнопка, которая только закрывает сообщение, учит не нажимать кнопки
 * вообще — и следующее напоминание человек уже проигнорирует.
 */

const CODE = '[A-Za-z0-9_-]{22}';

export function registerReminderHandlers(bot: Bot, db: Database, logger: Logger): void {
  async function acting(tgId: number) {
    const user = await findByTgId(db, tgId);
    if (!user) return undefined;

    const context = await outputContextOf(db, user.id);

    return { userId: user.id, texts: textsFor(context.textProfile), timeZone: context.timeZone };
  }

  /** Код записи из нажатия. Чужую запись не тронет: владелец в применении. */
  function itemIdOf(data: string, prefix: string): string | undefined {
    return fromShortId(data.slice(prefix.length));
  }

  // ── «Сделано» ─────────────────────────────────────────────────────────
  bot.callbackQuery(new RegExp(`^${REMINDER_ACTION.done}${CODE}$`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();

    const active = await acting(ctx.from.id);
    if (!active) return;

    const itemId = itemIdOf(ctx.callbackQuery.data, REMINDER_ACTION.done);
    if (itemId === undefined) return;

    const now = new Date();
    const [item] = await db
      .select()
      .from(items)
      .where(and(eq(items.id, itemId), eq(items.userId, active.userId)))
      .limit(1);

    if (!item) {
      await ctx.editMessageText(active.texts.card.gone);
      return;
    }

    // Закрытое голосом днём дело вечером под утренним напоминанием — «уже
    // сделано», а не «больше нет» (ревизия этапа 3, C5).
    const refused = buttonRefusal('complete', item, active.texts, active.timeZone, now);
    if (refused !== undefined) {
      await ctx.editMessageText(refused);
      return;
    }

    /**
     * Через `complete`, а не через прямую правку статуса.
     *
     * У регулярного дела выполнение не закрывает запись, а двигает срок
     * вперёд (задача 3.8а). Своя правка статуса здесь молча сломала бы
     * это: «оплатить садик» закрылось бы навсегда после первого месяца.
     */
    const outcome = await applyDecision(db, {
      userId: active.userId,
      itemId,
      action: 'complete',
      changes: emptyChanges(),
      timeZone: active.timeZone,
      now,
      reason: 'нажата кнопка «Сделано» под напоминанием',
      changedBy: 'user',
    });

    if (outcome.kind !== 'applied') {
      await ctx.editMessageText(
        outcome.kind === 'unchanged'
          ? nothingChangedReply('complete', item, active.texts, active.timeZone, now)
          : outcome.kind === 'refused'
            ? active.texts.resolver.deadlineRefused
            : active.texts.card.gone,
      );
      return;
    }

    const { applied } = outcome;

    logger.info({ userId: active.userId, itemId }, 'Дело закрыто кнопкой под напоминанием');

    await ctx.editMessageText(active.texts.reminders.done, {
      reply_markup: undoKeyboard(applied.revisionId, active.texts),
    });
  });

  // ── «Перенести» ───────────────────────────────────────────────────────
  bot.callbackQuery(new RegExp(`^${REMINDER_ACTION.postpone}${CODE}$`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();

    const active = await acting(ctx.from.id);
    if (!active) return;

    const itemId = itemIdOf(ctx.callbackQuery.data, REMINDER_ACTION.postpone);
    if (itemId === undefined) return;

    const [item] = await db
      .select({ deadlineAt: items.deadlineAt })
      .from(items)
      .where(and(eq(items.id, itemId), eq(items.userId, active.userId)))
      .limit(1);

    if (!item) {
      await ctx.editMessageText(active.texts.card.gone);
      return;
    }

    /**
     * Считаем от срока, а не от сегодня.
     *
     * Срок мог быть вчерашним: напоминание накануне ушло, а нажали на
     * него утром. «Завтра» от сегодня и «завтра» от вчерашнего срока —
     * разные дни, и человек имел в виду первое.
     */
    const from = item.deadlineAt ?? new Date();
    const base = from.getTime() < Date.now() ? new Date() : from;
    // День вперёд, а не 24 часа: через перевод стрелок это не одно и то
    // же (ревизия этапа 3, D6).
    const moved = startOfDayAfter(base, POSTPONE_DAYS, active.timeZone);

    const outcome = await applyDecision(db, {
      userId: active.userId,
      itemId,
      action: 'update',
      changes: {
        ...emptyChanges(),
        deadline: isoDateIn(moved, active.timeZone),
        deadlineAccuracy: 'day',
      },
      timeZone: active.timeZone,
      reason: 'нажата кнопка «Перенести» под напоминанием',
      changedBy: 'user',
    });

    if (outcome.kind !== 'applied') {
      await ctx.editMessageText(
        outcome.kind === 'unchanged'
          ? active.texts.resolver.unchanged
          : outcome.kind === 'refused'
            ? active.texts.resolver.deadlineRefused
            : active.texts.card.gone,
      );
      return;
    }

    const { applied } = outcome;

    await ctx.editMessageText(
      active.texts.reminders.postponed(dayInWords(moved, active.timeZone)),
      {
        reply_markup: undoKeyboard(applied.revisionId, active.texts),
      },
    );
  });

  // ── Вопрос про застрявший проект ──────────────────────────────────────
  bot.callbackQuery(new RegExp(`^${REMINDER_ACTION.projectTake}${CODE}$`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();

    const active = await acting(ctx.from.id);
    if (!active) return;

    const itemId = itemIdOf(ctx.callbackQuery.data, REMINDER_ACTION.projectTake);
    if (itemId === undefined) return;

    /**
     * «Возьмусь» ставит срок ближайшему шагу на сегодня.
     *
     * Проект стоял неделю не потому, что человек забыл, а потому что
     * следующий шаг не был ничьим делом на конкретный день. Ответ «да»
     * без изменения состояния оставил бы всё как было — и через пять
     * дней тот же вопрос пришёл бы снова.
     */
    const [step] = await db
      .select({ id: projectSteps.id })
      .from(projectSteps)
      .where(and(eq(projectSteps.itemId, itemId), isNull(projectSteps.doneAt)))
      .limit(1);

    if (!step) {
      await ctx.editMessageText(active.texts.project.finished);
      return;
    }

    const outcome = await applyDecision(db, {
      userId: active.userId,
      itemId,
      action: 'update',
      changes: {
        ...emptyChanges(),
        deadline: isoDateIn(new Date(), active.timeZone),
        deadlineAccuracy: 'day',
      },
      timeZone: active.timeZone,
      reason: 'человек согласился взяться за проект',
      changedBy: 'user',
    });

    // Срок уже сегодня — менять нечего, но «взялась» всё равно правда.
    await ctx.editMessageText(
      active.texts.reminders.projectTaken,
      outcome.kind === 'applied'
        ? { reply_markup: undoKeyboard(outcome.applied.revisionId, active.texts) }
        : {},
    );
  });

  bot.callbackQuery(new RegExp(`^${REMINDER_ACTION.projectLater}${CODE}$`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();

    const active = await acting(ctx.from.id);
    if (!active) return;

    /**
     * «Не сейчас» ничего не меняет — и это правильный ответ.
     *
     * Следующий вопрос про этот проект придёт не раньше чем через пять
     * дней: отсчёт ведётся от отправленного напоминания, а оно уже
     * записано отправленным (задача 3.13).
     */
    await ctx.editMessageText(active.texts.reminders.projectLater);
  });
}

/** «завтра» или «2 сентября» — то, что человек прочитает в ответе. */
function dayInWords(at: Date, timeZone: string): string {
  const today = startOfDayInZone(localDateParts(new Date(), timeZone), timeZone);
  const target = startOfDayInZone(localDateParts(at, timeZone), timeZone);
  const days = Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60_000));

  if (days === 1) return 'завтра';
  if (days === 0) return 'сегодня';

  return new Intl.DateTimeFormat('ru-RU', { timeZone, day: 'numeric', month: 'long' }).format(at);
}
