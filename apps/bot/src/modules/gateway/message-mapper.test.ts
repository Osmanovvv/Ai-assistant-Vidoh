import type { Message, Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';

import {
  describeMessage,
  describeUser,
  extractMessage,
  extractReferralSource,
} from './message-mapper.js';

const chat = { id: 1108419534, type: 'private' } as const;
const from = { id: 1108419534, is_bot: false, first_name: 'Аня' } as const;

function message(overrides: Partial<Message> = {}): Message {
  return { message_id: 10, date: 1_700_000_000, chat, from, ...overrides } as Message;
}

describe('describeMessage', () => {
  it('текстовое сообщение', () => {
    const result = describeMessage(message({ text: 'купить продукты' }));

    expect(result.kind).toBe('text');
    expect(result.text).toBe('купить продукты');
    expect(result.fileId).toBeNull();
    expect(result.audioDurationSec).toBeNull();
  });

  it('голосовое сообщение: сохраняет file_id и длительность', () => {
    const result = describeMessage(
      message({
        voice: { file_id: 'AwAC-file', file_unique_id: 'u1', duration: 47, mime_type: 'audio/ogg' },
      }),
    );

    expect(result.kind).toBe('voice');
    expect(result.fileId).toBe('AwAC-file');
    expect(result.audioDurationSec).toBe(47);
    expect(result.text).toBeNull();
  });

  it('аудиофайл отличается от голосового', () => {
    const result = describeMessage(
      message({ audio: { file_id: 'audio-file', file_unique_id: 'u2', duration: 120 } }),
    );

    expect(result.kind).toBe('audio');
    expect(result.fileId).toBe('audio-file');
  });

  it('подпись к вложению не теряется', () => {
    const result = describeMessage(
      message({
        caption: 'вот список',
        document: { file_id: 'doc', file_unique_id: 'u3' },
      }),
    );

    expect(result.kind).toBe('text');
    expect(result.text).toBe('вот список');
  });

  it('сообщение без текста и вложений помечается как other', () => {
    const result = describeMessage(message());

    expect(result.kind).toBe('other');
    expect(result.text).toBeNull();
  });

  describe('ветка темы', () => {
    it('сообщение в ветке сохраняет идентификатор темы', () => {
      const result = describeMessage(
        message({ text: 'к врачу', is_topic_message: true, message_thread_id: 330568 }),
      );

      expect(result.tgThreadId).toBe(330568);
    });

    it('сообщение вне ветки не получает тему, даже если thread_id пришёл', () => {
      // Telegram присылает message_thread_id и для ответов в обычном чате.
      // Без проверки is_topic_message мы бы приписали сообщение к теме.
      const result = describeMessage(message({ text: 'привет', message_thread_id: 42 }));

      expect(result.tgThreadId).toBeNull();
    });

    it('обычное сообщение не имеет темы', () => {
      expect(describeMessage(message({ text: 'привет' })).tgThreadId).toBeNull();
    });
  });

  it('переносит идентификаторы чата и сообщения', () => {
    const result = describeMessage(message({ message_id: 777, text: 'x' }));

    expect(result.tgChatId).toBe(1108419534);
    expect(result.tgMessageId).toBe(777);
  });
});

describe('describeUser', () => {
  it('переносит поля профиля', () => {
    const result = describeUser({
      id: 42,
      is_bot: false,
      first_name: 'Аня',
      username: 'anya',
      language_code: 'ru',
    });

    expect(result).toEqual({ tgId: 42, firstName: 'Аня', username: 'anya', languageCode: 'ru' });
  });

  it('необязательные поля становятся null, а не undefined', () => {
    const result = describeUser({ id: 42, is_bot: false, first_name: 'Аня' });

    expect(result.username).toBeNull();
    expect(result.languageCode).toBeNull();
  });
});

describe('extractMessage', () => {
  it('достаёт обычное сообщение', () => {
    const update = { update_id: 1, message: message({ text: 'x' }) } as Update;
    expect(extractMessage(update)?.message_id).toBe(10);
  });

  it('достаёт отредактированное сообщение', () => {
    const update = { update_id: 1, edited_message: message({ text: 'x' }) } as Update;
    expect(extractMessage(update)?.message_id).toBe(10);
  });

  it('возвращает undefined для апдейта без сообщения', () => {
    const update = { update_id: 1, callback_query: { id: 'cb' } } as unknown as Update;
    expect(extractMessage(update)).toBeUndefined();
  });
});

describe('extractReferralSource', () => {
  it('достаёт параметр из /start', () => {
    expect(extractReferralSource(message({ text: '/start blogger42' }))).toBe('blogger42');
  });

  it('работает с упоминанием бота в команде', () => {
    expect(extractReferralSource(message({ text: '/start@aividoh_bot promo_x' }))).toBe('promo_x');
  });

  it('возвращает null для /start без параметра', () => {
    expect(extractReferralSource(message({ text: '/start' }))).toBeNull();
  });

  it('возвращает null для обычного текста', () => {
    expect(extractReferralSource(message({ text: 'купить продукты' }))).toBeNull();
  });

  it('отвергает параметр с недопустимыми символами', () => {
    expect(extractReferralSource(message({ text: '/start <script>' }))).toBeNull();
    expect(extractReferralSource(message({ text: '/start источник' }))).toBeNull();
  });

  it('отвергает слишком длинный параметр', () => {
    expect(extractReferralSource(message({ text: `/start ${'a'.repeat(65)}` }))).toBeNull();
  });

  it('возвращает null для сообщения без текста', () => {
    expect(extractReferralSource(message())).toBeNull();
  });
});
