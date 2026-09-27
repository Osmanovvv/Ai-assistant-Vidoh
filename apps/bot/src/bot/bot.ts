import { Api, Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Logger } from 'pino';

import { rememberBotReplies } from '../modules/dialog/capture.js';
import type { DialogStore } from '../modules/dialog/dialog.store.js';
import { quietCallbackAnswer } from './callback-answer.js';
import { retryOnConnectFailure } from './retry.js';
import { tolerateSameContent } from './same-content.js';

export interface BotOptions {
  /**
   * Известный botInfo: тогда bot.init() не ходит в сеть. Нужен и тестам,
   * и быстрому старту вебхука, и вторым репликам, которым незачем
   * повторно спрашивать getMe.
   */
  readonly botInfo?: UserFromGetMe | undefined;
  /**
   * Адрес Bot API вместо настоящего (задача 2.23).
   *
   * Нужен сквозному тесту: ответы бота проверяются целиком, а прочитать
   * их у Telegram нельзя — бот не видит собственных сообщений, а войти
   * пользователем значит вводить код из SMS. Подменяется здесь именно
   * граница с Telegram, а не наш код, поэтому тест остаётся сквозным.
   *
   * В бою переменная обязана быть пустой — это проверяет конфигурация:
   * подменённый адрес в бою означал бы бота, который «отвечает» в
   * пустоту, и заметили бы это не мы, а живые люди.
   */
  readonly apiRoot?: string | undefined;
  /**
   * Хвост разговора (решение Никиты 24.09.2026, план docs/26): каждая
   * реплика бота в личный чат запоминается здесь, в одной точке на все
   * ответы. Нет хранилища — перехвата нет.
   */
  readonly dialog?: DialogStore | undefined;
  readonly logger?: Logger | undefined;
}

/** Защиты, общие для любого канала к Telegram. */
function installTransport(api: Api, logger?: Logger): void {
  // Отказ соединения с Telegram повторяется один раз (задача 3.60):
  // иначе ответ пропадает молча, а человек видит свою команду и тишину.
  api.config.use(retryOnConnectFailure());

  // Правка тем же содержимым — не ошибка (задача 3.73): кнопка с номером
  // страницы ведёт на ту же страницу, и Telegram отвергает такую правку.
  api.config.use(tolerateSameContent());

  // Сбой ответа на нажатие не роняет обработчик (27.09.2026): «Согласна»
  // осталась без первого вопроса из-за обрыва на этом вызове. Снаружи
  // повтора — чтобы отказ соединения сперва повторился.
  api.config.use(quietCallbackAnswer({ logger }));
}

/** Экземпляр бота (задача 1.7). */
export function createBot(token: string, options: BotOptions = {}): Bot {
  const bot = new Bot(token, {
    ...(options.botInfo === undefined ? {} : { botInfo: options.botInfo }),
    ...(options.apiRoot === undefined ? {} : { client: { apiRoot: options.apiRoot } }),
  });

  installTransport(bot.api, options.logger);

  // Реплика бота — в хвост разговора; сбой хранилища отправку не трогает.
  if (options.dialog !== undefined) {
    bot.api.config.use(rememberBotReplies(options.dialog, { logger: options.logger }));
  }

  return bot;
}

/**
 * Тихий канал к Telegram — для служебного, что разговором не является.
 *
 * Первая проверка разговора на бою выключенным (24.09.2026): после
 * выгрузки последними «репликами бота» в хвосте стояли правки закреплённых
 * сводок веток — списки дел по сферам. Модель видела бы список как ответ
 * человеку, а страж разговора, который смотрит на последнюю реплику бота,
 * молчал бы. Сводки веток, оповещения мониторинга (он пишет в личный
 * чат) и рассылки идут здесь: защиты те же, перехвата нет.
 */
export function createQuietApi(
  token: string,
  options: { readonly apiRoot?: string | undefined } = {},
): Api {
  const api = new Api(
    token,
    options.apiRoot === undefined ? undefined : { apiRoot: options.apiRoot },
  );
  installTransport(api);
  return api;
}

/**
 * Типы апдейтов, которые нам нужны. Список ограничен намеренно: Telegram
 * не будет слать лишнее, а мы не будем платить за его разбор.
 *
 * **И этот список — не пожелание, а фильтр.** Он уходит в `setWebhook`
 * при каждом старте, и апдейта, которого здесь нет, бот не получит
 * вовсе. Забытая строка означает не «чуть меньше данных», а молча
 * неработающую функцию: обработчик написан, покрыт проверками и никогда
 * не вызывается.
 *
 * Так и вышло с оплатой звёздами (найдено ревизией четвёртого этапа):
 * без `pre_checkout_query` Telegram не спрашивает подтверждения, а без
 * подтверждения **платёж не состоится вовсе**. Весь звёздный рельс был
 * недоставляем, и заметить это можно было бы только по нулевой выручке
 * — жалобы бы не пришло, потому что оплата не начиналась.
 *
 * За связку «есть обработчик — есть строка здесь» следит `bot.test.ts`.
 */
export const ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'callback_query',
  'my_chat_member',
  /**
   * Оплата звёздами (§14, задача 4.2).
   *
   * `pre_checkout_query` — подтверждение платежа, и ответить на него
   * надо за десять секунд. Без него платежа не будет.
   *
   * `subscription` — единственный способ узнать, что человек отписался
   * или что продление не прошло. Без него мы показывали бы «подписка
   * продлевается сама» тому, кто её отменил.
   *
   * Сам успешный платёж и возврат приходят служебными сообщениями, то
   * есть внутри `message`, — отдельной строки им не нужно.
   */
  'pre_checkout_query',
  'subscription',
] as const;
