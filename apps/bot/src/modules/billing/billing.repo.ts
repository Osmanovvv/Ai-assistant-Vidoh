import { and, desc, eq, gt, sql } from 'drizzle-orm';

import {
  billingEvents,
  billingInvoices,
  billingSubscriptions,
  type BillingInvoice,
  type BillingSubscription,
} from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import type { PlanKind } from './provider.js';
import type { Rail } from './tariffs.js';

/**
 * Хранение подписки, счетов и событий оплаты (§14 ТЗ, задача 4.2).
 *
 * Здесь только работа с базой: решения принимает служба подписки.
 * Разделение не для красоты — идемпотентность держится **уникальным
 * индексом**, и место, где это происходит, должно быть одно и на виду.
 */

/**
 * Номер счёта для Робокассы — из последовательности базы.
 *
 * Не `max() + 1` и не случайное число: повторный номер Робокасса
 * отвергает ошибкой 40, а ноль или пустое значение означает «назначу
 * номер сам» — и тогда наш номер окажется мёртвым, а продление через
 * месяц уйдёт в пустоту. Последовательность не переиспользует номера
 * даже после отката транзакции, и это ровно то, что нужно.
 */
export async function nextInvId(db: Executor): Promise<number> {
  /**
   * Через текст, а не число: `nextval` отдаёт int64, и в JavaScript он не
   * влезает целиком. Наши номера мелкие, но проверка ниже честнее, чем
   * надежда на это.
   */
  const result = await db.execute<{ readonly value: string }>(
    sql`select nextval('billing_inv_id_seq')::text as value`,
  );

  const value = Number(result.rows[0]?.value ?? '0');

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Последовательность номеров счетов вернула «${String(result.rows[0]?.value)}»`);
  }

  return value;
}

export interface NewInvoice {
  readonly provider: Rail;
  readonly userId: string;
  readonly plan: PlanKind;
  readonly kind: 'initial' | 'renewal';
  readonly amountMinor: number;
  readonly currency: string;
  readonly ref: string;
  readonly invId?: number | undefined;
  readonly parentInvId?: number | undefined;
  readonly outSumSent?: string | undefined;
  readonly expiresAt?: Date | undefined;
}

export async function createInvoice(db: Executor, params: NewInvoice): Promise<BillingInvoice> {
  const [row] = await db
    .insert(billingInvoices)
    .values({
      provider: params.provider,
      userId: params.userId,
      plan: params.plan,
      kind: params.kind,
      amountMinor: params.amountMinor,
      currency: params.currency,
      ref: params.ref,
      ...(params.invId === undefined ? {} : { invId: params.invId }),
      ...(params.parentInvId === undefined ? {} : { parentInvId: params.parentInvId }),
      ...(params.outSumSent === undefined ? {} : { outSumSent: params.outSumSent }),
      ...(params.expiresAt === undefined ? {} : { expiresAt: params.expiresAt }),
    })
    .returning();

  if (row === undefined) throw new Error('Счёт не создался');

  return row;
}

/** Счёт по нашей метке. По ней уведомление находит человека и тариф. */
export async function invoiceByRef(
  db: Executor,
  params: { readonly provider: Rail; readonly ref: string },
): Promise<BillingInvoice | undefined> {
  const [row] = await db
    .select()
    .from(billingInvoices)
    .where(and(eq(billingInvoices.provider, params.provider), eq(billingInvoices.ref, params.ref)))
    .orderBy(desc(billingInvoices.createdAt))
    .limit(1);

  return row;
}

/** Счёт по нашему номеру — тому, что мы отправили Робокассе. */
export async function invoiceByInvId(
  db: Executor,
  invId: number,
): Promise<BillingInvoice | undefined> {
  const [row] = await db
    .select()
    .from(billingInvoices)
    .where(eq(billingInvoices.invId, invId))
    .limit(1);

  return row;
}

export async function markInvoicePaid(
  db: Executor,
  params: {
    readonly id: string;
    readonly providerInvId?: number | undefined;
    readonly outSumReceived?: string | undefined;
    readonly now: Date;
  },
): Promise<void> {
  await db
    .update(billingInvoices)
    .set({
      status: 'paid',
      paidAt: params.now,
      ...(params.providerInvId === undefined ? {} : { providerInvId: params.providerInvId }),
      ...(params.outSumReceived === undefined ? {} : { outSumReceived: params.outSumReceived }),
    })
    .where(eq(billingInvoices.id, params.id));
}

export async function markInvoiceFailed(
  db: Executor,
  params: {
    readonly id: string;
    readonly errorCode?: number | undefined;
    readonly errorText?: string | undefined;
  },
): Promise<void> {
  await db
    .update(billingInvoices)
    .set({
      status: 'failed',
      ...(params.errorCode === undefined ? {} : { errorCode: params.errorCode }),
      ...(params.errorText === undefined ? {} : { errorText: params.errorText }),
    })
    .where(eq(billingInvoices.id, params.id));
}

/**
 * Записать событие. Ложь означает «такое уже приходило».
 *
 * **Здесь и живёт условие готовности задачи** — «повторная доставка
 * события оплаты не создаёт второй платёж». Держится оно уникальным
 * индексом, а не проверкой «сначала посмотрели, потом вставили»:
 * Робокасса повторяет уведомления, в том числе одновременно, и чтение
 * перед вставкой такую гонку пропускает.
 *
 * `onConflictDoNothing` возвращает пустой список, когда строка уже была,
 * — по нему и отличается первая доставка от повторной.
 */
export async function recordEvent(
  db: Executor,
  params: {
    readonly provider: Rail;
    readonly externalId: string;
    readonly kind: string;
    readonly signatureOk: boolean;
    readonly payload: unknown;
    readonly method?: string | undefined;
    readonly invoiceId?: string | undefined;
  },
): Promise<{ readonly first: boolean; readonly id: string | undefined }> {
  const inserted = await db
    .insert(billingEvents)
    .values({
      provider: params.provider,
      externalId: params.externalId,
      kind: params.kind,
      signatureOk: params.signatureOk,
      payload: params.payload,
      ...(params.method === undefined ? {} : { method: params.method }),
      ...(params.invoiceId === undefined ? {} : { invoiceId: params.invoiceId }),
    })
    .onConflictDoNothing({
      target: [billingEvents.provider, billingEvents.externalId, billingEvents.kind],
    })
    .returning({ id: billingEvents.id });

  const row = inserted[0];

  return { first: row !== undefined, id: row?.id };
}

export async function markEventProcessed(db: Executor, id: string, now: Date): Promise<void> {
  await db.update(billingEvents).set({ processedAt: now }).where(eq(billingEvents.id, id));
}

/** Подписка человека на этом рельсе. */
export async function subscriptionOf(
  db: Executor,
  params: { readonly userId: string; readonly provider: Rail },
): Promise<BillingSubscription | undefined> {
  const [row] = await db
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.userId, params.userId),
        eq(billingSubscriptions.provider, params.provider),
      ),
    )
    .limit(1);

  return row;
}

/** Все подписки человека: рельсов два, а доступ общий. */
export async function subscriptionsOf(
  db: Executor,
  userId: string,
): Promise<readonly BillingSubscription[]> {
  return await db
    .select()
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.userId, userId));
}

/**
 * Завести или продлить подписку.
 *
 * Одним запросом с `onConflictDoUpdate`: два уведомления, пришедшие
 * одновременно, не должны создать две строки — уникальный индекс по паре
 * «человек, рельс» этого не допустит, но упасть на нём было бы хуже, чем
 * обновить.
 */
export async function upsertSubscription(
  db: Executor,
  params: {
    readonly userId: string;
    readonly provider: Rail;
    readonly plan: PlanKind;
    readonly currentPeriodEnd: Date;
    readonly subscriptionRef?: string | undefined;
    readonly autoRenew: boolean;
    readonly now: Date;
    readonly renewal: boolean;
  },
): Promise<void> {
  await db
    .insert(billingSubscriptions)
    .values({
      userId: params.userId,
      provider: params.provider,
      plan: params.plan,
      status: 'active',
      autoRenew: params.autoRenew,
      currentPeriodEnd: params.currentPeriodEnd,
      ...(params.subscriptionRef === undefined ? {} : { subscriptionRef: params.subscriptionRef }),
      ...(params.renewal ? { lastRenewalAt: params.now } : {}),
    })
    .onConflictDoUpdate({
      target: [billingSubscriptions.userId, billingSubscriptions.provider],
      set: {
        plan: params.plan,
        status: 'active',
        autoRenew: params.autoRenew,
        currentPeriodEnd: params.currentPeriodEnd,
        updatedAt: params.now,
        /**
         * Отмена снимается оплатой.
         *
         * Человек отменил автопродление, а потом заплатил снова — значит
         * передумал. Оставить `canceledAt` значило бы показывать ему
         * «подписка отменена» на только что оплаченной подписке.
         */
        canceledAt: null,
        ...(params.subscriptionRef === undefined
          ? {}
          : { subscriptionRef: params.subscriptionRef }),
        ...(params.renewal ? { lastRenewalAt: params.now } : {}),
      },
    });
}

/**
 * Отключить автопродление — §14 «в один тап».
 *
 * `currentPeriodEnd` не трогается нарочно: §14 требует, чтобы доступ
 * сохранялся до конца оплаченного периода. Отмена — это про деньги, а не
 * про доступ.
 */
export async function stopAutoRenew(
  db: Executor,
  params: { readonly userId: string; readonly provider: Rail; readonly now: Date },
): Promise<boolean> {
  const done = await db
    .update(billingSubscriptions)
    .set({ autoRenew: false, canceledAt: params.now, updatedAt: params.now })
    .where(
      and(
        eq(billingSubscriptions.userId, params.userId),
        eq(billingSubscriptions.provider, params.provider),
        eq(billingSubscriptions.autoRenew, true),
      ),
    )
    .returning({ id: billingSubscriptions.id });

  return done.length > 0;
}

/** Пометить, что продление не прошло: карта отвалилась или денег нет. */
export async function markPastDue(
  db: Executor,
  params: { readonly userId: string; readonly provider: Rail; readonly now: Date },
): Promise<void> {
  await db
    .update(billingSubscriptions)
    .set({ status: 'past_due', updatedAt: params.now })
    .where(
      and(
        eq(billingSubscriptions.userId, params.userId),
        eq(billingSubscriptions.provider, params.provider),
      ),
    );
}

/**
 * Подписки, которым пора продлеваться.
 *
 * Берутся те, у кого срок вот-вот кончится, автопродление включено и
 * рельс умеет продлевать сам. Звёзды сюда не попадают: там продлевает
 * Telegram, а мы только получаем уведомление.
 */
export async function dueForRenewal(
  db: Executor,
  params: { readonly provider: Rail; readonly before: Date; readonly limit: number },
): Promise<readonly BillingSubscription[]> {
  return await db
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.provider, params.provider),
        eq(billingSubscriptions.autoRenew, true),
        eq(billingSubscriptions.status, 'active'),
        sql`${billingSubscriptions.currentPeriodEnd} <= ${params.before}`,
      ),
    )
    .orderBy(billingSubscriptions.currentPeriodEnd)
    .limit(params.limit);
}

/** Сколько людей платят прямо сейчас — для обзора в панели (§15). */
export async function activePayersCount(db: Executor, now: Date): Promise<number> {
  const rows = await db
    .selectDistinct({ userId: billingSubscriptions.userId })
    .from(billingSubscriptions)
    .where(gt(billingSubscriptions.currentPeriodEnd, now));

  return rows.length;
}

/**
 * Оборвать оплаченный период сейчас же — только для возврата.
 *
 * Отдельной функцией, а не параметром отмены, нарочно: отмена
 * автопродления доступ **сохраняет** (§14), и перепутать эти два случая
 * значит либо отобрать оплаченное, либо подарить месяц после возврата.
 */
export async function endPeriodNow(
  db: Executor,
  params: { readonly userId: string; readonly provider: Rail; readonly now: Date },
): Promise<void> {
  await db
    .update(billingSubscriptions)
    .set({
      status: 'expired',
      autoRenew: false,
      currentPeriodEnd: params.now,
      updatedAt: params.now,
    })
    .where(
      and(
        eq(billingSubscriptions.userId, params.userId),
        eq(billingSubscriptions.provider, params.provider),
      ),
    );
}
