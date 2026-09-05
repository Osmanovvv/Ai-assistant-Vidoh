import { AccessDeniedError, PermanentError, TransientError } from './failures.js';

/**
 * Различение временных и постоянных сбоев (задачи 1.11 и 1.18).
 *
 * Нужно, чтобы решить судьбу выгрузки: временный сбой стоит повторить,
 * постоянный — нет. Без этого различения любой сетевой обрыв навсегда
 * помечал выгрузку сбойной, и человек не получал ответа никогда.
 *
 * Так и случилось на первой же настоящей записи: скачивание файла из
 * Telegram однажды упёрлось в ETIMEDOUT, и выгрузка встала намертво,
 * хотя через минуту тот же файл качался за семь десятых секунды.
 *
 * Неизвестная ошибка считается постоянной намеренно. Ошибка в нашем коде
 * не станет правильной от повтора, а бесконечный цикл повторов на ней —
 * худшее, что можно сделать: он сжигает деньги заказчика и прячет причину.
 */

/**
 * Коды сетевых сбоев, которые проходят сами. Список закрытый: всё, что
 * в него не попало, разбирается вручную, а не крутится в повторах.
 */
const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** Глубина обхода цепочки причин: защита от закольцованного cause. */
const MAX_CAUSE_DEPTH = 8;

function codeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Временный ли сбой.
 *
 * Причина обходится по цепочке `cause`: undici прячет настоящий код на
 * два-три уровня вглубь, а наружу отдаёт безликое «fetch failed».
 * AggregateError от happy-eyeballs раскрывается отдельно — там код лежит
 * не у самой ошибки, а у каждой из попыток соединения.
 */
export function isTransientFailure(error: unknown, depth = 0): boolean {
  if (depth > MAX_CAUSE_DEPTH || typeof error !== 'object' || error === null) return false;

  // Провайдер уже разделил свои ошибки сам — верим ему.
  if (error instanceof PermanentError) return false;
  if (error instanceof TransientError) return true;

  const code = codeOf(error);
  if (code !== undefined && TRANSIENT_CODES.has(code)) return true;

  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      if (isTransientFailure(nested, depth + 1)) return true;
    }
  }

  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined ? false : isTransientFailure(cause, depth + 1);
}

/**
 * Отказ в доступе ли это (задача 3.72).
 *
 * Цепочка причин обходится так же, как в `isTransientFailure`: отказ
 * провайдера бывает завёрнут в ошибку этапа разбора, и снаружи виден
 * только верхний слой.
 *
 * Отдельно от «временного» именно потому, что решение другое: временный
 * сбой тратит попытку, отказ в доступе — нет. Ждать тут приходится не
 * чужую перегрузку, а возвращение нашего же доступа, и попытки на это
 * тратить нечестно.
 */
export function isAccessFailure(error: unknown, depth = 0): boolean {
  if (depth > MAX_CAUSE_DEPTH || typeof error !== 'object' || error === null) return false;

  if (error instanceof AccessDeniedError) return true;

  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      if (isAccessFailure(nested, depth + 1)) return true;
    }
  }

  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined ? false : isAccessFailure(cause, depth + 1);
}
