import type { Transformer } from 'grammy';
import { HttpError } from 'grammy';

/**
 * Повтор исходящего запроса к Telegram, если сеть не дала соединения
 * (задача 3.60).
 *
 * **Что было.** Боевое 04.09.2026, 19:28: человек прислал `/menu`, бот
 * собрал ответ и пошёл его отправлять — соединение с api.telegram.org не
 * установилось (`ETIMEDOUT`), grammY поднял ошибку, ответ пропал молча.
 * Человек увидел свою команду и тишину. Сеть у сервера в тот вечер
 * моргала весь час; бот при этом был здоров.
 *
 * **Почему только отказ соединения.** Повторять любой сетевой сбой
 * нельзя: `sendMessage` не идемпотентен, и обрыв **после** отправки дал
 * бы человеку два одинаковых ответа. А отказ на этапе соединения
 * (`ETIMEDOUT`, `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`) означает, что
 * запрос до Telegram не дошёл вовсе — повтор безопасен по построению.
 * `ECONNRESET` сюда не входит: он бывает и посреди ответа.
 *
 * Один повтор, полторы секунды паузы. Не «пока не получится»: если сеть
 * лежит, второй запрос покажет это так же, а третий и десятый только
 * задержат ошибку в журнале.
 */

const CONNECT_FAILURES = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** Код сетевой ошибки, до которого grammY добирается через `HttpError.error`. */
function codeOf(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Отказ соединения: запрос не дошёл до Telegram, повторить безопасно. */
export function isConnectFailure(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;

  // node-fetch кладёт код в саму ошибку; на всякий случай смотрим и в
  // `cause` — так делают другие клиенты.
  const inner = error.error;
  const code = codeOf(inner) ?? codeOf((inner as { cause?: unknown } | undefined)?.cause);

  return code !== undefined && CONNECT_FAILURES.has(code);
}

export interface RetryOptions {
  readonly delayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Преобразователь для `bot.api.config.use`. */
export function retryOnConnectFailure(options: RetryOptions = {}): Transformer {
  const delayMs = options.delayMs ?? 1_500;
  const sleep = options.sleep ?? wait;

  return async (prev, method, payload, signal) => {
    try {
      return await prev(method, payload, signal);
    } catch (error) {
      if (!isConnectFailure(error) || signal?.aborted === true) throw error;

      await sleep(delayMs);
      return await prev(method, payload, signal);
    }
  };
}
