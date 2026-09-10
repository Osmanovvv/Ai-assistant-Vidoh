import { GrammyError } from 'grammy';

/**
 * Сообщение исчезло: человек удалил его руками.
 *
 * Одно правило на всех, а не по копии у каждого. Копий было две — у
 * сводки темы и (после ревизии этапов 1–2) у статусного сообщения, — и
 * разъехаться им нельзя: обе решают одно и то же, «править нечего,
 * надо слать заново».
 *
 * В личном чате Telegram человеку разрешено удалять сообщения бота, и
 * это не редкость: статусное сообщение выглядит служебным.
 */
export function isMessageGone(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  if (error.error_code !== 400) return false;

  const description = error.description.toLowerCase();

  return (
    description.includes('message to edit not found') || description.includes('message_id_invalid')
  );
}
