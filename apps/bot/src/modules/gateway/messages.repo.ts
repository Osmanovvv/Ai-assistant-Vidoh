import type { Executor } from '../../infra/db.js';
import { messagesRaw, type MessageRaw, type NewMessageRaw } from '../../db/schema.js';

/**
 * Сырые входящие сообщения (задача 1.9).
 *
 * Инвариант §9.1 ТЗ: запись сюда идёт до расшифровки и до любого обращения
 * к модели. Всё, что происходит дальше, может упасть — сообщение уже наше.
 */
export async function saveRawMessage(
  db: Executor,
  input: NewMessageRaw,
): Promise<MessageRaw | undefined> {
  // Конфликт по паре «чат, сообщение» означает, что это сообщение уже
  // сохранено. Такое возможно при повторной доставке апдейта с другим
  // update_id — редко, но бывает.
  const [saved] = await db.insert(messagesRaw).values(input).onConflictDoNothing().returning();

  return saved;
}
