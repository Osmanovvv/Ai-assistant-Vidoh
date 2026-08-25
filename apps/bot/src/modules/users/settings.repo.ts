import { eq } from 'drizzle-orm';

import { userSettings, users } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';

/**
 * Настройки пользователя, нужные при ответе (задача 2.11).
 *
 * §13.8 ТЗ: тон переключается флагом на уровне пользователя. Отсюда
 * запрос по идентификатору Telegram: обработчики команд знают только его,
 * а внутренний идентификатор им для одной реплики не нужен.
 *
 * Отсутствие пользователя — не ошибка. Первый экран (§13.1) показывается
 * до регистрации, и профиля в этот момент ещё нет: вернётся `null`, а
 * словарь подставит профиль по умолчанию.
 */

export async function textProfileByTgId(db: Executor, tgId: number): Promise<string | null> {
  const [row] = await db
    .select({ profile: userSettings.textProfile })
    .from(userSettings)
    .innerJoin(users, eq(users.id, userSettings.userId))
    .where(eq(users.tgId, tgId))
    .limit(1);

  return row?.profile ?? null;
}

export async function textProfileOf(db: Executor, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ profile: userSettings.textProfile })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);

  return row?.profile ?? null;
}
