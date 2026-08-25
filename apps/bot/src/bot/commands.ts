import type { Api } from 'grammy';
import type { BotCommand } from 'grammy/types';

/**
 * Меню команд бота (задачи 1.10 и 1.20).
 *
 * §16 ТЗ требует, чтобы человек мог выгрузить и удалить свои данные.
 * Обработчики этих команд были написаны сразу, а вот в меню Telegram они
 * не попадали — то есть воспользоваться ими мог только тот, кто знает
 * точное название наизусть. Формально право есть, практически его нет.
 *
 * Список держится здесь единственным экземпляром: команда, появившаяся
 * в коде и не появившаяся тут, останется невидимой.
 */
export const BOT_COMMANDS: readonly BotCommand[] = [
  { command: 'start', description: 'с чего начать' },
  { command: 'export_my_data', description: 'выгрузить мои данные' },
  { command: 'delete_my_data', description: 'удалить все мои данные' },
];

/**
 * Публикует меню в Telegram. Вызывается при старте.
 *
 * Отказ не должен мешать боту работать: меню — удобство, а приём
 * сообщений — суть. Поэтому наверху вызов обёрнут в перехват.
 */
export async function publishCommands(api: Api): Promise<void> {
  await api.setMyCommands([...BOT_COMMANDS]);
}
