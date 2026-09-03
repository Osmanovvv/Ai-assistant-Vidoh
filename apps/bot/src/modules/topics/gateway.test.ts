import { GrammyError } from 'grammy';
import { describe, expect, it } from 'vitest';

import { isThreadGone, isTopicsUnavailable } from './gateway.js';

/**
 * Отказы Telegram, которые продукт обязан отличать (задача 3.45).
 *
 * Проверено прямым вызовом 03.09.2026: свежая ветка в личном чате
 * удаляется с `ok`, повторное удаление той же — `TOPIC_ID_INVALID`. То
 * есть это «уже сделано», а не поломка. До этого такой ответ считался
 * ошибкой, а обработчик удаления данных писал её на уровне `debug` —
 * и в бою было не понять, удалял ли бот ветки вообще.
 */

function telegramError(code: number, description: string): GrammyError {
  return new GrammyError(
    `Call to method failed: ${description}`,
    { ok: false, error_code: code, description },
    'deleteForumTopic',
    {},
  );
}

describe('ветки уже нет', () => {
  it('TOPIC_ID_INVALID — ветка уже удалена', () => {
    expect(isThreadGone(telegramError(400, 'Bad Request: TOPIC_ID_INVALID'))).toBe(true);
  });

  it('прежние формулировки по-прежнему узнаются', () => {
    expect(isThreadGone(telegramError(400, 'Bad Request: message thread not found'))).toBe(true);
    expect(isThreadGone(telegramError(400, 'Bad Request: TOPIC_DELETED'))).toBe(true);
  });

  it('чужие отказы за пропажу ветки не выдаются', () => {
    expect(
      isThreadGone(telegramError(400, 'Bad Request: the chat is not a supergroup forum')),
    ).toBe(false);
    expect(isThreadGone(telegramError(429, 'Too Many Requests: retry after 5'))).toBe(false);
    expect(isThreadGone(new Error('сеть'))).toBe(false);
  });

  it('выключенный режим тем — отдельный случай, не пропажа', () => {
    // Три записи одного отказа: словами, как у заглушки сквозного и как
    // настоящий Telegram отвечает на методы форума в личном чате.
    for (const text of [
      'Bad Request: topics are not enabled',
      'Bad Request: TOPICS_ARE_NOT_ENABLED',
      'Bad Request: the chat is not a supergroup forum',
    ]) {
      const off = telegramError(400, text);
      expect(isThreadGone(off), text).toBe(false);
      expect(isTopicsUnavailable(off), text).toBe(true);
    }
  });
});
