import { GrammyError } from 'grammy';

import type { CreateThreadParams, TopicGateway } from './gateway.js';

/**
 * Поддельные ветки Telegram для тестов (задачи 2.15–2.17).
 *
 * Проба 0.3 уже подтвердила, что настоящий API в личном чате работает.
 * Проверять надо наш код: что ветка создаётся один раз, что сводка
 * правится, а не отправляется заново, и что пропавшая ветка не роняет
 * бота. Для всего этого живой Telegram не нужен, а нужен счётчик вызовов.
 */

export interface SentMessage {
  readonly chatId: number;
  readonly threadId: number | undefined;
  readonly text: string;
}

export interface FakeGatewayOptions {
  /** Иконки, которые «разрешает» Telegram: эмодзи → идентификатор. */
  readonly icons?: ReadonlyMap<string, string>;
  /** Режим тем выключен: любой вызов по веткам отвечает отказом. */
  readonly topicsOff?: boolean;
  /** Эти ветки считаются удалёнными человеком. */
  readonly goneThreads?: ReadonlySet<number>;
  /** Эти сообщения считаются удалёнными человеком. */
  readonly goneMessages?: ReadonlySet<number>;
  /** Правка тем же текстом отвечает «не изменено», как настоящий Telegram. */
  readonly rejectUnchangedEdits?: boolean;
  /** Первые столько отправок отвечают 429 с просьбой подождать. */
  readonly throttleFirst?: { readonly times: number; readonly retryAfterSec: number };
}

/** Отказ Telegram нужной формы: код, текст и параметры, как у настоящего. */
function telegramError(
  code: number,
  description: string,
  parameters: Record<string, unknown> = {},
): GrammyError {
  return new GrammyError(
    `Call to method failed: ${description}`,
    { ok: false, error_code: code, description, parameters },
    'sendMessage',
    {},
  );
}

/**
 * Счётчики общие на весь прогон, а не свои у каждой подделки.
 *
 * Иначе два экземпляра выдают одни и те же номера, и тест «сводка
 * отправлена заново» проходит вхолостую: новый номер совпадает со старым.
 * Настоящий Telegram номера не переиспользует, и подделка не должна.
 */
let nextThreadId = 1000;
let nextMessageId = 5000;

export class FakeTopicGateway implements TopicGateway {
  readonly created: { name: string; iconEmojiId: string | undefined }[] = [];
  readonly sent: SentMessage[] = [];
  readonly edited: { messageId: number; text: string }[] = [];
  readonly pinned: number[] = [];

  private readonly lastText = new Map<number, string>();

  constructor(private readonly options: FakeGatewayOptions = {}) {}

  /** Сколько раз вообще что-то отправлено или изменено. */
  get writes(): number {
    return this.sent.length + this.edited.length;
  }

  createThread(params: CreateThreadParams): Promise<number> {
    if (this.options.topicsOff === true) {
      return Promise.reject(telegramError(400, 'Bad Request: the chat is not a forum'));
    }

    this.created.push({ name: params.name, iconEmojiId: params.iconEmojiId });
    nextThreadId++;
    return Promise.resolve(nextThreadId);
  }

  allowedIcons(): Promise<ReadonlyMap<string, string>> {
    return Promise.resolve(this.options.icons ?? new Map());
  }

  private throttled = 0;

  send(params: { chatId: number; threadId?: number | undefined; text: string }): Promise<number> {
    if (params.threadId !== undefined && this.options.goneThreads?.has(params.threadId) === true) {
      return Promise.reject(telegramError(400, 'Bad Request: message thread not found'));
    }

    const { throttleFirst } = this.options;
    if (throttleFirst && this.throttled < throttleFirst.times) {
      this.throttled++;
      return Promise.reject(
        telegramError(
          429,
          'Too Many Requests: retry after ' + String(throttleFirst.retryAfterSec),
          {
            retry_after: throttleFirst.retryAfterSec,
          },
        ),
      );
    }

    this.sent.push({ chatId: params.chatId, threadId: params.threadId, text: params.text });
    nextMessageId++;
    this.lastText.set(nextMessageId, params.text);
    return Promise.resolve(nextMessageId);
  }

  edit(params: { chatId: number; messageId: number; text: string }): Promise<void> {
    if (this.options.goneMessages?.has(params.messageId) === true) {
      return Promise.reject(telegramError(400, 'Bad Request: message to edit not found'));
    }

    if (
      this.options.rejectUnchangedEdits === true &&
      this.lastText.get(params.messageId) === params.text
    ) {
      return Promise.reject(
        telegramError(400, 'Bad Request: message is not modified: specified new message content'),
      );
    }

    this.edited.push({ messageId: params.messageId, text: params.text });
    this.lastText.set(params.messageId, params.text);
    return Promise.resolve();
  }

  pin(params: { chatId: number; messageId: number }): Promise<void> {
    this.pinned.push(params.messageId);
    return Promise.resolve();
  }
}
