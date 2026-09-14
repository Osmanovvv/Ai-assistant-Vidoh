import { eq } from 'drizzle-orm';

import { userSettings, users } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';

/**
 * То, что нужно выдаче и ответу о человеке (задачи 2.10, 2.11).
 *
 * До 14.09.2026 здесь жил и уровень сил «на сегодня» (§13.7 ТЗ: эмоция
 * снижала его, а он — число дел в выдаче). Заказчица его отменила
 * (правка 14.09.2026, п. 1.2): бот не делает вывода о силах женщины и не
 * хранит такой показатель. Таблица `user_state` и `energy_default`
 * удалены миграцией 0052.
 */

export interface OutputContext {
  readonly timeZone: string;
  readonly textProfile: string;
}

/** Всё, что нужно для отбора и ответа, одним запросом. */
export async function outputContextOf(db: Executor, userId: string): Promise<OutputContext> {
  const [row] = await db
    .select({
      timeZone: users.timezone,
      textProfile: userSettings.textProfile,
    })
    .from(users)
    .leftJoin(userSettings, eq(userSettings.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);

  return {
    timeZone: row?.timeZone ?? 'Europe/Moscow',
    textProfile: row?.textProfile ?? 'reserved',
  };
}
