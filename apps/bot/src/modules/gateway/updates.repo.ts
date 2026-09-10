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
 * Сколько держать журнал.
 *
 * Telegram перестаёт переотправлять апдейт через сутки после первой
 * попытки — дальше журналу нечего различать, а таблица растёт вечно.
 * Число стоит рядом со своим поводом, а не у того, кто зовёт чистку:
 * разъедутся — и срок останется без объяснения.
 *
 * **Уменьшать нельзя.** Апдейт без сообщения — нажатая кнопка — второго
 * рубежа не имеет: у сообщений повтор отбивает уникальность в
 * `messages_raw` (`messages.repo.ts`), а у кнопки только этот журнал.
 * Кнопка «это новое» ведёт к настоящему разбору, то есть к деньгам.
 */
export const UPDATE_LOG_RETENTION_MS = 24 * 60 * 60_000;

/**
 * Чистка журнала.
 *
 * Своего таймера у неё нет нарочно: единственный повторяющийся проход
 * бота — досмотр (`sweepOnce`), оттуда и зовётся. Заводить второй
 * таймер ради одного `delete` дороже, чем эта строка.
 */
export async function pruneUpdates(db: Executor, olderThan: Date): Promise<number> {
  const deleted = await db
    .delete(telegramUpdates)
    .where(lt(telegramUpdates.receivedAt, olderThan))
    .returning({ updateId: telegramUpdates.updateId });

  return deleted.length;
}
