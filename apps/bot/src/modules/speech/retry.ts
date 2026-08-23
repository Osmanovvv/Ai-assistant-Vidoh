import { PermanentSpeechError } from './providers/types.js';

/**
 * Повтор с растущей паузой (задача 1.15).
 *
 * §10.2 ТЗ: каждый вызов оборачивается таймаутом и повтором с увеличением
 * паузы. §17: при недоступности модели выгрузка сохраняется в очередь и
 * обрабатывается позже — терять текст нельзя ни при каких обстоятельствах.
 *
 * Постоянные ошибки не повторяются: битый файл не станет целым от третьей
 * попытки, а мы за неё заплатим.
 */

export interface RetryOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Подмена ожидания в тестах: настоящие паузы делают тесты медленными. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const DEFAULTS = {
  attempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function backoffDelayMs(
  attempt: number,
  baseDelayMs = DEFAULTS.baseDelayMs,
  maxDelayMs = DEFAULTS.maxDelayMs,
): number {
  return Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULTS.attempts;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (error instanceof PermanentSpeechError) {
        throw error;
      }
      if (attempt === attempts) {
        break;
      }

      const delayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/** Ограничение по времени: зависший вызов не должен держать очередь. */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label = 'операция',
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label}: превышен таймаут ${String(timeoutMs)} мс`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
