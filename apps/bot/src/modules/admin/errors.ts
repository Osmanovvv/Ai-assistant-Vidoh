import { and, count, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';

import {
  aiCalls,
  batches,
  billingInvoices,
  broadcastDeliveries,
  reminders,
  users,
} from '../../db/schema.js';
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
 *  - **неудачные отправки рассылки** — их повтор живёт в самой рассылке;
 *  - **неудачные платежи** (задача 4.2) — самый дорогой источник:
 *    человек мог заплатить и не получить доступ. Сюда попадают
 *    недоплаты (сумма не сошлась со счётом), несостоявшиеся продления и
 *    неоткрывшиеся страницы оплаты.
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

/**
 * Неудачный платёж (§14, задача 4.2).
 *
 * **Отдельный источник, потому что цена промаха здесь другая.** Не
 * увидеть сорвавшуюся выгрузку значит не ответить человеку; не увидеть
 * недоплату значит взять деньги и не выдать услугу. Второе разбирается
 * руками и разбирается срочно.
 *
 * Суммы обе: та, что в счёте, и та, что пришла. Разница между ними и
 * есть весь разбор.
 */
export interface FailedPayment {
  readonly id: string;
  readonly rail: string;
  readonly userId: string | null;
  readonly who: string;
  readonly tgId: number | null;
  readonly plan: string;
  readonly kind: string;
  /** Сколько ждали, в наименьших единицах. */
  readonly expectedMinor: number;
  readonly currency: string;
  /** Что пришло строкой, как её присылает провайдер. Пусто — не платили. */
  readonly received: string | null;
  readonly errorCode: number | null;
  readonly errorText: string | null;
  readonly at: string;
}

export interface FailedSend {
  readonly id: string;
  readonly broadcastId: string;
  readonly tgId: number;
  readonly error: string | null;
  readonly at: string | null;
}

/**
 * Сорвавшееся напоминание (§18, ревизия четвёртого этапа).
 *
 * Пятый источник сбоев, которого в журнале не было вовсе, и о его
 * отсутствии не было сказано словами. Напоминание, исчерпавшее попытки,
 * помечается `skipped_reason = 'failed'`, и эту колонку читал только сам
 * планировщик: человек не получил утреннего письма, а в панели — тишина.
 */
export interface FailedReminder {
  readonly id: string;
  readonly userId: string;
  readonly firstName: string | null;
  readonly tgId: number | null;
  /** Какое именно: утреннее, вечернее, по делу. */
  readonly kind: string;
  readonly at: string | null;
}

export interface ErrorsView {
  readonly days: number;
  readonly batches: readonly FailedBatch[];
  readonly calls: readonly FailedCall[];
  readonly sends: readonly FailedSend[];
  readonly payments: readonly FailedPayment[];
  readonly reminders: readonly FailedReminder[];
  /** Всего сорвавшихся выгрузок за период — список ограничен. */
  readonly batchesTotal: number;
  readonly callsTotal: number;
  readonly paymentsTotal: number;
  /**
   * Всего не дошедших писем рассылки за период.
   *
   * Ревизия этапа: список был обрезан пятьюдесятью **без итога** и не
   * подчинялся выбранному периоду — пятьдесят строк читались как полный
   * список, а строка месячной давности была видна при выборе «сутки».
   */
  readonly sendsTotal: number;
  readonly remindersTotal: number;
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
    /**
     * Период — как у трёх соседних источников (ревизия этапа 4).
     *
     * Прежде границы не было вовсе: при выборе «сутки» в списке стояли
     * письма месячной давности, а пятьдесят строк без итога читались как
     * полный список. Три соседних источника фильтруются по периоду и
     * печатают своё число — этот один молчал.
     */
    .where(
      and(
        eq(broadcastDeliveries.status, 'failed'),
        isNotNull(broadcastDeliveries.at),
        gte(broadcastDeliveries.at, from),
      ),
    )
    .orderBy(desc(broadcastDeliveries.at))
    .limit(LIMIT);

  const [sendsCount] = await db
    .select({ total: count() })
    .from(broadcastDeliveries)
    .where(
      and(
        eq(broadcastDeliveries.status, 'failed'),
        isNotNull(broadcastDeliveries.at),
        gte(broadcastDeliveries.at, from),
      ),
    );

  /**
   * Сорвавшиеся напоминания — пятый источник (§18, ревизия этапа 4).
   *
   * Прежде их не было в журнале вовсе, и о их отсутствии не было сказано
   * словами. Напоминание, исчерпавшее попытки, помечается
   * `skipped_reason = 'failed'` — колонку читал только планировщик.
   * Человек не получал утреннего письма, а панель молчала.
   */
  const failedReminders = await db
    .select({
      id: reminders.id,
      userId: reminders.userId,
      firstName: users.firstName,
      tgId: users.tgId,
      kind: reminders.kind,
      at: reminders.dueAt,
    })
    .from(reminders)
    .leftJoin(users, eq(users.id, reminders.userId))
    .where(and(eq(reminders.skippedReason, 'failed'), gte(reminders.dueAt, from)))
    .orderBy(desc(reminders.dueAt))
    .limit(LIMIT);

  const [remindersCount] = await db
    .select({ total: count() })
    .from(reminders)
    .where(and(eq(reminders.skippedReason, 'failed'), gte(reminders.dueAt, from)));

  /**
   * Неудачные платежи за период (задача 4.2).
   *
   * Человек берётся связью со счётом, а не по имени в счёте: имени там
   * нет и быть не должно. Обезличенный счёт (человек удалил данные)
   * остаётся видимым — деньги были, и в учёте они наши.
   */
  const failedPayments = await db
    .select({
      id: billingInvoices.id,
      rail: billingInvoices.provider,
      userId: billingInvoices.userId,
      firstName: users.firstName,
      username: users.username,
      tgId: users.tgId,
      plan: billingInvoices.plan,
      kind: billingInvoices.kind,
      expectedMinor: billingInvoices.amountMinor,
      currency: billingInvoices.currency,
      received: billingInvoices.outSumReceived,
      errorCode: billingInvoices.errorCode,
      errorText: billingInvoices.errorText,
      at: billingInvoices.createdAt,
    })
    .from(billingInvoices)
    .leftJoin(users, eq(users.id, billingInvoices.userId))
    .where(and(eq(billingInvoices.status, 'failed'), gte(billingInvoices.createdAt, from)))
    .orderBy(desc(billingInvoices.createdAt))
    .limit(LIMIT);

  const [paymentsCount] = await db
    .select({ total: count() })
    .from(billingInvoices)
    .where(and(eq(billingInvoices.status, 'failed'), gte(billingInvoices.createdAt, from)));

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
    payments: failedPayments.map((row) => ({
      id: row.id,
      rail: row.rail,
      userId: row.userId,
      who: nameOf(row),
      tgId: row.tgId,
      plan: row.plan,
      kind: row.kind,
      expectedMinor: row.expectedMinor,
      currency: row.currency,
      received: row.received,
      errorCode: row.errorCode,
      errorText: row.errorText,
      at: row.at.toISOString(),
    })),
    reminders: failedReminders.map((row) => ({
      id: row.id,
      userId: row.userId,
      firstName: row.firstName,
      tgId: row.tgId,
      kind: row.kind,
      at: row.at.toISOString(),
    })),
    batchesTotal: batchesCount?.total ?? 0,
    callsTotal: callsCount?.total ?? 0,
    paymentsTotal: paymentsCount?.total ?? 0,
    sendsTotal: sendsCount?.total ?? 0,
    remindersTotal: remindersCount?.total ?? 0,
    missing: [
      'Текстов расшифровок здесь нет нарочно: сказанное человеком — в его карточке, где доступ к нему журналируется (§16).',
      'Повторный запуск есть у выгрузок и у рассылки. Отдельный вызов модели повторить нельзя: он часть разбора, а не сам по себе.',
      'У неудачных платежей повтора нет и не будет: повторить списание — значит взять деньги второй раз. Недоплата и возврат разбираются руками, через обращение человека.',
      'У сорвавшихся напоминаний повтора нет: время прошло, и вечернее письмо, присланное на следующий день, — не то напоминание, о котором просили. Планировщик поставит следующее в свой срок.',
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
