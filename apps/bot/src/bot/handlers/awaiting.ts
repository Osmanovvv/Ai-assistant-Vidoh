import { InlineKeyboard, type Context } from 'grammy';
import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import {
  awaitingOf,
  parseName,
  parseTime,
  setAwaiting,
  setPreferredName,
} from '../../modules/onboarding/awaiting.js';
import {
  onboardingStateOf,
  questionFor,
  setEvening,
  setMorning,
  setStep,
  STEP,
  type Question,
} from '../../modules/onboarding/onboarding.service.js';
import { applyDecision } from '../../modules/resolver/patch.js';
import { describeChange, undoButtons } from '../../modules/resolver/change-text.js';
import { outputContextOf } from '../../modules/users/state.repo.js';
import { textsFor } from '../../texts/index.js';

/**
 * Приём ответа словами (задача 3.61).
 *
 * Зовётся из `incomingMiddleware` **до** того, как сообщение попадёт в
 * буфер выгрузки. Возвращает `true`, если сообщение было ответом и
 * дальше идти ему не надо.
 *
 * **Пока бот ничего не ждёт, эта функция стоит один запрос в базу и
 * возвращает `false`.** Ни одна проверка, ни одна догадка о содержимом
 * не делается: путь сообщения остаётся прежним. Это главное требование к
 * ней — она стоит на горячем пути каждого входящего.
 *
 * **Не съедает молча.** Присланное не похоже на ответ — ожидание
 * снимается, человеку говорится, что бот не понял, и сообщение уходит в
 * разбор обычным путём. Мысль не теряется ни в одном случае.
 */

export interface AwaitingDeps {
  readonly db: Database;
  readonly logger: Logger;
}

function keyboardOf(question: Question): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const row of question.rows) {
    for (const button of row) keyboard.text(button.label, button.action);
    keyboard.row();
  }

  return keyboard;
}

export function consumeAwaited(deps: AwaitingDeps) {
  const { db, logger } = deps;

  /**
   * Следующий вопрос опроса — **новым сообщением**, а не правкой прежнего.
   *
   * Кнопки правят свою же реплику, и это верно: обмен один. Здесь человек
   * ответил сообщением, то есть в чате уже появилась его строка, и
   * править что-то выше неё значило бы ответить не туда, куда он смотрит.
   */
  async function askNext(ctx: Context, userId: string, step: number): Promise<void> {
    await setStep(db, userId, step);

    const state = await onboardingStateOf(db, userId);
    const question = questionFor(step, { texts: state.texts, name: state.name });
    if (!question) return;

    await ctx.reply(question.text, { reply_markup: keyboardOf(question) });
  }

  return async (ctx: Context, userId: string): Promise<boolean> => {
    const text = ctx.message?.text?.trim();
    if (text === undefined || text === '') return false;

    const state = await awaitingOf(db, userId);

    if (state.expired) {
      // Нажал и вернулся через сутки: это уже новая мысль, а не ответ.
      await setAwaiting(db, userId, null);
      return false;
    }

    const awaiting = state.awaiting;
    if (awaiting === undefined) return false;

    const texts = textsFor((await outputContextOf(db, userId)).textProfile);

    // ── Имя ──────────────────────────────────────────────────────────────
    if (awaiting.kind === 'name') {
      const name = parseName(text);

      if (name === undefined) {
        await setAwaiting(db, userId, null);
        await ctx.reply(texts.onboarding.nameNotUnderstood);
        return false;
      }

      await setPreferredName(db, userId, name);
      // Видно сразу, как теперь зовут: разбор имени строгий, но не
      // безошибочный, и промах человек должен заметить в ту же секунду.
      await ctx.reply(texts.onboarding.nameSaved(name));

      logger.info({ userId }, 'Имя задано словами');
      await askNext(ctx, userId, STEP.timezone);
      return true;
    }

    // ── Время напоминаний ────────────────────────────────────────────────
    if (awaiting.kind === 'morning' || awaiting.kind === 'evening') {
      const time = parseTime(text);

      if (time === undefined) {
        await setAwaiting(db, userId, null);
        await ctx.reply(texts.onboarding.timeNotUnderstood);
        return false;
      }

      await setAwaiting(db, userId, null);

      if (awaiting.kind === 'morning') {
        await setMorning(db, userId, time);
        await ctx.reply(texts.onboarding.morningSaved(time));
        logger.info({ userId, time }, 'Утреннее время задано словами');
        await askNext(ctx, userId, STEP.evening);
        return true;
      }

      await setEvening(db, userId, time);
      await ctx.reply(texts.onboarding.eveningSaved(time));
      logger.info({ userId, time }, 'Вечернее время задано словами');
      await askNext(ctx, userId, STEP.topics);
      return true;
    }

    // ── Правка записи словами ────────────────────────────────────────────
    if (awaiting.kind === 'edit' && awaiting.itemId !== undefined) {
      await setAwaiting(db, userId, null);

      /**
       * Правится **заголовок**, и только он.
       *
       * Статус и срок у карточки уже на кнопках, а разбирать «перенеси на
       * вторник» словами умеет резолвер на обычном пути. Здесь ровно то,
       * чего кнопкой сделать было нельзя: переписать текст дела.
       */
      const context = await outputContextOf(db, userId);

      const applied = await applyDecision(db, {
        userId,
        itemId: awaiting.itemId,
        action: 'update',
        mode: 'replace',
        // Меняется один заголовок; остальные поля пустые, как их
        // присылает резолвер, когда правит только текст.
        changes: {
          note: '',
          text,
          deadline: '',
          deadlineAccuracy: 'none',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        spoken: text,
        timeZone: context.timeZone,
        reason: 'правка словами из карточки',
        changedBy: 'user',
      });

      if (applied === undefined) {
        // Записи нет или менять нечего: сказать честно и не трогать разбор.
        await ctx.reply(texts.card.editNotApplied);
        return true;
      }

      logger.info({ userId, itemId: awaiting.itemId }, 'Запись поправлена словами из карточки');

      await ctx.reply(describeChange(applied, texts, context.timeZone), {
        reply_markup: new InlineKeyboard(
          undoButtons(applied.revisionId, texts).map((button) => [
            { text: button.label, callback_data: button.action },
          ]),
        ),
      });

      return true;
    }

    return false;
  };
}
