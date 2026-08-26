import { InlineKeyboard, type Bot, type CallbackQueryContext, type Context } from 'grammy';
import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import {
  ACTION,
  chosenFromLabels,
  createChosenTopics,
  finish,
  onboardingStateOf,
  questionFor,
  setEvening,
  setMorning,
  setStep,
  setTimezone,
  timezoneQuestion,
  topicRows,
  STEP,
  TIMEZONES,
  type OnboardingState,
  type Question,
} from '../../modules/onboarding/onboarding.service.js';
import { findByTgId } from '../../modules/users/users.repo.js';

/**
 * Ответы онбординга (задача 2.13).
 *
 * Все ответы приходят нажатиями, а не сообщениями — почему именно так,
 * подробно в `onboarding.service.ts`. Здесь только перевод нажатия в
 * следующий вопрос.
 *
 * Каждый ответ правит ту же реплику, а не отправляет новую: §9.2 и §13.9
 * не любят простыню из пяти сообщений подряд, и человеку видно, что
 * вопросов было немного.
 *
 * **Устаревшее нажатие не откатывает онбординг назад.** Кнопки остаются в
 * истории чата, и нажать «Да, Москва» можно через неделю. Без сверки с
 * текущим шагом такое нажатие вернуло бы человека к вопросу про утро и
 * заодно перезаписало бы уже выбранный пояс. Поэтому каждый обработчик
 * начинается с проверки: тот ли сейчас шаг.
 */

function keyboardOf(question: Question): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const row of question.rows) {
    for (const button of row) keyboard.text(button.label, button.action);
    keyboard.row();
  }

  return keyboard;
}

/** Подписи кнопок текущей реплики: в них живёт состояние выбора сфер. */
function labelsOf(ctx: CallbackQueryContext<Context>): string[] {
  return (ctx.callbackQuery.message?.reply_markup?.inline_keyboard ?? [])
    .flat()
    .map((button) => button.text);
}

export function registerOnboardingHandlers(bot: Bot, db: Database, logger: Logger): void {
  async function show(
    ctx: CallbackQueryContext<Context>,
    question: Question | undefined,
  ): Promise<void> {
    if (!question) return;
    await ctx.editMessageText(question.text, { reply_markup: keyboardOf(question) });
  }

  /**
   * Кто нажал и на том ли он шаге.
   *
   * Возвращает `undefined`, если человека нет или нажатие устарело —
   * тогда обработчик молча заканчивается. Крутилка на кнопке уже снята
   * ответом на запрос, и ничего странного человек не увидит.
   */
  async function acting(
    tgId: number,
    expected: number,
  ): Promise<{ userId: string; state: OnboardingState } | undefined> {
    const user = await findByTgId(db, tgId);
    if (!user) return undefined;

    const state = await onboardingStateOf(db, user.id);
    if (state.step !== expected) {
      logger.debug({ userId: user.id, expected, actual: state.step }, 'Устаревшее нажатие');
      return undefined;
    }

    return { userId: user.id, state };
  }

  async function advance(
    ctx: CallbackQueryContext<Context>,
    active: { userId: string; state: OnboardingState },
    nextStep: number,
  ): Promise<void> {
    await setStep(db, active.userId, nextStep);
    await show(ctx, questionFor(nextStep, { texts: active.state.texts, name: active.state.name }));
  }

  // ── Имя ───────────────────────────────────────────────────────────────
  for (const action of [ACTION.nameYes, ACTION.nameLater]) {
    bot.callbackQuery(action, async (ctx) => {
      await ctx.answerCallbackQuery();
      const active = await acting(ctx.from.id, STEP.name);
      if (!active) return;

      // Имя не меняется ни в одном из двух случаев: «да» подтверждает то,
      // что уже пришло от Telegram, «поправлю потом» отправляет в
      // настройки (задача 4.9). Спрашивать его текстом нельзя — ответ
      // ушёл бы в буфер выгрузки.
      await advance(ctx, active, STEP.timezone);
    });
  }

  // ── Часовой пояс ──────────────────────────────────────────────────────
  bot.callbackQuery(ACTION.timezoneMoscow, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id, STEP.timezone);
    if (!active) return;

    await setTimezone(db, active.userId, 'Europe/Moscow');
    await advance(ctx, active, STEP.morning);
  });

  bot.callbackQuery(ACTION.timezoneOther, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id, STEP.timezone);
    if (!active) return;

    // Шаг тот же: человек ещё не выбрал город, и уходить с шага нельзя.
    await show(ctx, timezoneQuestion(active.state.texts));
  });

  bot.callbackQuery(new RegExp(`^${ACTION.timezonePrefix}`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id, STEP.timezone);
    if (!active) return;

    const zone = ctx.callbackQuery.data.slice(ACTION.timezonePrefix.length);

    // Пояс сверяется со списком, а не берётся из нажатия как есть:
    // callback_data приходит снаружи, и доверять ей нельзя. Строка,
    // попавшая в настройку, сломала бы расчёт всех сроков.
    if (!TIMEZONES.some((item) => item.zone === zone)) {
      logger.warn({ zone }, 'Неизвестный часовой пояс в нажатии, пропускаю');
      return;
    }

    await setTimezone(db, active.userId, zone);
    await advance(ctx, active, STEP.morning);
  });

  // ── Время напоминаний ─────────────────────────────────────────────────
  const TIME_RE = /^\d{2}:\d{2}$/u;

  bot.callbackQuery(new RegExp(`^${ACTION.morningPrefix}`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id, STEP.morning);
    if (!active) return;

    const time = ctx.callbackQuery.data.slice(ACTION.morningPrefix.length);
    if (!TIME_RE.test(time)) return;

    await setMorning(db, active.userId, time);
    await advance(ctx, active, STEP.evening);
  });

  bot.callbackQuery(ACTION.eveningOff, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id, STEP.evening);
    if (!active) return;

    await setEvening(db, active.userId, null);
    await advance(ctx, active, STEP.topics);
  });

  bot.callbackQuery(new RegExp(`^${ACTION.eveningPrefix}`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id, STEP.evening);
    if (!active) return;

    const time = ctx.callbackQuery.data.slice(ACTION.eveningPrefix.length);
    if (!TIME_RE.test(time)) return;

    await setEvening(db, active.userId, time);
    await advance(ctx, active, STEP.topics);
  });

  // ── Сферы жизни ───────────────────────────────────────────────────────
  bot.callbackQuery(new RegExp(`^${ACTION.topicPrefix}`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id, STEP.topics);
    if (!active) return;

    const name = ctx.callbackQuery.data.slice(ACTION.topicPrefix.length);
    const { texts } = active.state;

    // Отмеченное читается из клавиатуры самой реплики: состояние выбора
    // живёт там, а не в базе. Так оно не теряется при перезапуске и не
    // требует колонки под промежуточный выбор.
    const chosen = new Set(chosenFromLabels(labelsOf(ctx), texts));

    if (chosen.has(name)) chosen.delete(name);
    else chosen.add(name);

    await ctx.editMessageText(texts.onboarding.topics, {
      reply_markup: keyboardOf({
        text: texts.onboarding.topics,
        rows: topicRows(texts, [...chosen]),
      }),
    });
  });

  bot.callbackQuery(ACTION.topicsDone, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id, STEP.topics);
    if (!active) return;

    const { userId, state } = active;
    const chosen = chosenFromLabels(labelsOf(ctx), state.texts);
    const result = await createChosenTopics(db, userId, chosen);
    await finish(db, userId, new Date());

    logger.info(
      { userId, created: result.created, fallback: result.fallback },
      'Онбординг пройден',
    );

    await ctx.editMessageText(
      result.fallback ? state.texts.onboarding.finishedDefault : state.texts.onboarding.finished,
    );
  });
}
