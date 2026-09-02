import type { Bot } from 'grammy';
import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import { fitKeyboard } from '../../modules/presenter/keyboard.js';
import {
  firstStep,
  onboardingStateOf,
  questionFor,
  setStep,
} from '../../modules/onboarding/onboarding.service.js';
import type { QuestionSender } from '../../modules/presenter/telegram-sender.js';
import { findByTgId } from '../../modules/users/users.repo.js';
import { defaultTexts } from '../../texts/index.js';

/**
 * Экран первого запуска (задача 1.10).
 *
 * §13.1 ТЗ: одно короткое приветствие и две кнопки.
 *
 * **Опрос теперь идёт здесь же, а не после первой выгрузки** — запрос на
 * изменение №2 от 02.09.2026. ТЗ трижды требовало обратного («никаких
 * опросов до первой выгрузки», §12.2 и §13.1), но правку дал автор самого
 * ТЗ, посмотрев на живой первый запуск: разбор приходил и **сразу** за ним
 * вопрос про имя и время, то есть два призыва к действию в одном обмене.
 *
 * **Опрос ничего не загораживает.** Кнопки остаются подсказкой, а не
 * режимом: человек может не отвечать и просто заговорить — выгрузка
 * разберётся, а незаданные вопросы дождутся своей очереди. Ровно это и
 * требует §13.1.
 *
 * Прежний запуск после первой выгрузки остался запасным путём: он ловит
 * тех, кто заговорил, не нажимая `/start`.
 *
 * §16 ТЗ: согласие на обработку данных показывается одним экраном со
 * ссылкой. Отдельного шага «я согласна» нет намеренно — он противоречил
 * бы §13.1. Согласием считается первое сообщение после этого экрана,
 * и оно фиксируется в incoming.ts.
 *
 * Кнопки не ограничивают ввод: это подсказка, а не режим. Можно сразу
 * писать текстом или прислать голосовое, ничего не нажимая.
 */
export interface StartDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly privacyPolicyUrl: string;
  /**
   * Отправитель вопросов опроса.
   *
   * Не задан — экран первого запуска работает как прежде, без опроса.
   * Так удобно поднимать бота в тестах, где онбординг не проверяется.
   */
  readonly onboarding?: QuestionSender | undefined;
}

export function registerStartHandlers(bot: Bot, deps: StartDeps): void {
  const { db, logger, privacyPolicyUrl, onboarding: sender } = deps;

  /**
   * Начинает опрос, если он ещё не начинался.
   *
   * Молча ничего не делает, когда опрос уже идёт или пройден: `/start`
   * человек может нажать и на десятый день.
   */
  async function startOnboarding(tgId: number, chatId: number): Promise<void> {
    if (!sender) return;

    const user = await findByTgId(db, tgId);
    if (!user) return;

    const state = await onboardingStateOf(db, user.id);
    if (state.step !== 0) return;

    const step = firstStep(state.name);
    const question = questionFor(step, { texts: defaultTexts, name: state.name, opening: true });
    if (!question) return;

    await setStep(db, user.id, step);
    await sender.ask({ chatId, text: question.text, rows: question.rows });

    logger.info({ userId: user.id, step }, 'Опрос начат с первого запуска');
  }

  // Профиль по умолчанию, а не выбранный человеком: этот экран
  // показывается до регистрации, и выбирать ещё некому (§13.1).
  const texts = defaultTexts;

  const keyboard = fitKeyboard([
    [
      { label: texts.start.buttonVoice, action: 'start:voice' },
      { label: texts.start.buttonText, action: 'start:text' },
    ],
  ]);

  bot.command('start', async (ctx) => {
    await ctx.reply(texts.start.screen(privacyPolicyUrl), {
      reply_markup: keyboard,
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    });

    // Приветствие первым, вопрос вторым: человек должен успеть прочитать,
    // куда он попал, прежде чем его о чём-то спрашивают.
    if (ctx.from !== undefined) await startOnboarding(ctx.from.id, ctx.chat.id);
  });

  bot.callbackQuery('start:voice', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(texts.start.hintVoice);
  });

  bot.callbackQuery('start:text', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(texts.start.hintText);
  });
}
