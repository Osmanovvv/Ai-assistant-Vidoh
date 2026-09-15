import type { Bot, CallbackQueryContext, Context, InlineKeyboard } from 'grammy';
import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import { recalcDeadlines } from '../../modules/onboarding/backfill.js';
import { AWAITING, setAwaiting, setPreferredName } from '../../modules/onboarding/awaiting.js';
import {
  ACTION,
  finish,
  onboardingStateOf,
  questionFor,
  setEvening,
  setMorning,
  setStep,
  setTimezone,
  timezoneQuestion,
  STEP,
  TIMEZONES,
  type OnboardingState,
  type Question,
} from '../../modules/onboarding/onboarding.service.js';
import { fitKeyboard } from '../../modules/presenter/keyboard.js';
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
 *
 * **Два ответа тянут за собой домиграцию первой выгрузки** (задача 2.14).
 * Пояс — пересчёт сроков, сферы жизни — перенос записей в темы человека.
 * Делается сразу на ответе, а не отложенно: человек в этот момент как раз
 * смотрит на бота, и если что-то пойдёт не так, это будет видно сейчас,
 * а не через неделю в виде напоминания не в тот день.
 */

/**
 * Клавиатура вопроса опроса — общей раскладкой по ширине.
 *
 * **Собственной сборки здесь быть не должно.** До ревизии этапов эта
 * функция строила клавиатуру сама, `new InlineKeyboard()` и `row()` в
 * конце каждой строки, — то есть ровно в том виде, который починка
 * 01.09.2026 отменила: подписи не раскладывались по ширине телефона, а в
 * хвосте оставалась лишняя пустая строка. Раскладку прошло всё, кроме
 * опроса, и заметить это было некому: единственный страж на ширину
 * оборачивал вопросы в `fitKeyboard` сам, а не брал то, что уходит
 * человеку.
 *
 * Наружу — чтобы страж мерил ту же сборку, которой пользуется бот.
 */
export function keyboardOf(question: Question): InlineKeyboard {
  return fitKeyboard(question.rows);
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

    /**
     * Согласие здесь больше не записывается (решение заказчицы
     * 12.09.2026, ответ 13): согласие — только кнопка «Согласна», а
     * опрос начинается после неё (`start.ts`). Прежде первое нажатие в
     * опросе считалось согласием — иначе бот узнавал бы имя, пояс и
     * время, не имея согласия вовсе.
     */
    const state = await onboardingStateOf(db, user.id);
    if (state.step !== expected) {
      logger.debug({ userId: user.id, expected, actual: state.step }, 'Устаревшее нажатие');
      return undefined;
    }

    return { userId: user.id, state };
  }

  /**
   * Пересчёт сроков после первого подтверждения пояса (задача 2.14).
   *
   * Отказ пересчёта не должен ронять онбординг: человек уже ответил, его
   * ответ сохранён, и следующий вопрос он получить обязан. Кривые сроки
   * хуже, чем правильные, но лучше, чем застрявший опрос.
   */
  async function backfillDeadlines(
    userId: string,
    change: { from: string; to: string; firstConfirmation: boolean },
  ): Promise<void> {
    if (!change.firstConfirmation || change.from === change.to) return;

    try {
      const result = await recalcDeadlines(db, userId, change);
      if (result.recalculated > 0) {
        logger.info(
          { userId, ...change, ...result },
          'Сроки первой выгрузки пересчитаны под настоящий пояс',
        );
      }
    } catch (error) {
      logger.error({ err: error, userId, ...change }, 'Не удалось пересчитать сроки');
    }
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
  /**
   * «Да» записывает имя из Telegram как выбранное (видео заказчицы
   * 15.09.2026). Прежде «да» только двигало опрос: считалось, что имя «уже
   * пришло от Telegram», но настройки читают только выбранное имя — и
   * говорили «По имени не зову», а заказчица писала имя заново через
   * настройки. Подтверждение — такой же выбор, как имя своими словами.
   * «Поправлю потом» имени не трогает: человек отложил выбор.
   */
  bot.callbackQuery(ACTION.nameYes, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id, STEP.name);
    if (!active) return;

    await setPreferredName(db, active.userId, active.state.name);
    await advance(ctx, active, STEP.timezone);
  });

  bot.callbackQuery(ACTION.nameLater, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id, STEP.name);
    if (!active) return;

    await advance(ctx, active, STEP.timezone);
  });

  /**
   * «Напишу своё» и «Другое время» (задача 3.61).
   *
   * Шаг **не двигается**: человек ещё не ответил, он только выбрал способ
   * ответить. Реплика правится на просьбу написать, кнопки снимаются —
   * иначе рядом с просьбой остались бы кнопки прежнего вопроса.
   *
   * Ожидание живёт четверть часа и снимается само, если присланное на
   * ответ не похоже: подробности в `awaiting.ts`.
   */
  const asksForWords: readonly { action: string; step: number; awaiting: string }[] = [
    { action: ACTION.nameOwn, step: STEP.name, awaiting: AWAITING.name },
    { action: ACTION.morningOwn, step: STEP.morning, awaiting: AWAITING.morning },
    { action: ACTION.eveningOwn, step: STEP.evening, awaiting: AWAITING.evening },
  ];

  for (const { action, step, awaiting } of asksForWords) {
    bot.callbackQuery(action, async (ctx) => {
      await ctx.answerCallbackQuery();
      const active = await acting(ctx.from.id, step);
      if (!active) return;

      await setAwaiting(db, active.userId, awaiting);

      const { onboarding } = active.state.texts;
      await ctx.editMessageText(step === STEP.name ? onboarding.nameAsk : onboarding.timeAsk);
    });
  }

  // ── Часовой пояс ──────────────────────────────────────────────────────
  bot.callbackQuery(ACTION.timezoneMoscow, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id, STEP.timezone);
    if (!active) return;

    // Пояс тот же, что действовал по умолчанию: пересчитывать нечего,
    // но признак подтверждения всё равно ставится — он нужен 2.14, чтобы
    // не пересчитывать сроки при переезде в настройках.
    const change = await setTimezone(db, active.userId, 'Europe/Moscow');
    await backfillDeadlines(active.userId, change);
    await advance(ctx, active, STEP.morning);
  });

  bot.callbackQuery(ACTION.timezoneOther, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id, STEP.timezone);
    if (!active) return;

    // Шаг тот же: человек ещё не выбрал город, и уходить с шага нельзя.
    await show(ctx, timezoneQuestion(active.state.texts));
  });

  /**
   * «Напишу свой город» (задача 3.70, замечание проджекта).
   *
   * Шаг не двигается: человек ещё не ответил, он выбрал способ ответить.
   * Дальше название приходит сообщением, и пояс считает справочник —
   * подробности в `cities.ts`.
   */
  bot.callbackQuery(ACTION.timezoneOwn, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id, STEP.timezone);
    if (!active) return;

    await setAwaiting(db, active.userId, AWAITING.city);
    await ctx.editMessageText(active.state.texts.onboarding.cityAsk);
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

    const change = await setTimezone(db, active.userId, zone);
    await backfillDeadlines(active.userId, change);
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

  /**
   * Вечер — последний вопрос (правка заказчицы 14.09.2026, п. 1.1).
   *
   * Прежде за ним шёл шаг «какие сферы важны». Она его убрала: сферы —
   * внутренняя организация бота, он заводит их сам по содержанию
   * (`topics/adopt.ts`), а человек при желании правит в настройках.
   * Базовый набор появляется на первой разобранной выгрузке (3.43), и
   * опросу здесь делать нечего — только закрыться.
   */
  async function complete(
    ctx: CallbackQueryContext<Context>,
    active: { userId: string; state: OnboardingState },
  ): Promise<void> {
    await finish(db, active.userId, new Date());
    logger.info({ userId: active.userId }, 'Онбординг пройден');
    await ctx.editMessageText(active.state.texts.onboarding.finished);
  }

  bot.callbackQuery(ACTION.eveningOff, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id, STEP.evening);
    if (!active) return;

    await setEvening(db, active.userId, null);
    await complete(ctx, active);
  });

  bot.callbackQuery(new RegExp(`^${ACTION.eveningPrefix}`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id, STEP.evening);
    if (!active) return;

    const time = ctx.callbackQuery.data.slice(ACTION.eveningPrefix.length);
    if (!TIME_RE.test(time)) return;

    await setEvening(db, active.userId, time);
    await complete(ctx, active);
  });
}
