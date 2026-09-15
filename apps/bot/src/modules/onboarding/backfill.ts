import { and, eq, isNotNull } from 'drizzle-orm';

import { items } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { localDateParts, startOfDayInZone } from '../classifier/dates.js';

/**
 * Домиграция первой выгрузки (задача 2.14).
 *
 * Следствие порядка из §12.2, которого в ТЗ нет: первая выгрузка
 * разбирается, когда часовой пояс ещё неизвестен, а тем ещё не
 * существует. Значит разбор идёт по допущениям — пояс `Europe/Moscow` и
 * базовый набор тем §6.4, — и когда человек отвечает на онбординге, эти
 * допущения надо заменить на его ответы.
 *
 * Иначе первая выгрузка навсегда остаётся кривой: у женщины во
 * Владивостоке дела висят по московскому времени, а её записи разложены
 * по темам, которых она не выбирала. И заметит она это не сразу, а когда
 * придёт напоминание не в тот день.
 */

/** Сколько суток разницы между двумя поясами в конкретный момент. */
function dayShift(instant: Date, from: string, to: string): number {
  const before = localDateParts(instant, from);
  const after = localDateParts(instant, to);

  const asNumber = (parts: { year: number; month: number; day: number }): number =>
    Date.UTC(parts.year, parts.month - 1, parts.day);

  // Разброс поясов на планете — 26 часов, поэтому разница дат бывает
  // только −1, 0 или +1. Делим на сутки без опаски.
  return Math.round((asNumber(after) - asNumber(before)) / 86_400_000);
}

export interface DeadlineRecalcResult {
  /** Сколько сроков пересчитано. */
  readonly recalculated: number;
  /** Сколько из них переехало на другой день, а не просто сдвинулось. */
  readonly movedToAnotherDay: number;
}

/**
 * Пересчитывает сроки записей под настоящий часовой пояс.
 *
 * Срок хранится как начало суток в поясе человека, а «в четверг» означает
 * календарный день, а не момент. Поэтому пересчёт — это взять локальную
 * дату в прежнем поясе и заново привязать её к тем же суткам в новом.
 *
 * **Плюс поправка на день.** Модель разрешала «сегодня» и «в четверг»
 * относительно неверного «сейчас»: ей передавали московское время, а у
 * человека были свои сутки. Женщина во Владивостоке, сказавшая «сегодня»
 * в два часа ночи, по Москве говорила это вчера вечером — и «сегодня»
 * разрешилось предыдущим числом. Разница локальных дат в момент создания
 * записи и есть эта поправка.
 *
 * **Чего пересчёт не вернёт.** Срок, отвергнутый при разборе как
 * «в прошлом» из-за той же путаницы, сохранён не был — восстанавливать
 * нечего. Запись при этом на месте, просто без срока.
 */
export async function recalcDeadlines(
  db: Executor,
  userId: string,
  change: { readonly from: string; readonly to: string },
): Promise<DeadlineRecalcResult> {
  if (change.from === change.to) return { recalculated: 0, movedToAnotherDay: 0 };

  const rows = await db
    .select({
      id: items.id,
      deadlineAt: items.deadlineAt,
      createdAt: items.createdAt,
    })
    .from(items)
    .where(and(eq(items.userId, userId), isNotNull(items.deadlineAt)));

  let movedToAnotherDay = 0;

  for (const row of rows) {
    if (row.deadlineAt === null) continue;

    const shift = dayShift(row.createdAt, change.from, change.to);
    const parts = localDateParts(row.deadlineAt, change.from);

    // Сдвиг применяется через UTC-арифметику, а не прибавлением к дню:
    // 31 августа плюс один день должно дать 1 сентября, а не 32 августа.
    const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + shift));
    const target = localDateParts(shifted, 'UTC');

    const at = startOfDayInZone(target, change.to);
    if (shift !== 0) movedToAnotherDay++;

    await db
      .update(items)
      .set({ deadlineAt: at, updatedAt: new Date() })
      .where(eq(items.id, row.id));
  }

  return { recalculated: rows.length, movedToAnotherDay };
}
