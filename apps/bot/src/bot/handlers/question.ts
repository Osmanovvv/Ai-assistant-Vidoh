import type { InlineKeyboard, Bot } from 'grammy';
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
import { fromShortId } from '../../modules/shared/short-id.js';
import {
  describeChange,
  QUESTION_ACTION,
  questionButtons,
} from '../../modules/resolver/change-text.js';
import { fitKeyboard } from '../../modules/presenter/keyboard.js';
import { undoKeyboard } from './undo.js';
import { titleWithoutDate } from '../../modules/resolver/title-date.js';

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
  return {
    text: texts.resolver.question(titleWithoutDate(itemTitle)),
    /**
     * Кнопки берутся из `questionButtons`, а не собираются здесь заново.
     *
     * Две копии одной клавиатуры уже расходились: «Добавить к прошлой»
     * (восемнадцать знаков) стояло тут в одной строке с «Это новое» и
     * обрезалось на телефоне, хотя в конвейере та же пара шла через общую
     * раскладку.
     */
    keyboard: fitKeyboard([questionButtons(questionId, texts)]),
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
        /**
         * Режим правки из вопроса — §7.4 (задача 3.82).
         *
         * Без него ответ на вопрос про дополнение применялся заменой:
         * подробность выбрасывалась, менять оказывалось нечего, и
         * человек получал «Добавила к прошлой» при пустой записи.
         *
         * Пусто означает «замена» — так вело себя применение раньше, и
         * вопросы, заданные до этой правки, доживают как жили.
         */
        ...(question.mode === 'append' ? { mode: 'append' as const } : {}),
        changes: question.changes as ResolverAnswer['changes'],
        /**
         * Слова человека — и на кнопочном пути тоже (задача 3.82).
         *
         * **Это и была красная 36-я проверка сквозного.** Без них не
         * работал пересчёт дня недели (3.65): человек сказал «перенеси
         * на пятницу», модель вернула **прошедшую** пятницу, проверка
         * §2.7 такой срок отбрасывает — и правка не применялась ни к
         * одной записи. Бот при этом отвечал «Добавила к прошлой».
         *
         * Голосом тот же ответ работал: `pending.ts` слова передаёт.
         * Кнопкой — нет, и разошлись эти два пути молча.
         *
         * Тем же путём терялось правило повторения из 3.8б: «запомни»
         * видно только в сказанном, и без него правило ложилось в базу
         * как названное мимоходом, а не как просьба запомнить.
         */
        spoken: question.segment,
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

      const made = await createFromSegment(deps, {
        userId: active.userId,
        batchId: outcome.question.batchId,
        segment: outcome.question.segment,
        timeZone: active.timeZone,
      });

      /**
       * Реплика говорит то, что вышло на самом деле (задача 3.79).
       *
       * **Найдено встречной проверкой 06.09.2026.** Разбор здесь может
       * не просто «не получиться», а **броситься**: модель недоступна,
       * потолок расхода перейдён, сеть моргнула. Тогда исключение уходило
       * в общий перехватчик бота, и человек не получал ничего: сообщение
       * не менялось, записи не появлялось, черновика тоже. А вопрос к
       * этому моменту уже помечен отвеченным — второе нажатие даёт
       * «вопрос устарел». Нажал кнопку, увидел молчание, мысль выпала из
       * работы бота.
       *
       * Теперь сорвавшийся разбор кладёт отрезок в черновик (§9.1 —
       * никогда в никуда) и честно говорит, что не получилось.
       */
      await ctx.editMessageText(
        made ? active.texts.resolver.separated : active.texts.errors.generic,
      );
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
 * Это верно и когда разбор **сорвался**: модель недоступна, потолок
 * расхода перейдён, сеть моргнула. Возвращает `false`, если записи не
 * вышло: реплика человеку зависит от того, что получилось.
 */
async function createFromSegment(
  deps: QuestionDeps,
  params: {
    readonly userId: string;
    readonly batchId: string;
    readonly segment: string;
    readonly timeZone: string;
  },
): Promise<boolean> {
  const topics = await topicsFor(deps.db, params.userId);

  /** Отрезок в черновик — общий путь для «не разобралось» и «сорвалось». */
  const keep = async (reason: string): Promise<false> => {
    await saveDraft(deps.db, {
      userId: params.userId,
      batchId: params.batchId,
      text: params.segment,
      reason,
    });

    return false;
  };

  let classified;

  try {
    classified = await classifyUnits(deps.ai, {
      units: [{ text: params.segment, isProject: false, isEmotion: false }],
      topics: topics.names,
      defaultTopic: topics.defaultName,
      timeZone: params.timeZone,
      userId: params.userId,
    });
  } catch (error) {
    /**
     * Срыв разбора не должен стоить человеку отрезка.
     *
     * Вопрос уже помечен отвеченным, второй раз нажать нельзя — значит
     * это единственный шанс сохранить сказанное. Ошибка идёт в журнал:
     * молча проглоченный срыв прячет и недоступность модели, и наш
     * потолок расхода.
     */
    deps.logger.error(
      { err: error, userId: params.userId },
      'Разбор отрезка сорвался — отрезок сохранён черновиком',
    );

    return await keep('ответ «это новое», разбор сорвался');
  }

  if (!classified.ok || classified.items.length === 0) {
    return await keep('ответ «это новое», разобрать не удалось');
  }

  await saveItems(deps.db, {
    userId: params.userId,
    batchId: params.batchId,
    items: classified.items,
  });

  return true;
}
