import type { Bot, Context } from 'grammy';
import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import { escapeMarkdown } from '../markdown.js';
import { fitKeyboard } from '../../modules/presenter/keyboard.js';
import {
  firstStep,
  onboardingStateOf,
  questionFor,
  setStep,
  type Question,
} from '../../modules/onboarding/onboarding.service.js';
import type { QuestionSender } from '../../modules/presenter/telegram-sender.js';
import { CONSENT_ACTION } from './incoming.js';
import { confirmConsent, consentConfirmedOf, findByTgId } from '../../modules/users/users.repo.js';
import { textsFor } from '../../texts/index.js';

/**
 * Экран первого запуска (задача 1.10).
 *
 * §13.1 ТЗ: одно короткое приветствие и две кнопки.
 *
 * **Кнопок больше нет, а приветствие несёт первый вопрос опроса** — правка
 * заказчика от 04.09.2026: «может сделаем опрос первым сообщением».
 * Раньше на `/start` уходило два сообщения подряд, и во втором был вопрос,
 * то есть два призыва к действию в одном обмене — ровно то, от чего ушёл
 * запрос на изменение №2, только на первом экране. Подсказка про голос и
 * текст, которую давали те две кнопки, теперь стоит в самом приветствии.
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
 *
 * Экран с двумя кнопками остался запасным путём: он показывается, когда
 * опрос уже пройден или идёт, — тогда вопрос повторять незачем.
 */
export interface StartDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly privacyPolicyUrl: string;
  /**
   * Редакция политики и согласия, на которую нажимают «Согласна» (§16;
   * решение заказчицы 12.09.2026). Пуста, пока документы не получили
   * дату: согласие тогда записывается без редакции, и об этом сказано
   * при старте.
   */
  readonly privacyPolicyEdition?: string | undefined;
  /**
   * Выпуск сообщений, присланных раньше нажатия: после кнопки они уходят
   * в буфер выгрузки, как только что присланные (`releaseHeldMessages`).
   * Без него слова до кнопки остались бы лежать — §16 такого не терпит.
   */
  readonly release?: ((userId: string, chatId: number | undefined) => Promise<number>) | undefined;
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
  async function firstQuestion(tgId: number): Promise<Question | undefined> {
    if (!sender) return undefined;

    const user = await findByTgId(db, tgId);
    if (!user) return undefined;

    const state = await onboardingStateOf(db, user.id);
    if (state.step !== 0) return undefined;

    const step = firstStep(state.name);

    /**
     * Имя экранируется здесь, а не в самом вопросе (ревизия этапов 1–2).
     *
     * Этот экран уходит с разметкой — она нужна ровно для ссылки на
     * политику, — и подставлял имя из Telegram как есть. Имя человек
     * задаёт себе сам, и `Ann_a`, `*K*`, `[Ю` в нём не редкость: Telegram
     * отвечал «can't parse entities», отправка падала, а повтор доставки
     * глушился дедупликацией апдейтов. Первый экран терялся навсегда — на
     * самое первое `/start` человек получал ноль байт.
     *
     * Ровно здесь, потому что тот же вопрос уходит и без разметки — из
     * разбора выгрузки, — и слеши там были бы видны человеку.
     */
    const question = questionFor(step, {
      texts: textsFor(),
      name: escapeMarkdown(state.name),
      opening: true,
    });
    if (!question) return undefined;

    await setStep(db, user.id, step);
    logger.info({ userId: user.id, step }, 'Опрос начат с первого запуска');

    return question;
  }

  // Профиль по умолчанию, а не выбранный человеком: этот экран
  // показывается до регистрации, и выбирать ещё некому (§13.1).
  /**
   * Через `textsFor()`, а не константой из кода: §13.9 требует менять
   * тексты без выкладки, и первый экран — то самое место, где человек
   * видит бота впервые. Застывшее значение означало бы «без выкладки,
   * кроме приветствия».
   */
  const texts = textsFor();

  const keyboard = fitKeyboard([
    [
      { label: texts.start.buttonVoice, action: 'start:voice' },
      { label: texts.start.buttonText, action: 'start:text' },
    ],
  ]);

  /** Первый экран до согласия: приветствие, политика, 18+ и одна кнопка. */
  const consentScreen = async (ctx: Context): Promise<void> => {
    await ctx.reply(texts.consent.screen(privacyPolicyUrl), {
      reply_markup: fitKeyboard([[{ label: texts.consent.button, action: CONSENT_ACTION.accept }]]),
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    });
  };

  bot.command('start', async (ctx) => {
    /**
     * Без нажатой «Согласна» — экран согласия, и ничего больше (§16;
     * решение заказчицы 12.09.2026, ответ 13).
     *
     * Это отступление от §13.1 её же ТЗ («никаких опросов до первой
     * выгрузки») по её слову: отдельное явное действие перед первой
     * выгрузкой. Опрос при этом остаётся за кнопкой — один призыв к
     * действию в одном обмене (§13.9), а не согласие и вопрос разом.
     */
    const user = ctx.from === undefined ? undefined : await findByTgId(db, ctx.from.id);
    if (user !== undefined && !(await consentConfirmedOf(db, user.id))) {
      await consentScreen(ctx);
      return;
    }

    /**
     * Приветствие и первый вопрос — **одним** сообщением (задача 3.61).
     *
     * Заказчик: «может сделаем опрос первым сообщением». Раньше приходило
     * два сообщения подряд, и во втором был вопрос — то есть два призыва
     * к действию в одном обмене. Кнопки «Наговорить» и «Написать» при
     * этом уходят: единственное, что они давали, — подсказку про голос и
     * текст, и она теперь в самом приветствии.
     *
     * Опрос не открылся (уже пройден, идёт, или отправителя нет) — экран
     * работает как прежде, со своими двумя кнопками.
     */
    const question = ctx.from === undefined ? undefined : await firstQuestion(ctx.from.id);

    if (question === undefined) {
      await ctx.reply(texts.start.screen(privacyPolicyUrl), {
        reply_markup: keyboard,
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
      });
      return;
    }

    await ctx.reply(texts.start.screenWithQuestion(privacyPolicyUrl, question.text), {
      reply_markup: fitKeyboard(question.rows.map((row) => [...row])),
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    });
  });

  bot.callbackQuery(CONSENT_ACTION.accept, async (ctx) => {
    const user = await findByTgId(db, ctx.from.id);
    if (user === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }

    const confirmed = await confirmConsent(db, user.id, { edition: deps.privacyPolicyEdition });
    await ctx.answerCallbackQuery();
    logger.info(
      { userId: user.id, edition: deps.privacyPolicyEdition ?? null, first: confirmed },
      'Нажата «Согласна»',
    );

    /**
     * После согласия — то, что раньше было первым экраном: первый вопрос
     * опроса, если он ещё не начинался; иначе короткое «можно говорить».
     * Приветствие второй раз не повторяется — оно уже над кнопкой.
     */
    const question = await firstQuestion(ctx.from.id);
    if (question === undefined) {
      await ctx.reply(texts.consent.accepted);
    } else {
      await ctx.reply(question.text, {
        reply_markup: fitKeyboard(question.rows.map((row) => [...row])),
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
      });
    }

    // Сказанное до кнопки — в выгрузку, как только что присланное (§16).
    if (deps.release !== undefined) {
      const released = await deps.release(user.id, ctx.chat?.id);
      if (released > 0) logger.info({ userId: user.id, released }, 'Выпущены ждавшие согласия');
    }
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
