import type { Bot } from 'grammy';
import type { Logger } from 'pino';

/**
 * Служебные сообщения Telegram о наших же действиях — прочь (заказчица,
 * 16.09.2026).
 *
 * Ветку создаёт бот — а в чате от этого остаётся «„семья" создана», по
 * строке на сферу. Её слова по видео: «технические уведомления вообще
 * убрать, чтобы женщина раз увидела — папочки созданы, всё супер».
 * Закрепов бот с того же дня не делает, так что строка «закрепил(а)»
 * может быть только её собственной — её не трогаем.
 *
 * В личном чате бот вправе удалить сообщение, и служебные — тоже. Отказ
 * Telegram здесь не ошибка: строка просто останется, как было.
 */
export function registerServiceMessageHandlers(bot: Bot, logger: Logger): void {
  bot.on('message:forum_topic_created', async (ctx) => {
    if (ctx.chat.type !== 'private') return;

    try {
      await ctx.deleteMessage();
    } catch (error) {
      logger.debug(
        { err: error, messageId: ctx.msg.message_id },
        'Служебное сообщение Telegram не удалилось — остаётся в чате',
      );
    }
  });
}
