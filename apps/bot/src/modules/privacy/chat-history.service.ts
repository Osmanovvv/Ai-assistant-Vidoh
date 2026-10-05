import { and, eq } from 'drizzle-orm';

import { batches, messagesRaw, topics } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import type { Logger } from 'pino';

/**
 * Удаляет из личного чата сообщения, идентификаторы которых мы знаем.
 *
 * Telegram разрешает боту удалить входящее сообщение пользователя в
 * личном чате, но только в ограниченном временном окне. Поэтому ошибки
 * здесь ожидаемы: они означают, что конкретное старое сообщение осталось
 * в Telegram, а не что очистка данных пользователя сорвалась.
 */
export async function clearKnownChatHistory(
  db: Database,
  params: {
    readonly userId: string;
    readonly chatId: number;
    readonly deleteMessage: (chatId: number, messageId: number) => Promise<unknown>;
    readonly logger: Logger;
    readonly extraMessageIds?: readonly number[] | undefined;
  },
): Promise<{ readonly attempted: number; readonly deleted: number; readonly failed: number }> {
  const [incoming, statuses, summaries] = await Promise.all([
    db
      .select({ messageId: messagesRaw.tgMessageId })
      .from(messagesRaw)
      .where(and(eq(messagesRaw.userId, params.userId), eq(messagesRaw.tgChatId, params.chatId))),
    db
      .select({ messageId: batches.statusMessageId })
      .from(batches)
      .where(eq(batches.userId, params.userId)),
    db
      .select({ messageId: topics.summaryMessageId })
      .from(topics)
      .where(eq(topics.userId, params.userId)),
  ]);

  const ids = new Set<number>();
  for (const row of incoming) ids.add(row.messageId);
  for (const row of statuses) if (row.messageId !== null) ids.add(row.messageId);
  for (const row of summaries) if (row.messageId !== null) ids.add(row.messageId);
  for (const messageId of params.extraMessageIds ?? []) ids.add(messageId);

  let deleted = 0;
  let failed = 0;
  for (const messageId of ids) {
    try {
      await params.deleteMessage(params.chatId, messageId);
      deleted++;
    } catch (error: unknown) {
      failed++;
      params.logger.debug(
        { err: error, chatId: params.chatId, messageId },
        'Сообщение не удалено Telegram при очистке переписки',
      );
    }
  }

  return { attempted: ids.size, deleted, failed };
}
