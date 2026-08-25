import { describe, expect, it, vi } from 'vitest';

import { PermanentError, TransientError } from './failures.js';
import { backoffDelayMs, withRetry, withTimeout } from './retry.js';

/** Мгновенное ожидание: тесты не должны спать по-настоящему. */
const noSleep = () => Promise.resolve();

describe('backoffDelayMs', () => {
  it('растёт вдвое с каждой попыткой', () => {
    expect(backoffDelayMs(1, 1_000)).toBe(1_000);
    expect(backoffDelayMs(2, 1_000)).toBe(2_000);
    expect(backoffDelayMs(3, 1_000)).toBe(4_000);
  });

  it('не превышает потолок', () => {
    expect(backoffDelayMs(10, 1_000, 15_000)).toBe(15_000);
  });
});

describe('withRetry', () => {
  it('возвращает результат с первой попытки', async () => {
    const fn = vi.fn(() => Promise.resolve('готово'));

    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe('готово');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('повторяет временную ошибку и добивается результата', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls < 3) return Promise.reject(new TransientError('провайдер занят'));
      return Promise.resolve('получилось');
    };

    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe('получилось');
    expect(calls).toBe(3);
  });

  it('сдаётся после исчерпания попыток и пробрасывает последнюю ошибку', async () => {
    const fn = () => Promise.reject(new TransientError('провайдер недоступен'));

    await expect(withRetry(fn, { attempts: 3, sleep: noSleep })).rejects.toThrow(
      'провайдер недоступен',
    );
  });

  it('не повторяет постоянную ошибку', async () => {
    // Битый файл не станет целым от третьей попытки, а мы за неё заплатим.
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.reject(new PermanentError('файл повреждён'));
    };

    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow('файл повреждён');
    expect(calls).toBe(1);
  });

  it('повторяет обычную ошибку: неизвестное считаем временным', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls < 2) return Promise.reject(new Error('ECONNRESET'));
      return Promise.resolve('ок');
    };

    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe('ок');
    expect(calls).toBe(2);
  });

  it('выдерживает растущую паузу между попытками', async () => {
    const delays: number[] = [];
    const fn = () => Promise.reject(new TransientError('занято'));

    await expect(
      withRetry(fn, {
        attempts: 4,
        baseDelayMs: 100,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow();

    expect(delays).toEqual([100, 200, 400]);
  });

  it('сообщает о каждом повторе', async () => {
    const retries: number[] = [];
    const fn = () => Promise.reject(new TransientError('занято'));

    await expect(
      withRetry(fn, {
        attempts: 3,
        sleep: noSleep,
        onRetry: ({ attempt }) => retries.push(attempt),
      }),
    ).rejects.toThrow();

    expect(retries).toEqual([1, 2]);
  });

  it('передаёт номер попытки в функцию', async () => {
    const seen: number[] = [];
    const fn = (attempt: number) => {
      seen.push(attempt);
      if (attempt < 3) return Promise.reject(new TransientError('занято'));
      return Promise.resolve('ок');
    };

    await withRetry(fn, { sleep: noSleep });

    expect(seen).toEqual([1, 2, 3]);
  });
});

describe('withTimeout', () => {
  it('возвращает результат, если успели', async () => {
    await expect(withTimeout(() => Promise.resolve('быстро'), 1_000)).resolves.toBe('быстро');
  });

  it('падает, если не успели', async () => {
    const slow = () =>
      new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve('поздно');
        }, 200);
      });

    await expect(withTimeout(slow, 50, 'расшифровка')).rejects.toThrow(
      /расшифровка: превышен таймаут 50 мс/u,
    );
  });

  it('пробрасывает ошибку самой операции', async () => {
    await expect(withTimeout(() => Promise.reject(new Error('сбой')), 1_000)).rejects.toThrow(
      'сбой',
    );
  });
});
