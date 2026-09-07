import { and, count, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';

import { aiCalls, batches, broadcastDeliveries, users } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';

/**
 * Журнал сбоев в панели (§15 ТЗ, задача 4.10).
 *
 * §15 просит «журнал неуспешных вызовов и сбоев с возможностью
 * повторного запуска». Три источника, и они разные по смыслу:
 *
 *  - **сорвавшиеся выгрузки** — единственное, что видит человек: он
 *    сказал мысль и не получил разбора. Это и есть главное здесь;
 *  - **неуспешные вызовы модели** — причина, по которой выгрузка
 *    сорвалась, и заодно счёт: 403 не тарифится, а таймаут после
 *    отправки — да (задача 3.82);
 *  - **неудачные отправки рассылки** — их повтор живёт в самой рассылке.
 *
 * **Перезапуск есть только у выгрузок, и это не недоделка.** Повторить
 * вызов модели в отрыве от выгрузки нельзя: он часть конвейера, и его
 * место — внутри разбора, а не рядом. Повторяется то, что имеет смысл
 * повторить целиком.
 *
 * **Текстов расшифровок здесь нет.** Видно, что выгрузка сорвалась, кто
 * её хозяин и на чём именно; сказанное человеком — в карточке (задача
 * 4.6), где доступ к нему пишется в журнал §16. Журнал ошибок читают
 * часто и мимоходом, и содержимому чужих мыслей в нём делать нечего.
 */

export interface FailedBatch {
  readonly id: string;
  readonly userId: string | null;
  readonly who: string;
  readonly tgId: number | null;
  readonly status: string;
  readonly attempts: number;
  readonly error: string | null;
  readonly openedAt: string;
  /** Сколько знаков сказал человек. Сам текст — в карточке. */
  readonly length: number;
}

export interface FailedCall {
  readonly id: string;
  readonly stage: string;
  readonly model: string;
  readonly promptVersion: string | null;
  readonly error: string | null;
  readonly latencyMs: number;
  readonly at: string;
  readonly batchId: string | null;
  /** Заплатили ли за этот неудачный вызов. */
  readonly paid: boolean;
}

export interface FailedSend {
  readonly id: string;
  readonly broadcastId: string;
  readonly tgId: number;
  readonly error: string | null;
  readonly at: string | null;
}

export interface ErrorsView {
  readonly days: number;
  readonly batches: readonly FailedBatch[];
  readonly calls: readonly FailedCall[];
  readonly sends: readonly FailedSend[];
  /** Всего сорвавшихся выгрузок за период — список ограничен. */
  readonly batchesTotal: number;
  readonly callsTotal: number;
  /** Чего в журнале нарочно нет — словами, а не пустыми колонками. */
  readonly missing: readonly string[];
}

/** Сколько строк отдаём в списке. Больше человек всё равно не прочтёт. */
const LIMIT = 50;

function since(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60_000);
}

export async function errorsView(db: Executor, days: number): Promise<ErrorsView> {
  const from = since(days);

  const failedBatches = await db
    .select({
      id: batches.id,
      userId: batches.userId,
      firstName: users.firstName,
      username: users.username,
      tgId: users.tgId,
      status: batches.status,
      attempts: batches.attempts,
      error: batches.error,
      openedAt: batches.openedAt,
      length: sql<number>`coalesce(length(${batches.combinedText}), 0)`,
    })
    .from(batches)
    .leftJoin(users, eq(users.id, batches.userId))
    .where(and(eq(batches.status, 'failed'), gte(batches.openedAt, from)))
    .orderBy(desc(batches.openedAt))
    .limit(LIMIT);

  const [batchesCount] = await db
    .select({ total: count() })
    .from(batches)
    .where(and(eq(batches.status, 'failed'), gte(batches.openedAt, from)));

  const failedCalls = await db
    .select({
      id: aiCalls.id,
      stage: aiCalls.stage,
      model: aiCalls.model,
      promptVersion: aiCalls.promptVersion,
      error: aiCalls.error,
      latencyMs: aiCalls.latencyMs,
      at: aiCalls.createdAt,
      batchId: aiCalls.batchId,
      costMicros: aiCalls.costMicros,
    })
    .from(aiCalls)
    .where(and(eq(aiCalls.ok, false), gte(aiCalls.createdAt, from)))
    .orderBy(desc(aiCalls.createdAt))
    .limit(LIMIT);

  const [callsCount] = await db
    .select({ total: count() })
    .from(aiCalls)
    .where(and(eq(aiCalls.ok, false), gte(aiCalls.createdAt, from)));

  const failedSends = await db
    .select({
      id: broadcastDeliveries.id,
      broadcastId: broadcastDeliveries.broadcastId,
      tgId: broadcastDeliveries.tgId,
      error: broadcastDeliveries.error,
      at: broadcastDeliveries.at,
    })
    .from(broadcastDeliveries)
    .where(and(eq(broadcastDeliveries.status, 'failed'), isNotNull(broadcastDeliveries.at)))
    .orderBy(desc(broadcastDeliveries.at))
    .limit(LIMIT);

  return {
    days,
    batches: failedBatches.map((row) => ({
      id: row.id,
      userId: row.userId,
      who: nameOf(row),
      tgId: row.tgId,
      status: row.status,
      attempts: row.attempts,
      error: row.error,
      openedAt: row.openedAt.toISOString(),
      length: row.length,
    })),
    calls: failedCalls.map((row) => ({
      id: row.id,
      stage: row.stage,
      model: row.model,
      promptVersion: row.promptVersion,
      error: row.error,
      latencyMs: row.latencyMs,
      at: row.at.toISOString(),
      batchId: row.batchId,
      // За неудачный вызов иногда всё равно платят: отправка состоялась,
      // а ответа мы не дождались (задача 3.82).
      paid: (row.costMicros ?? 0) > 0,
    })),
    sends: failedSends.map((row) => ({
      id: row.id,
      broadcastId: row.broadcastId,
      tgId: row.tgId,
      error: row.error,
      at: row.at?.toISOString() ?? null,
    })),
    batchesTotal: batchesCount?.total ?? 0,
    callsTotal: callsCount?.total ?? 0,
    missing: [
      'Текстов расшифровок здесь нет нарочно: сказанное человеком — в его карточке, где доступ к нему журналируется (§16).',
      'Повторный запуск есть у выгрузок и у рассылки. Отдельный вызов модели повторить нельзя: он часть разбора, а не сам по себе.',
    ],
  };
}

function nameOf(row: {
  readonly firstName: string | null;
  readonly username: string | null;
  readonly tgId: number | null;
}): string {
  if (row.firstName !== null && row.firstName !== '') return row.firstName;
  if (row.username !== null && row.username !== '') return `@${row.username}`;

  return row.tgId === null ? 'данные удалены' : `id ${String(row.tgId)}`;
}

export type RestartOutcome =
  | { readonly ok: true; readonly userId: string }
  /** Нечего перезапускать: выгрузки нет или она не сорвана. */
  | { readonly ok: false; readonly why: string };

/**
 * Вернуть сорвавшуюся выгрузку в очередь — «повторный запуск» из §15.
 *
 * **Ровно то, чего не хватало до этой задачи.** Сбойные выгрузки
 * намеренно не переподхватываются: бесконечный повтор на нашей же ошибке
 * сжигает чужие деньги и прячет причину. Но это значило, что человек,
 * чей разбор сорвался, не получал его никогда — и об этом прямо сказано в
 * коде конвейера и в тексте извинения (§17). Обещанная там «админка, из
 * которой их перезапускают», — здесь.
 *
 * Счётчик попыток сбрасывается: разбирался сбой руками, значит причину
 * либо устранили, либо решили попробовать ещё раз осознанно. Оставить
 * счётчик на пределе означало бы, что кнопка ничего не делает.
 *
 * Постановку в очередь эта функция не делает: очередь — дело вызывающего.
 * Иначе модуль панели знал бы про Redis, а знать ему незачем.
 */
export async function restartBatch(db: Executor, batchId: string): Promise<RestartOutcome> {
  const [row] = await db
    .select({ userId: batches.userId, status: batches.status })
    .from(batches)
    .where(eq(batches.id, batchId))
    .limit(1);

  if (row === undefined) return { ok: false, why: 'такой выгрузки нет' };

  if (row.status !== 'failed') {
    // Перезапускать идущую выгрузку — способ получить два разбора одной
    // мысли и два счёта за неё.
    return { ok: false, why: `выгрузка в состоянии «${row.status}», а не «failed»` };
  }

  const back = await db
    .update(batches)
    .set({ status: 'queued', attempts: 0, error: null })
    .where(and(eq(batches.id, batchId), eq(batches.status, 'failed')))
    .returning({ userId: batches.userId });

  const restarted = back[0];

  // Условие в `where` могло не сойтись: кто-то перезапустил раньше нас.
  if (restarted === undefined) return { ok: false, why: 'выгрузку уже перезапустили' };

  return { ok: true, userId: restarted.userId };
}
