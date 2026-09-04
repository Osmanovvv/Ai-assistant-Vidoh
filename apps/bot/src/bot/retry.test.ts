import { GrammyError, HttpError } from 'grammy';
import { describe, expect, it } from 'vitest';

import { isConnectFailure, retryOnConnectFailure } from './retry.js';

/**
 * Повтор при отказе соединения (задача 3.60).
 *
 * Боевое 04.09.2026, 19:28: `/menu` дошёл до бота, а ответ не дошёл до
 * Telegram — соединение не установилось. Человек увидел тишину.
 */

function fetchFailure(code: string): HttpError {
  const inner = Object.assign(new Error(`request to https://api.telegram.org/bot1:x failed`), {
    code,
  });
  return new HttpError('Network request for sendMessage failed!', inner);
}

const OK = { ok: true as const, result: { message_id: 1 } };

describe('isConnectFailure', () => {
  it('узнаёт отказ соединения', () => {
    for (const code of ['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
      expect(isConnectFailure(fetchFailure(code)), code).toBe(true);
    }
  });

  it('обрыв посреди ответа повторять нельзя: ответ мог уже уйти', () => {
    expect(isConnectFailure(fetchFailure('ECONNRESET'))).toBe(false);
  });

  it('ответ Telegram с ошибкой — не сетевой отказ', () => {
    const grammy = new GrammyError(
      'Bad Request',
      { ok: false, error_code: 400, description: 'x' },
      'sendMessage',
      {},
    );
    expect(isConnectFailure(grammy)).toBe(false);
    expect(isConnectFailure(new Error('что угодно'))).toBe(false);
  });
});

describe('retryOnConnectFailure', () => {
  it('повторяет один раз и отдаёт ответ', async () => {
    let calls = 0;
    const prev = () => {
      calls++;
      return calls === 1 ? Promise.reject(fetchFailure('ETIMEDOUT')) : Promise.resolve(OK);
    };
    const slept: number[] = [];
    const transformer = retryOnConnectFailure({
      delayMs: 7,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });

    const result = await transformer(prev as never, 'sendMessage', {} as never, undefined);

    expect(result).toEqual(OK);
    expect(calls).toBe(2);
    expect(slept).toEqual([7]);
  });

  it('второй отказ отдаётся наверх: сеть лежит, десятый запрос не поможет', async () => {
    let calls = 0;
    const prev = () => {
      calls++;
      return Promise.reject(fetchFailure('ETIMEDOUT'));
    };
    const transformer = retryOnConnectFailure({ sleep: () => Promise.resolve() });

    await expect(
      transformer(prev as never, 'sendMessage', {} as never, undefined),
    ).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(2);
  });

  it('обрыв посреди ответа не повторяется', async () => {
    let calls = 0;
    const prev = () => {
      calls++;
      return Promise.reject(fetchFailure('ECONNRESET'));
    };
    const transformer = retryOnConnectFailure({ sleep: () => Promise.resolve() });

    await expect(
      transformer(prev as never, 'sendMessage', {} as never, undefined),
    ).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
  });

  it('отменённый запрос не повторяется', async () => {
    let calls = 0;
    const prev = () => {
      calls++;
      return Promise.reject(fetchFailure('ETIMEDOUT'));
    };
    const controller = new AbortController();
    controller.abort();
    const transformer = retryOnConnectFailure({ sleep: () => Promise.resolve() });

    await expect(
      // У grammY свой тип сигнала (полифилл abort-controller); поведение то же.
      transformer(prev as never, 'sendMessage', {} as never, controller.signal as never),
    ).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
  });
});
