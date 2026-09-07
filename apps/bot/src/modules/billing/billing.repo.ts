import { and, count, desc, eq, gt, isNotNull, notInArray, sql } from 'drizzle-orm';

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
  /** Код, по которому выставлен счёт (задача 4.4). */
  readonly promoCode?: string | undefined;
  /**
   * Цена без скидки. Ставится всегда, даже когда скидки нет: иначе
   * «сколько недополучено по кодам» пришлось бы считать вычитанием
   * нынешней цены, а она меняется.
   */
  readonly amountFullMinor?: number | undefined;
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
      ...(params.promoCode === undefined ? {} : { promoCode: params.promoCode }),
      ...(params.amountFullMinor === undefined ? {} : { amountFullMinor: params.amountFullMinor }),
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
  params: NewInvoice & {
    readonly renewsPeriodEnd: Date;
    /**
     * Когда заведено — переданными часами, а не базой.
     *
     * По этому времени разбор зависших решает, пора ли спрашивать
     * провайдера об исходе. Ставь его база — и код с проходом жили бы по
     * разным часам: в бою разница незаметна, а в проверке с
     * подставленным временем счёт оказывался старым в момент создания.
     */
    readonly now?: Date | undefined;
  },
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
      ...(params.now === undefined ? {} : { createdAt: params.now }),
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

/**
 * Живой промо-счёт человека, если он уже есть.
 *
 * Промокод даётся на **первый период**, и запрет второго промо-счёта
 * стоит уникальным индексом. Значит повторное нажатие кнопки со скидкой
 * не должно ни падать, ни заводить второй счёт: оно обязано вернуть
 * человека к **той же** ссылке.
 *
 * Неудачные и возвращённые не считаются живыми: периода человек не
 * получил, право на первый период за ним осталось.
 */
export async function livePromoInvoice(
  db: Executor,
  params: { readonly userId: string },
): Promise<BillingInvoice | undefined> {
  const [row] = await db
    .select()
    .from(billingInvoices)
    .where(
      and(
        eq(billingInvoices.userId, params.userId),
        isNotNull(billingInvoices.promoCode),
        notInArray(billingInvoices.status, ['failed', 'refunded']),
      ),
    )
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

/**
 * Пометить счёт возвращённым (задача 4.2, ревизия четвёртого этапа).
 *
 * Отдельным состоянием, а не `failed`: неудача и возврат — разные вещи.
 * Неудача означает «денег не было», возврат — «деньги были и ушли
 * обратно». Первое разбирают как поломку, второе как решение.
 *
 * Из выручки такие счёта исключаются, и из «платил ли хоть раз» тоже:
 * иначе человек, которому вернули деньги, терял бы право на промокод
 * «первый период», не получив периода.
 */
export async function markInvoiceRefunded(
  db: Executor,
  params: { readonly id: string; readonly now: Date },
): Promise<void> {
  await db
    .update(billingInvoices)
    .set({ status: 'refunded', refundedAt: params.now })
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
        /**
         * Отмену снимает **своя** оплата, а не пришедшее продление.
         *
         * Человек отменил автопродление и заплатил снова — значит
         * передумал: отмену снимаем, `canceledAt` очищаем. Оставить её
         * значило бы показывать «подписка отменена» на только что
         * оплаченной подписке.
         *
         * **А продление ничего о его воле не говорит.** Найдено ревизией
         * четвёртого этапа: человек отключает продление, но операция у
         * провайдера уже уехала, и её уведомление приходит через день.
         * Прежде оно включало автопродление обратно — и следующий период
         * списывался **вопреки отмене**, а экран подписки при этом
         * говорил «продлевается сама». Отмена в один тап (§14)
         * превращалась в отмену на один раз.
         *
         * Поэтому у продления автопродление остаётся включённым только
         * если человек не отменял: условие читает **существующую**
         * строку, а не то, что мы принесли.
         */
        autoRenew: params.renewal
          ? sql`${billingSubscriptions.canceledAt} is null`
          : params.autoRenew,
        currentPeriodEnd: params.currentPeriodEnd,
        updatedAt: params.now,
        /**
         * Отметка отмены переживает продление по той же причине: она про
         * его волю, а деньги пришли не от него.
         */
        canceledAt: params.renewal ? sql`${billingSubscriptions.canceledAt}` : null,
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
 *
 * **Ждущие подтверждения исключены, и это находка ревизии.** Прежде их
 * не исключало ничто, и вот что получалось. Списание отправлено
 * (`OK<номер>`), денег на карте не хватило, уведомления не будет —
 * подписка навсегда остаётся `active` с автопродлением и концом периода
 * **в прошлом**. Порядок здесь по возрастанию срока, значит такая строка
 * идёт первой всегда: каждый час она тратит номер из последовательности
 * и упирается в запрет второго списания за тот же период.
 *
 * Пятьдесят таких — и выборка целиком состоит из них: ни одна живая
 * подписка в проходе до списания не доходит, продления прекращаются **у
 * всех платящих сразу**, а в журнал не уходит ни строчки, потому что
 * проход пишет только при удачах и явных отказах.
 *
 * Полусоединением, а не отдельным состоянием: состояние пришлось бы
 * снимать, а забытое снятие — это тот же вечный застой, только тише.
 * Наличие счёта продления на этот период — факт, который не забывается.
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
        sql`not exists (
          select 1 from ${billingInvoices}
          where ${billingInvoices.provider} = ${billingSubscriptions.provider}
            and ${billingInvoices.userId} = ${billingSubscriptions.userId}
            and ${billingInvoices.renewsPeriodEnd} = ${billingSubscriptions.currentPeriodEnd}
        )`,
      ),
    )
    .orderBy(billingSubscriptions.currentPeriodEnd)
    .limit(params.limit);
}

/**
 * Счёта продления, ушедшие и не получившие ответа.
 *
 * Списание создано, а уведомление не пришло: денег не хватило, карта
 * отвалилась, уведомление потерялось. Такой счёт остаётся в состоянии
 * «выставлен» навсегда — то есть не виден ни в выручке, ни в разделе
 * ошибок, — а человек не знает, что доступ кончится.
 *
 * Разбирает это отдельный проход: спросить провайдера и, если денег
 * действительно нет, пометить подписку и предупредить человека **до**
 * конца оплаченного периода.
 */
export async function renewalsAwaitingAnswer(
  db: Executor,
  params: { readonly provider: Rail; readonly olderThan: Date; readonly limit: number },
): Promise<readonly BillingInvoice[]> {
  return await db
    .select()
    .from(billingInvoices)
    .where(
      and(
        eq(billingInvoices.provider, params.provider),
        eq(billingInvoices.kind, 'renewal'),
        eq(billingInvoices.status, 'created'),
        isNotNull(billingInvoices.renewsPeriodEnd),
        isNotNull(billingInvoices.userId),
        sql`${billingInvoices.createdAt} <= ${params.olderThan}`,
      ),
    )
    .orderBy(billingInvoices.createdAt)
    .limit(params.limit);
}

/**
 * Сколько раз человек платил за всю жизнь.
 *
 * Одно определение «первого периода» на всех: и промокод, и воронка
 * отвечают на «платил ли хоть раз» этим запросом. Состояние, а не флаг в
 * профиле: флаг, разойдясь с правдой, не сверяется ни с чем.
 */
export async function paidInvoicesCount(db: Executor, userId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(billingInvoices)
    /**
     * Возвращённые счёта не считаются, и это находка ревизии.
     *
     * Человек, которому вернули деньги, периода не получил — а прежде
     * навсегда числился платившим и терял право на промокод «первый
     * период». Состояние `refunded` отличается от `paid` именно этим.
     */
    .where(and(eq(billingInvoices.userId, userId), eq(billingInvoices.status, 'paid')));

  return row?.total ?? 0;
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
