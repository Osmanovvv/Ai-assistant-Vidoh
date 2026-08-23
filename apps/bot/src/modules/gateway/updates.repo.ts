import { lt } from 'drizzle-orm';

import type { Executor } from '../../infra/db.js';
import { telegramUpdates } from '../../db/schema.js';

/**
 * Журнал обработанных апдейтов (задача 1.8).
 *
 * Telegram переотправляет апдейт, если не получил ответ вовремя. Заявка
 * на обработку берётся вставкой: выигрывает тот, кто вставил строку,
 * остальные видят конфликт. Это работает и при гонке двух воркеров,
 * потому что уникальность обеспечивает сама база, а не проверка в коде.
 */
export async function claimUpdate(db: Executor, updateId: number): Promise<boolean> {
  const inserted = await db
    .insert(telegramUpdates)
    .values({ updateId })
    .onConflictDoNothing()
    .returning({ updateId: telegramUpdates.updateId });

  return inserted.length > 0;
}

/**
 * Чистка журнала. Telegram не переотправляет апдейты старше суток,
 * поэтому хранить их дольше незачем — таблица иначе растёт вечно.
 */
export async function pruneUpdates(db: Executor, olderThan: Date): Promise<number> {
  const deleted = await db
    .delete(telegramUpdates)
    .where(lt(telegramUpdates.receivedAt, olderThan))
    .returning({ updateId: telegramUpdates.updateId });

  return deleted.length;
}
