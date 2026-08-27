import { GrammyError } from 'grammy';
import { describe, expect, it } from 'vitest';

import { isBlockedError, isBlockingStatus, isRetryableSendError } from './blocked.js';

/** GrammyError требует исходный запрос и ответ Telegram. */
function telegramError(code: number, description: string): GrammyError {
  return new GrammyError(
    'Call to sendMessage failed',
    { ok: false, error_code: code, description },
    'sendMessage',
    {},
  );
}

describe('isBlockingStatus', () => {
  it('kicked означает блокировку', () => {
    expect(isBlockingStatus('kicked')).toBe(true);
  });

  it('left означает, что писать больше нельзя', () => {
    expect(isBlockingStatus('left')).toBe(true);
  });

  it('member означает обычного пользователя', () => {
    expect(isBlockingStatus('member')).toBe(false);
  });

  it('administrator не блокировка', () => {
    expect(isBlockingStatus('administrator')).toBe(false);
  });
});

describe('isBlockedError', () => {
  it('403 с сообщением о блокировке', () => {
    expect(isBlockedError(telegramError(403, 'Forbidden: bot was blocked by the user'))).toBe(true);
  });

  it('403 с удалённым аккаунтом', () => {
    expect(isBlockedError(telegramError(403, 'Forbidden: user is deactivated'))).toBe(true);
  });

  it('403 с ненайденным чатом', () => {
    expect(isBlockedError(telegramError(403, 'Forbidden: chat not found'))).toBe(true);
  });

  it('регистр не важен', () => {
    expect(isBlockedError(telegramError(403, 'Forbidden: Bot Was Blocked By The User'))).toBe(true);
  });

  it('429 не блокировка', () => {
    expect(isBlockedError(telegramError(429, 'Too Many Requests: retry after 30'))).toBe(false);
  });

  it('400 сам по себе не блокировка: это обычно наша ошибка в запросе', () => {
    expect(isBlockedError(telegramError(400, 'Bad Request: message is too long'))).toBe(false);
  });

  it('«чат не найден» с кодом 400 — недоступный получатель', () => {
    // Telegram отдаёт этот отказ именно с 400, а проверка требовала 403,
    // и ветка не срабатывала никогда: человек, удаливший чат, давал
    // ошибку уровня «сбой» вместо пометки «недоступен». Найдено на
    // выкладке этапа 2 — мониторинг показал сто процентов ошибок, и все
    // они были такими.
    expect(isBlockedError(telegramError(400, 'Bad Request: chat not found'))).toBe(true);
  });

  it('недоступный получатель не повторяется', () => {
    // Повтор отправки в удалённый чат — это бесконечный ретрай и, если
    // отказ уронил задание, повторная оплата разбора той же выгрузки.
    expect(isRetryableSendError(telegramError(400, 'Bad Request: chat not found'))).toBe(false);
  });

  it('403 по другой причине не считается блокировкой', () => {
    expect(isBlockedError(telegramError(403, 'Forbidden: not enough rights'))).toBe(false);
  });

  it('обычная ошибка не блокировка', () => {
    expect(isBlockedError(new Error('сеть недоступна'))).toBe(false);
  });

  it('не падает на не-Error', () => {
    expect(isBlockedError('строка')).toBe(false);
    expect(isBlockedError(undefined)).toBe(false);
  });
});

describe('isRetryableSendError', () => {
  it('блокировку повторять бессмысленно', () => {
    // Иначе планировщик будет ретраить 403 до конца времён.
    expect(isRetryableSendError(telegramError(403, 'Forbidden: bot was blocked by the user'))).toBe(
      false,
    );
  });

  it('ограничение частоты повторять нужно', () => {
    expect(isRetryableSendError(telegramError(429, 'Too Many Requests: retry after 30'))).toBe(
      true,
    );
  });

  it('ошибку запроса повторять бессмысленно', () => {
    expect(isRetryableSendError(telegramError(400, 'Bad Request: message is too long'))).toBe(
      false,
    );
  });

  it('сетевую ошибку повторять нужно', () => {
    expect(isRetryableSendError(new Error('ECONNRESET'))).toBe(true);
  });

  it('ошибку сервера Telegram повторять нужно', () => {
    expect(isRetryableSendError(telegramError(500, 'Internal Server Error'))).toBe(true);
  });
});
