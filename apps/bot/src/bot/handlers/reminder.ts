import { and, eq, isNull } from 'drizzle-orm';
import { type Bot } from 'grammy';
import type { Logger } from 'pino';

import { items, projectSteps } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { isoDateIn, localDateParts, startOfDayInZone } from '../../modules/classifier/dates.js';
import { applyDecision } from '../../modules/resolver/patch.js';
import { POSTPONE_DAYS, REMINDER_ACTION } from '../../modules/scheduler/reminder-actions.js';
import { fromShortId } from '../../modules/shared/short-id.js';
import { outputContextOf } from '../../modules/users/state.repo.js';
import { findByTgId } from '../../modules/users/users.repo.js';
import { textsFor } from '../../texts/index.js';
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

    /**
     * Через `complete`, а не через прямую правку статуса.
     *
     * У регулярного дела выполнение не закрывает запись, а двигает срок
     * вперёд (задача 3.8а). Своя правка статуса здесь молча сломала бы
     * это: «оплатить садик» закрылось бы навсегда после первого месяца.
     */
    const applied = await applyDecision(db, {
      userId: active.userId,
      itemId,
      action: 'complete',
      changes: emptyChanges(),
      timeZone: active.timeZone,
      reason: 'нажата кнопка «Сделано» под напоминанием',
      changedBy: 'user',
    });

    if (applied === undefined) {
      await ctx.editMessageText(active.texts.card.gone);
      return;
    }

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
    const moved = new Date(base.getTime() + POSTPONE_DAYS * 24 * 60 * 60_000);

    const applied = await applyDecision(db, {
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

    if (applied === undefined) {
      await ctx.editMessageText(active.texts.card.gone);
      return;
    }

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

    const applied = await applyDecision(db, {
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

    await ctx.editMessageText(
      active.texts.reminders.projectTaken,
      applied === undefined ? {} : { reply_markup: undoKeyboard(applied.revisionId, active.texts) },
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

/**
 * Пустые изменения: применение ждёт все поля, меняются лишь названные.
 *
 * Точность — `none`, а не `day`: пустой срок применение и так не трогает,
 * но нейтральное значение здесь должно выглядеть нейтральным. Тот, кто
 * однажды добавит сюда срок и забудет про точность, получит `day` молча.
 */
function emptyChanges() {
  return {
    note: '',
    text: '',
    deadline: '',
    deadlineAccuracy: 'none' as const,
    recurrenceKind: 'none' as const,
    recurrenceInterval: 0,
    recurrenceText: '',
  };
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
