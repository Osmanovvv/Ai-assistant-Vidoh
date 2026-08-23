import { GrammyError } from 'grammy';

/**
 * Распознавание блокировки бота пользователем (задача 1.19).
 *
 * В §17 ТЗ этого сценария нет, а это самый частый отказ у бота с
 * ежедневными напоминаниями. Признаков два, и нужны оба:
 *
 *   1. Апдейт my_chat_member со статусом kicked — приходит сразу, когда
 *      человек нажал «Заблокировать». Самый честный сигнал.
 *   2. Ошибка 403 при отправке — ловит случаи, когда апдейт мы пропустили:
 *      бот лежал, вебхук был отключён, пользователь удалил чат.
 *
 * Чистые функции без обращений к базе: решение «это блокировка или нет»
 * проверяется тестами без Postgres и без Telegram.
 */

/** Статусы участника, при которых бот больше не может писать. */
const BLOCKED_STATUSES = new Set(['kicked', 'left']);

export function isBlockingStatus(status: string): boolean {
  return BLOCKED_STATUSES.has(status);
}

/**
 * Тексты Telegram при блокировке. Код 403 бывает и по другим причинам —
 * например, бот выгнан из группы, — но для личного чата эти сообщения
 * означают именно блокировку или удаление аккаунта.
 */
const BLOCKED_DESCRIPTIONS = [
  'bot was blocked by the user',
  'user is deactivated',
  'chat not found',
  'bot was kicked',
];

export function isBlockedError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  if (error.error_code !== 403) return false;

  const description = error.description.toLowerCase();
  return BLOCKED_DESCRIPTIONS.some((known) => description.includes(known));
}

/**
 * Стоит ли повторять отправку. Блокировку повторять бессмысленно:
 * без этой проверки планировщик будет ретраить 403 до конца времён
 * и засорять журнал ошибок.
 */
export function isRetryableSendError(error: unknown): boolean {
  if (isBlockedError(error)) return false;
  if (!(error instanceof GrammyError)) return true;

  // 400 — наша ошибка в запросе, повтор её не исправит.
  return error.error_code !== 400;
}
