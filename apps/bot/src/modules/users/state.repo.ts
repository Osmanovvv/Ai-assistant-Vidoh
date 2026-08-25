import { eq } from 'drizzle-orm';

import { userSettings, users, userState, type EnergyLevelValue } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';

/**
 * Сегодняшний уровень сил и то, что нужно выдаче (задачи 2.10, 2.11).
 *
 * §13.7 ТЗ: эмоция влияет ровно на одно — на уровень сил, а через него на
 * число действий в выдаче. Больше ни на что: ни на записи, ни на вопросы.
 */

export interface OutputContext {
  readonly timeZone: string;
  readonly energyDefault: EnergyLevelValue;
  readonly textProfile: string;
  readonly state?: { readonly energy: EnergyLevelValue; readonly energyAt: Date } | undefined;
}

/** Всё, что нужно для отбора и ответа, одним запросом. */
export async function outputContextOf(db: Executor, userId: string): Promise<OutputContext> {
  const [row] = await db
    .select({
      timeZone: users.timezone,
      energyDefault: userSettings.energyDefault,
      textProfile: userSettings.textProfile,
      energy: userState.energy,
      energyAt: userState.energyAt,
    })
    .from(users)
    .leftJoin(userSettings, eq(userSettings.userId, users.id))
    .leftJoin(userState, eq(userState.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);

  return {
    timeZone: row?.timeZone ?? 'Europe/Moscow',
    energyDefault: row?.energyDefault ?? 'normal',
    textProfile: row?.textProfile ?? 'reserved',
    ...(row?.energy != null && row.energyAt != null
      ? { state: { energy: row.energy, energyAt: row.energyAt } }
      : {}),
  };
}

/** Порядок от пустого к полному: нужен правилу «не поднимать уровень». */
const ORDER: readonly EnergyLevelValue[] = ['empty', 'low', 'normal', 'high'];

export async function setEnergy(
  db: Executor,
  userId: string,
  energy: EnergyLevelValue,
  at: Date,
): Promise<void> {
  await db
    .insert(userState)
    .values({ userId, energy, energyAt: at, updatedAt: at })
    .onConflictDoUpdate({
      target: userState.userId,
      set: { energy, energyAt: at, updatedAt: at },
    });
}

/**
 * Снижает уровень сил, но никогда не поднимает.
 *
 * §13.7 даёт эмоции право уменьшить объём выдачи. Права увеличить его у
 * неё нет: человек, сказавший утром «я на нуле», к обеду не становится
 * бодрее от того, что в новой выгрузке эмоций не было. Поднять уровень
 * может только он сам — это придёт с онбордингом и настройками.
 */
export async function lowerEnergy(
  db: Executor,
  userId: string,
  to: EnergyLevelValue,
  context: { readonly at: Date; readonly current: EnergyLevelValue },
): Promise<boolean> {
  if (ORDER.indexOf(to) >= ORDER.indexOf(context.current)) return false;

  await setEnergy(db, userId, to, context.at);
  return true;
}
