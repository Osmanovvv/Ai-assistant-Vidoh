import { InlineKeyboard, type Bot } from 'grammy';
import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import type { AiClientDeps } from '../../modules/ai/client.js';
import type { ResolverAnswer } from '../../modules/ai/schemas/index.js';
import { classifyUnits } from '../../modules/classifier/classifier.service.js';
import { saveDraft, saveItems } from '../../modules/items/items.repo.js';
import { applyDecision } from '../../modules/resolver/patch.js';
import { answerQuestion } from '../../modules/resolver/questions.repo.js';
import { topicsFor } from '../../modules/topics/topics.repo.js';
import { outputContextOf } from '../../modules/users/state.repo.js';
import { findByTgId } from '../../modules/users/users.repo.js';
import { textsFor, type TextProfile } from '../../texts/index.js';
import { fromShortId, toShortId } from '../../modules/shared/short-id.js';
import { describeChange } from '../../modules/resolver/change-text.js';
import { undoKeyboard } from './undo.js';

/**
 * Уточняющий вопрос: две кнопки (§7.3 ТЗ, задача 3.5).
 *
 * «Бот задаёт один короткий вопрос с двумя кнопками, подставляя в текст
 * заголовок найденной записи: „Это про запись к врачу или отдельная
 * история?" Кнопки: „Добавить к прошлой" и „Это новое".»
 *
 * **Оба ответа что-то делают, и оба безопасны.** «Добавить к прошлой»
 * применяет отложенное изменение и оставляет ревизию — значит его тоже
 * можно откатить. «Это новое» заводит запись из сказанного: сегмент
 * хранился именно для этого.
 *
 * **Нажатие снятого вопроса не падает.** Кнопка живёт в чате вечно, а
 * вопрос снимается новой выгрузкой и по времени. §7.3: «продукт не имеет
 * права превращаться в допрос» — к снятому бот не возвращается, но и
 * молчать в ответ на нажатие нельзя.
 */

export const QUESTION_ACTION = {
  attach: 'q:a:',
  separate: 'q:s:',
} as const;

export interface QuestionDeps {
  readonly db: Database;
  readonly ai: AiClientDeps;
  readonly logger: Logger;
}

/** Вопрос с двумя кнопками. Заголовок записи — в тексте, как требует §7.3. */
export function questionMessage(
  questionId: string,
  itemTitle: string,
  texts: TextProfile,
): { readonly text: string; readonly keyboard: InlineKeyboard } {
  const code = toShortId(questionId);

  return {
    text: texts.resolver.question(itemTitle),
    keyboard: new InlineKeyboard()
      .text(texts.resolver.buttonAttach, `${QUESTION_ACTION.attach}${code}`)
      .text(texts.resolver.buttonSeparate, `${QUESTION_ACTION.separate}${code}`),
  };
}

export function registerQuestionHandlers(bot: Bot, deps: QuestionDeps): void {
  const { db, logger } = deps;

  async function acting(tgId: number) {
    const user = await findByTgId(db, tgId);
    if (!user) return undefined;

    const context = await outputContextOf(db, user.id);
    return { userId: user.id, texts: textsFor(context.textProfile), timeZone: context.timeZone };
  }

  bot.callbackQuery(
    new RegExp(`^${QUESTION_ACTION.attach}[A-Za-z0-9_-]{22}$`, 'u'),
    async (ctx) => {
      await ctx.answerCallbackQuery();

      const active = await acting(ctx.from.id);
      if (!active) return;

      const questionId = fromShortId(ctx.callbackQuery.data.slice(QUESTION_ACTION.attach.length));

      const outcome =
        questionId === undefined
          ? ({ kind: 'stale' } as const)
          : await answerQuestion(db, { questionId, userId: active.userId, outcome: 'attached' });

      if (outcome.kind === 'stale') {
        await ctx.editMessageText(active.texts.resolver.questionStale);
        return;
      }

      const question = outcome.question;
      const applied = await applyDecision(db, {
        userId: active.userId,
        itemId: question.itemId,
        // Действие сохранялось строкой: в таблице ему незачем знать про
        // перечисление резолвера, а «новая мысль» сюда не попадает.
        action:
          question.action === 'complete' || question.action === 'cancel'
            ? question.action
            : 'update',
        changes: question.changes as ResolverAnswer['changes'],
        timeZone: active.timeZone,
        reason: 'человек подтвердил кнопкой',
        changedBy: 'user',
      });

      if (!applied) {
        // Менять оказалось нечего: запись уже в этом состоянии.
        await ctx.editMessageText(active.texts.resolver.attached);
        return;
      }

      await ctx.editMessageText(describeChange(applied, active.texts, active.timeZone), {
        reply_markup: undoKeyboard(applied.revisionId, active.texts),
      });

      logger.info(
        { userId: active.userId, itemId: question.itemId, revisionId: applied.revisionId },
        'Человек подтвердил правку кнопкой',
      );
    },
  );

  bot.callbackQuery(
    new RegExp(`^${QUESTION_ACTION.separate}[A-Za-z0-9_-]{22}$`, 'u'),
    async (ctx) => {
      await ctx.answerCallbackQuery();

      const active = await acting(ctx.from.id);
      if (!active) return;

      const questionId = fromShortId(ctx.callbackQuery.data.slice(QUESTION_ACTION.separate.length));
      const outcome =
        questionId === undefined
          ? ({ kind: 'stale' } as const)
          : await answerQuestion(db, { questionId, userId: active.userId, outcome: 'separate' });

      if (outcome.kind === 'stale') {
        await ctx.editMessageText(active.texts.resolver.questionStale);
        return;
      }

      await createFromSegment(deps, {
        userId: active.userId,
        batchId: outcome.question.batchId,
        segment: outcome.question.segment,
        timeZone: active.timeZone,
      });

      await ctx.editMessageText(active.texts.resolver.separated);
    },
  );
}

/**
 * Заводит запись из сказанного.
 *
 * Разбор идёт тем же классификатором, что и обычная выгрузка: правила
 * §6.2–§6.4 — желание не становится задачей, тема только из списка
 * человека, срок проверяется — должны действовать и здесь. Своя
 * упрощённая версия однажды разошлась бы с основной.
 *
 * Не разобралось — сегмент уходит в черновик, а не пропадает (§9.1).
 */
async function createFromSegment(
  deps: QuestionDeps,
  params: {
    readonly userId: string;
    readonly batchId: string;
    readonly segment: string;
    readonly timeZone: string;
  },
): Promise<void> {
  const topics = await topicsFor(deps.db, params.userId);

  const classified = await classifyUnits(deps.ai, {
    units: [{ text: params.segment, isProject: false, isEmotion: false }],
    topics: topics.names,
    defaultTopic: topics.defaultName,
    timeZone: params.timeZone,
    userId: params.userId,
  });

  if (!classified.ok || classified.items.length === 0) {
    await saveDraft(deps.db, {
      userId: params.userId,
      batchId: params.batchId,
      text: params.segment,
      reason: 'ответ «это новое», разобрать не удалось',
    });
    return;
  }

  await saveItems(deps.db, {
    userId: params.userId,
    batchId: params.batchId,
    items: classified.items,
  });
}
