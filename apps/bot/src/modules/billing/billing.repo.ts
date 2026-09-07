import { and, desc, eq, gt, isNotNull, sql } from 'drizzle-orm';

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
  /**
   * Обещано ли автопродление. Продлению известно сразу — оно наследует
   * обещание материнского платежа; первому платежу это скажет провайдер,
   * и потому там оно ставится вторым шагом, через `noteAutoRenew`.
   */
  readonly autoRenew?: boolean | undefined;
  /**
   * Конец периода, который оплачивает это продление.
   *
   * Он же ключ запрета второго списания: уникальный индекс по тройке
   * «рельс, человек, этот срок» не даст завести второе продление за тот
   * же период — ни второму процессу, ни повторному проходу после
   * перезапуска.
   */
  readonly renewsPeriodEnd?: Date | undefined;
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
      ...(params.autoRenew === undefined ? {} : { autoRenew: params.autoRenew }),
      ...(params.renewsPeriodEnd === undefined ? {} : { renewsPeriodEnd: params.renewsPeriodEnd }),
    })
    .returning();

  if (row === undefined) throw new Error('Счёт не создался');

  return row;
}

/**
 * Завести счёт на продление — или узнать, что он уже есть.
 *
 * Ключ здесь не наш и не в памяти: уникальный индекс по тройке «рельс,
 * человек, конец продлеваемого периода». Второй проход, второй процесс и
 * перезапуск в середине — все трое получают `undefined` и не списывают
 * деньги во второй раз.
 *
 * `onConflictDoNothing` вместо чтения нарочно: проверить чтением значило
 * бы оставить щель между проверкой и вставкой, а два прохода планировщика
 * попадают в неё легко.
 */
export async function claimRenewal(
  db: Executor,
  params: NewInvoice & { readonly renewsPeriodEnd: Date },
): Promise<BillingInvoice | undefined> {
  const [row] = await db
    .insert(billingInvoices)
    .values({
      provider: params.provider,
      userId: params.userId,
      plan: params.plan,
      kind: 'renewal',
      amountMinor: params.amountMinor,
      currency: params.currency,
      ref: params.ref,
      renewsPeriodEnd: params.renewsPeriodEnd,
      autoRenew: true,
      ...(params.invId === undefined ? {} : { invId: params.invId }),
      ...(params.parentInvId === undefined ? {} : { parentInvId: params.parentInvId }),
      ...(params.outSumSent === undefined ? {} : { outSumSent: params.outSumSent }),
    })
    /**
     * Условие повторяет условие индекса — иначе Postgres его не найдёт.
     *
     * Индекс частичный (у первых платежей срок пуст), а `on conflict` по
     * частичному индексу требует того же `where`. Без него запрос падает
     * 42P10 «нет подходящего ограничения» — и падает **на каждом**
     * продлении, а не иногда.
     */
    .onConflictDoNothing({
      target: [billingInvoices.provider, billingInvoices.userId, billingInvoices.renewsPeriodEnd],
      where: sql`${billingInvoices.renewsPeriodEnd} is not null`,
    })
    .returning();

  return row;
}

/**
 * Записать на счёт обещание провайдера про автопродление.
 *
 * Отдельным шагом, а не полем при создании, потому что порядок обратный:
 * счёт заводится **до** обращения к провайдеру (иначе быстрая оплата
 * пришла бы раньше строки в базе), а правду про продление провайдер
 * говорит уже в ответе.
 *
 * Не успей этот шаг — счёт останется без обещания, и оплата даст доступ
 * без автопродления. Направление отказа выбрано так нарочно: не продлить
 * обещанное дешевле, чем списать необещанное.
 */
export async function noteAutoRenew(
  db: Executor,
  params: { readonly id: string; readonly autoRenew: boolean },
): Promise<void> {
  await db
    .update(billingInvoices)
    .set({ autoRenew: params.autoRenew })
    .where(eq(billingInvoices.id, params.id));
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

/**
 * Материнский платёж для продления: последний оплаченный с **фактическим**
 * номером.
 *
 * Фактическим, а не нашим: в документации Робокассы расходятся имена
 * поля номера (`InvId` против `InvoiceID`), а неизвестное поле она
 * игнорирует и назначает номер сама. Продлевать по нашему номеру значило
 * бы однажды отправить все продления в пустоту.
 */
export async function parentPaymentFor(
  db: Executor,
  params: { readonly provider: Rail; readonly userId: string },
): Promise<BillingInvoice | undefined> {
  const [row] = await db
    .select()
    .from(billingInvoices)
    .where(
      and(
        eq(billingInvoices.provider, params.provider),
        eq(billingInvoices.userId, params.userId),
        eq(billingInvoices.status, 'paid'),
        isNotNull(billingInvoices.providerInvId),
      ),
    )
    .orderBy(desc(billingInvoices.paidAt))
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
    /**
     * Пришедшая сумма строкой — при недоплате её надо сохранить.
     *
     * Разбирать «сколько же он заплатил» по журналу провайдера, когда у
     * счёта пусто, значило бы идти за ответом в чужую систему.
     */
    readonly outSumReceived?: string | undefined;
  },
): Promise<void> {
  await db
    .update(billingInvoices)
    .set({
      status: 'failed',
      ...(params.errorCode === undefined ? {} : { errorCode: params.errorCode }),
      ...(params.errorText === undefined ? {} : { errorText: params.errorText }),
      ...(params.outSumReceived === undefined ? {} : { outSumReceived: params.outSumReceived }),
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
