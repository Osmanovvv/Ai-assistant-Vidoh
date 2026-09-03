import { GrammyError, type Api } from 'grammy';

/**
 * Ветки Telegram за интерфейсом (задача 2.15).
 *
 * Отдельным интерфейсом по той же причине, что провайдер расшифровки и
 * отправитель статуса: тесты не должны ходить в Telegram. Проба 0.3
 * подтвердила, что все нужные методы в личном чате работают, — здесь
 * остаётся только наш код, и проверять надо его.
 */

export interface CreateThreadParams {
  readonly chatId: number;
  readonly name: string;
  /** `icon_custom_emoji_id` из набора, который отдаёт Telegram. */
  readonly iconEmojiId?: string | undefined;
}

export interface TopicGateway {
  createThread(params: CreateThreadParams): Promise<number>;

  /**
   * Допустимые иконки: эмодзи → идентификатор.
   *
   * Произвольный эмодзи Telegram не принимает — проба 0.3 показала набор
   * из 112 штук. Поэтому в коде живёт соответствие «сфера жизни → эмодзи»,
   * а идентификатор ищется по нему здесь: набор Telegram может смениться,
   * а символ останется символом.
   */
  allowedIcons(): Promise<ReadonlyMap<string, string>>;

  send(params: {
    readonly chatId: number;
    readonly threadId?: number | undefined;
    readonly text: string;
  }): Promise<number>;

  edit(params: {
    readonly chatId: number;
    readonly messageId: number;
    readonly text: string;
  }): Promise<void>;

  pin(params: { readonly chatId: number; readonly messageId: number }): Promise<void>;

  /**
   * Удалить ветку вместе со всем, что в ней (§16 ТЗ).
   *
   * Нужен ровно одному случаю — удалению данных по просьбе человека.
   * Раньше удаление чистило базу и не трогало чат: ветки тем оставались
   * на месте, а в каждой висела закреплённая сводка со списком дел.
   * Человек нажимал «удалить мои данные» и продолжал видеть свои дела.
   *
   * Найдено ручной проверкой 29.08.2026.
   */
  deleteThread(params: { readonly chatId: number; readonly threadId: number }): Promise<void>;
}

/**
 * Telegram попросил подождать.
 *
 * Отдельно от прочих отказов: это не поломка, а просьба сбавить темп, и
 * единственно верный ответ на неё — подождать столько, сколько сказано.
 * Сколько именно, Telegram сообщает в `retry_after`.
 */
export function retryAfterSeconds(error: unknown): number | undefined {
  if (!(error instanceof GrammyError)) return undefined;
  if (error.error_code !== 429) return undefined;

  const seconds = error.parameters.retry_after;
  return typeof seconds === 'number' ? seconds : 1;
}

/**
 * Ветка пропала: человек удалил её руками.
 *
 * §17 ТЗ называет этот сценарий, и он вполне житейский — свернуть чат,
 * почистить лишнее. Отличать его от прочих отказов обязательно: на этот
 * надо пересоздать ветку, на остальные — просто отступить.
 */
const THREAD_GONE_DESCRIPTIONS = [
  'message thread not found',
  'topic_deleted',
  'topic deleted',
  'topic_closed',
  'thread not found',
  /**
   * Так Telegram отвечает на удаление ветки, которой уже нет (проверено
   * прямым вызовом 03.09.2026): свежая ветка удаляется с `ok`, а повторное
   * удаление той же — `TOPIC_ID_INVALID`. Это «уже сделано», а не отказ.
   */
  'topic_id_invalid',
];

export function isThreadGone(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  if (error.error_code !== 400) return false;

  const description = error.description.toLowerCase();
  return THREAD_GONE_DESCRIPTIONS.some((known) => description.includes(known));
}

/**
 * Режим тем выключен у бота целиком.
 *
 * §8.2 ТЗ требует плоского режима как запасного. Признак приходит из
 * `getMe()`, но настройку в @BotFather можно снять на работающем боте —
 * тогда правду скажет только отказ от API.
 */
const TOPICS_OFF_DESCRIPTIONS = [
  'topics are not enabled',
  'the chat is not a forum',
  'not enough rights to manage topics',
  'method is available only for forum',
  /**
   * Те же отказы в другой записи (03.09.2026): так отвечает заглушка
   * сквозного (`TOPICS_ARE_NOT_ENABLED`) и так — настоящий Telegram на
   * методы форума в личном чате («the chat is not a supergroup forum»).
   * Без них выключенный режим тем читался бы как поломка.
   */
  'topics_are_not_enabled',
  'not a supergroup forum',
];

export function isTopicsUnavailable(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  if (error.error_code !== 400 && error.error_code !== 403) return false;

  const description = error.description.toLowerCase();
  return TOPICS_OFF_DESCRIPTIONS.some((known) => description.includes(known));
}

export function createTopicGateway(api: Api): TopicGateway {
  /** Набор иконок запрашивается один раз на процесс: он не меняется. */
  let icons: ReadonlyMap<string, string> | undefined;

  return {
    async createThread({ chatId, name, iconEmojiId }) {
      const created = await api.createForumTopic(chatId, name, {
        ...(iconEmojiId === undefined ? {} : { icon_custom_emoji_id: iconEmojiId }),
      });
      return created.message_thread_id;
    },

    async allowedIcons() {
      if (icons) return icons;

      const stickers = await api.getForumTopicIconStickers();
      const map = new Map<string, string>();

      for (const sticker of stickers) {
        // У иконки есть и эмодзи, и идентификатор; нужны оба, иначе
        // сопоставить не по чему.
        if (sticker.emoji !== undefined && sticker.custom_emoji_id !== undefined) {
          map.set(sticker.emoji, sticker.custom_emoji_id);
        }
      }

      icons = map;
      return map;
    },

    async send({ chatId, threadId, text }) {
      const message = await api.sendMessage(chatId, text, {
        ...(threadId === undefined ? {} : { message_thread_id: threadId }),
      });
      return message.message_id;
    },

    async edit({ chatId, messageId, text }) {
      await api.editMessageText(chatId, messageId, text);
    },

    async deleteThread({ chatId, threadId }) {
      await api.deleteForumTopic(chatId, threadId);
    },

    async pin({ chatId, messageId }) {
      // Без оповещения: закреплённая сводка обновляется часто, и звать
      // человека к каждому обновлению — раздражать его.
      await api.pinChatMessage(chatId, messageId, { disable_notification: true });
    },
  };
}
