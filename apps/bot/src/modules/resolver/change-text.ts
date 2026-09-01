import { localDateParts } from '../classifier/dates.js';
import type { Applied } from './patch.js';
import type { StatusButton } from '../presenter/status.service.js';
import type { TextProfile } from '../../texts/index.js';
import { toShortId } from '../shared/short-id.js';
import { titleWithoutDate } from './title-date.js';

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

  /**
   * Регулярное дело сперва: у него выполнение выглядит как перенос
   * срока, и общая реплика «перенесла на 05.10» соврала бы — человек
   * ничего не переносил, он дело сделал (задача 3.8а).
   */
  if (applied.action === 'complete' && after.deadlineAt !== null && fields.includes('deadlineAt')) {
    return resolver.completedRecurring(
      titleWithoutDate(after.text),
      shortDate(after.deadlineAt, timeZone),
    );
  }

  // Правило выставлено или изменено (задача 3.8б).
  if (applied.action === 'update' && fields.includes('recurrenceRule')) {
    return resolver.ruleSet(after.text, after.recurrenceText ?? '');
  }

  if (applied.action === 'cancel' && fields.includes('recurrenceRule')) {
    return resolver.ruleDropped(after.text);
  }

  // §7.4 идёт первым: дополнение не трогает ни заголовок, ни срок, и
  // сказать о нём надо именно как о дополнении.
  if (fields.includes('body')) return resolver.noted(after.text);

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
    return resolver.movedDeadline(
      titleWithoutDate(after.text),
      shortDate(after.deadlineAt, timeZone),
    );
  }

  return resolver.rewrote(after.text);
}

/**
 * Кнопка отмены как данные, а не как клавиатура Telegram.
 *
 * Строится здесь, а не в обработчике: реплику об изменении шлют двое —
 * обработчик кнопки и конвейер, когда человек ответил голосом. Две копии
 * одной кнопки однажды разъехались бы префиксом, и половина отмен
 * перестала бы находиться.
 */
export const UNDO_PREFIX = 'u:';

export function undoButtons(revisionId: string, texts: TextProfile): readonly StatusButton[] {
  return [{ label: texts.resolver.buttonUndo, action: `${UNDO_PREFIX}${toShortId(revisionId)}` }];
}

/**
 * Кнопки уточняющего вопроса — там же, где кнопка отмены, и по той же
 * причине: вопрос задают двое.
 *
 * Резолвер спрашивает из конвейера, разбирая правку; обработчик отвечает
 * на нажатие. Разъедься префиксы — нажатие перестанет находить вопрос.
 */
export const QUESTION_ACTION = {
  attach: 'q:a:',
  separate: 'q:s:',
} as const;

export function questionButtons(questionId: string, texts: TextProfile): readonly StatusButton[] {
  const code = toShortId(questionId);

  return [
    { label: texts.resolver.buttonAttach, action: `${QUESTION_ACTION.attach}${code}` },
    { label: texts.resolver.buttonSeparate, action: `${QUESTION_ACTION.separate}${code}` },
  ];
}
