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

/**
 * Отмена запроса по таймауту (задача 3.81).
 *
 * **Раньше здесь стояла одна гонка:** мы переставали ждать, а запрос к
 * модели жил дальше — соединение открыто, генерация идёт, счётчик тикает.
 * При трёх попытках повтора один вызов мог оплатиться трижды, а в учёт
 * попадала одна строка: у сорвавшегося вызова расход пустой.
 *
 * После 05.09.2026, когда у облака кончились деньги, такие траты уже не
 * «мелочь округления».
 */
describe('withTimeout отменяет брошенный запрос', () => {
  it('по таймауту сигнал отменяется', async () => {
    let seen: AbortSignal | undefined;

    const hanging = (signal: AbortSignal): Promise<never> => {
      seen = signal;
      return new Promise<never>(() => {
        // Никогда не отвечает: ровно то, ради чего таймаут и нужен.
      });
    };

    await expect(withTimeout(hanging, 20, 'запрос к модели')).rejects.toThrow(/таймаут/u);

    expect(seen?.aborted).toBe(true);
  });

  it('успевший ответ отменой не портится', async () => {
    // Отмена после успеха безвредна, но проверить это надо: иначе
    // «починка» лишила бы бота всех ответов разом.
    let seen: AbortSignal | undefined;

    const quick = (signal: AbortSignal): Promise<string> => {
      seen = signal;
      return Promise.resolve('ответ');
    };

    await expect(withTimeout(quick, 1_000)).resolves.toBe('ответ');
    // Сигнал отменяется по выходу — но ответ уже получен и отдан.
    expect(seen?.aborted).toBe(true);
  });

  it('отказ отменённого запроса не становится необработанным', async () => {
    /**
     * Проигравшая сторона гонки отклоняется **позже** победившей, и без
     * своего обработчика её отказ становится необработанным. Такое уже
     * роняло этот процесс однажды — на express пятой версии.
     */
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };

    process.on('unhandledRejection', onUnhandled);

    try {
      const late = (signal: AbortSignal): Promise<never> =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            setTimeout(() => {
              reject(new Error('запрос отменён'));
            }, 5);
          });
        });

      await expect(withTimeout(late, 20)).rejects.toThrow(/таймаут/u);

      // Даём отменённому запросу время отклониться после гонки.
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('каждая попытка повтора получает свой сигнал', async () => {
    // Иначе вторая попытка стартовала бы с уже отменённым сигналом и
    // падала бы сразу — то есть повторов не стало бы вовсе.
    const signals: AbortSignal[] = [];
    let attempt = 0;

    await withRetry(
      () =>
        withTimeout((signal) => {
          signals.push(signal);
          attempt++;

          return attempt === 1 ? Promise.reject(new Error('сеть')) : Promise.resolve('ответ');
        }, 1_000),
      { attempts: 2, sleep: () => Promise.resolve() },
    );

    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[1]?.aborted).toBe(true);
  });
});
