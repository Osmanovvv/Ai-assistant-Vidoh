import type { Message, Update } from 'grammy/types';

import type { MessageKind } from '../../db/schema.js';

/**
 * Разбор входящего сообщения в плоское описание (задачи 1.8 и 1.9).
 *
 * Чистая функция без обращений к базе и сети: именно здесь легче всего
 * ошибиться с типами сообщений, поэтому она тестируется отдельно.
 */

export interface IncomingMessage {
  readonly tgChatId: number;
  readonly tgMessageId: number;
  readonly tgThreadId: number | null;
  readonly kind: MessageKind;
  readonly text: string | null;
  readonly fileId: string | null;
  readonly audioDurationSec: number | null;
}

export interface IncomingUser {
  readonly tgId: number;
  readonly username: string | null;
  readonly firstName: string | null;
  readonly languageCode: string | null;
}

export function describeMessage(message: Message): IncomingMessage {
  const base = {
    tgChatId: message.chat.id,
    tgMessageId: message.message_id,
    // is_topic_message отличает сообщение в ветке от сообщения в общем чате:
    // без этой проверки message_thread_id иногда приходит и вне тем.
    tgThreadId: message.is_topic_message === true ? (message.message_thread_id ?? null) : null,
  };

  if (message.voice) {
    return {
      ...base,
      kind: 'voice',
      text: null,
      fileId: message.voice.file_id,
      audioDurationSec: message.voice.duration,
    };
  }

  if (message.audio) {
    return {
      ...base,
      kind: 'audio',
      text: null,
      fileId: message.audio.file_id,
      audioDurationSec: message.audio.duration,
    };
  }

  // Подпись к вложению — тоже текст пользователя, терять её нельзя.
  const text = message.text ?? message.caption ?? null;

  return {
    ...base,
    kind: text === null ? 'other' : 'text',
    text,
    fileId: null,
    audioDurationSec: null,
  };
}

export function describeUser(from: NonNullable<Message['from']>): IncomingUser {
  return {
    tgId: from.id,
    username: from.username ?? null,
    firstName: from.first_name,
    languageCode: from.language_code ?? null,
  };
}

/**
 * Сообщение из апдейта, если оно там есть. Апдейтом может быть нажатие
 * кнопки или смена статуса чата — тогда сохранять нечего.
 */
export function extractMessage(update: Update): Message | undefined {
  return update.message ?? update.edited_message;
}

/**
 * Реферальный параметр из команды /start. §14 ТЗ: сохраняется в профиле
 * при первом запуске и виден в админ-панели в разрезе источников.
 */
export function extractReferralSource(message: Message): string | null {
  const text = message.text;
  if (text === undefined) return null;

  const match = /^\/start(?:@\w+)?\s+(\S+)$/u.exec(text);
  const payload = match?.[1];
  if (payload === undefined) return null;

  // Telegram допускает в payload до 64 символов A-Z a-z 0-9 _ -
  return /^[A-Za-z0-9_-]{1,64}$/u.test(payload) ? payload : null;
}
