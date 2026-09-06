import { and, count, eq, isNull, sql } from 'drizzle-orm';

import { batches } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import type { SettingsRegistry } from '../settings/settings.repo.js';

/**
 * Пробный период и деградация (§14 ТЗ, задача 4.3).
 *
 * **Пробный период считается выгрузками, а не днями** — так требует §14,
 * и это не придирка к формулировке: женщина, которая записала три мысли
 * за месяц, не должна терять доступ раньше той, что записала тридцать за
 * неделю. Дни мерят наше терпение, выгрузки — её пользу.
 *
 * **Что считается тратой.** Только доведённый до конца разбор. Не
 * считаются:
 *  - быстрое добавление «добавь ещё купить витамины» (§13.3) — плана
 *    4.3 требование прямое, и оно справедливо: полсекунды не равны
 *    разбору;
 *  - сбой на нашей стороне — иначе человек платит попыткой за нашу
 *    поломку;
 *  - выгрузка, висящая в очереди из-за отказа модели: 05.09.2026 доступ
 *    к Yandex закрылся, и такие выгрузки ждут в `queued`, ничего не
 *    потратив;
 *  - ответ на вопрос бота и нажатие кнопки — они выгрузкой не
 *    становятся вовсе.
 *
 * Отметку ставит разбор, в самом конце удавшегося пути (`dump.handler`).
 * Здесь только чтение и подсчёт: служба не решает, потратилась ли
 * выгрузка, — она отвечает, сколько уже потрачено.
 *
 * **Деградация — это чтение без записи.** §14: «после окончания доступа
 * бэклог остаётся доступен на чтение, новые выгрузки блокируются, данные
 * не удаляются». Поэтому запрет живёт ровно в одном месте — там, где
 * сообщение превращается в выгрузку, — и ни в одном другом. Меню,
 * карточки, напоминания и вопросы по бэклогу идут мимо: нажатие кнопки
 * не проходит через приём сообщений вовсе.
 *
 * **Подписки здесь ещё нет, и это честно.** Оплата — задача 4.2, и до
 * неё доступ даёт только пробный период. Когда подписка появится,
 * `accessOf` получит второй источник доступа, а всё остальное — гейт,
 * реплика, деградация — останется как есть.
 */

export interface AccessState {
  /** Можно ли заводить новую выгрузку. */
  readonly allowed: boolean;
  /** Сколько выгрузок пробного периода уже потрачено. */
  readonly spent: number;
  /** Сколько всего даёт пробный период. */
  readonly limit: number;
  /** Сколько осталось. Ноль — доступа больше нет. */
  readonly left: number;
}

/**
 * Есть ли у человека право на новую выгрузку.
 *
 * Считается запросом, а не счётчиком в профиле: счётчик, разойдясь с
 * правдой, не сверяется ни с чем, а этот подсчёт всегда равен тому, что
 * человек увидит в своей карточке в админке.
 */
export async function accessOf(
  db: Executor,
  params: { readonly userId: string; readonly settings: SettingsRegistry },
): Promise<AccessState> {
  const limit = await params.settings.number('trialDumps');
  const spent = await trialSpent(db, params.userId);

  return {
    allowed: spent < limit,
    spent,
    limit,
    left: Math.max(0, limit - spent),
  };
}

/** Сколько выгрузок этого человека потратили пробный период. */
export async function trialSpent(db: Executor, userId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(batches)
    .where(and(eq(batches.userId, userId), sql`${batches.trialCountedAt} is not null`));

  return row?.total ?? 0;
}

/**
 * Отметить, что эта выгрузка потратила пробный период.
 *
 * Только если ещё не отмечена: повторная обработка одной выгрузки не
 * должна тратить период дважды, а `processUserBatches` возвращает
 * выгрузку в очередь при временном сбое — то есть повтор здесь не
 * теоретический.
 *
 * Возвращает `true`, если отметка поставлена именно этим вызовом.
 */
export async function markTrialSpent(
  db: Executor,
  params: { readonly batchId: string; readonly now?: Date | undefined },
): Promise<boolean> {
  const updated = await db
    .update(batches)
    .set({ trialCountedAt: params.now ?? new Date() })
    .where(and(eq(batches.id, params.batchId), isNull(batches.trialCountedAt)))
    .returning({ id: batches.id });

  return updated.length > 0;
}
