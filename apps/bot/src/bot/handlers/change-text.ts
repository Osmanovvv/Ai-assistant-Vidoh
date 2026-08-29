import { localDateParts } from '../../modules/classifier/dates.js';
import type { Applied } from '../../modules/resolver/patch.js';
import type { TextProfile } from '../../texts/index.js';

/**
 * Что сказать человеку об изменении (§7.3 ТЗ, задача 3.3).
 *
 * «В ответе бот показывает, что именно изменилось, и даёт кнопку отмены
 * изменения.»
 *
 * **«Поправила» без «что» — это не отчёт, а обещание.** Человек не может
 * его проверить, не открыв запись, а значит не может и заметить ошибку.
 * Ради этого здесь разбор по видам изменения, а не одна общая фраза.
 *
 * Чистая функция: реплику надо проверять таблицей случаев, а не
 * поднимать ради неё базу.
 */

function shortDate(at: Date, timeZone: string): string {
  const parts = localDateParts(at, timeZone);
  return `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}`;
}

export function describeChange(applied: Applied, texts: TextProfile, timeZone: string): string {
  const { after, fields } = applied;
  const resolver = texts.resolver;

  if (fields.includes('status')) {
    return after.status === 'done'
      ? resolver.completed(after.text)
      : resolver.cancelled(after.text);
  }

  /**
   * Срок называется раньше формулировки.
   *
   * Обе правки в одной реплике не помещаются: §13.9 требует коротких
   * фраз. Срок важнее — он попадёт в напоминание, а формулировку человек
   * увидит в списке.
   */
  if (fields.includes('deadlineAt') && after.deadlineAt !== null) {
    return resolver.movedDeadline(after.text, shortDate(after.deadlineAt, timeZone));
  }

  return resolver.rewrote(after.text);
}
