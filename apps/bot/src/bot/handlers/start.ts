import type { Bot } from 'grammy';

import { defaultTexts } from '../../texts/index.js';
import { fitKeyboard } from '../../modules/presenter/keyboard.js';

/**
 * Экран первого запуска (задача 1.10).
 *
 * §13.1 ТЗ: одно короткое приветствие и две кнопки. Никакой регистрации,
 * опроса и настройки до первой выгрузки — онбординг придёт на задаче 2.13,
 * то есть после того, как человек уже что-то наговорил.
 *
 * §16 ТЗ: согласие на обработку данных показывается одним экраном со
 * ссылкой. Отдельного шага «я согласна» нет намеренно — он противоречил
 * бы §13.1. Согласием считается первое сообщение после этого экрана,
 * и оно фиксируется в incoming.ts.
 *
 * Кнопки не ограничивают ввод: это подсказка, а не режим. Можно сразу
 * писать текстом или прислать голосовое, ничего не нажимая.
 */
export function registerStartHandlers(bot: Bot, privacyPolicyUrl: string): void {
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
