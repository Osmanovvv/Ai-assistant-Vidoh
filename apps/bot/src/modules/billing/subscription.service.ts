import { and, count, eq, isNull, sql } from 'drizzle-orm';

import { batches, billingSubscriptions } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import type { SettingsRegistry } from '../settings/settings.repo.js';
import {
  endPeriodNow,
  invoiceByRef,
  markEventProcessed,
  markInvoicePaid,
  markPastDue,
  recordEvent,
  stopAutoRenew,
  subscriptionOf,
  subscriptionsOf,
  upsertSubscription,
} from './billing.repo.js';
import type { PaymentEvent } from './provider.js';
import { periodEndAfter, renewFrom, type Rail } from './tariffs.js';

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
 * **Подписка пришла задачей 4.2, и обещание сдержано:** `accessOf`
 * получила второй источник доступа, а всё остальное — гейт, реплика,
 * деградация — осталось как было. Гейт по-прежнему один, в приёме
 * сообщений, и по-прежнему не знает, откуда взялся доступ.
 *
 * **Оплата живёт здесь же, а не рядом.** Пробный период и подписка
 * отвечают на один и тот же вопрос — «можно ли человеку завести
 * выгрузку», — и разводить их по разным службам значило бы, что однажды
 * одна разрешит, а другая нет.
 */

export interface AccessState {
  /** Можно ли заводить новую выгрузку. */
  readonly allowed: boolean;
  /**
   * Чем открыт доступ. Нужно не для красоты: реплика человеку разная,
   * и пробный период не должен тратиться у того, кто уже платит.
   */
  readonly source: 'trial' | 'subscription' | 'none';
  /** До какого времени оплачено, если доступ от подписки. */
  readonly paidUntil?: Date | undefined;
  /** Сколько выгрузок пробного периода уже потрачено. */
  readonly spent: number;
  /** Сколько всего даёт пробный период. */
  readonly limit: number;
  /** Сколько осталось. Ноль — пробный период исчерпан. */
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
  params: {
    readonly userId: string;
    readonly settings: SettingsRegistry;
    readonly now?: Date | undefined;
  },
): Promise<AccessState> {
  const now = params.now ?? new Date();
  const limit = await params.settings.number('trialDumps');
  const spent = await trialSpent(db, params.userId);
  const left = Math.max(0, limit - spent);

  /**
   * **Подписка спрашивается первой, и порядок здесь — смысл.**
   *
   * Человек, который платит, не должен тратить пробный период: иначе,
   * отменив подписку через год, он остался бы вообще без ничего, хотя
   * бесплатными выгрузками не пользовался. Поэтому доступ от подписки
   * не только разрешает выгрузку, но и отменяет отметку о трате
   * (см. `markTrialSpent`).
   *
   * Рельсы складываются по максимуму: у человека может оказаться и
   * подписка за рубли, и подписка за звёзды — тогда действует та, что
   * кончается позже. Обратное («последняя выигрывает») отобрало бы
   * оплаченное у того, кто заплатил дважды.
   */
  const paid = await subscriptionsOf(db, params.userId);

  const paidUntil = paid
    .map((one) => one.currentPeriodEnd)
    .filter((end) => end.getTime() > now.getTime())
    .sort((first, second) => second.getTime() - first.getTime())[0];

  if (paidUntil !== undefined) {
    return { allowed: true, source: 'subscription', paidUntil, spent, limit, left };
  }

  return {
    allowed: spent < limit,
    source: spent < limit ? 'trial' : 'none',
    spent,
    limit,
    left,
  };
}

/**
 * Платит ли человек прямо сейчас.
 *
 * Отдельно от `accessOf`, потому что у неё другой вопрос: та отвечает
 * «пустить ли», а эта — «тратить ли пробный период». Считать одно через
 * другое значило бы тащить реестр настроек туда, где он не нужен.
 */
export async function hasPaidAccess(
  db: Executor,
  params: { readonly userId: string; readonly now?: Date | undefined },
): Promise<boolean> {
  const now = params.now ?? new Date();
  const paid = await subscriptionsOf(db, params.userId);

  return paid.some((one) => one.currentPeriodEnd.getTime() > now.getTime());
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
 * **И только если человек не платит** (задача 4.2). Иначе платящий тратил
 * бы бесплатные выгрузки, которыми не пользовался, и, отменив подписку
 * через год, остался бы вообще без ничего. Проверка стоит внутри условия
 * запроса, а не рядом с ним: между чтением «платит ли» и записью отметки
 * успевает пройти оплата, и тогда отметка встала бы уже платящему.
 *
 * Возвращает `true`, если отметка поставлена именно этим вызовом.
 */
export async function markTrialSpent(
  db: Executor,
  params: { readonly batchId: string; readonly now?: Date | undefined },
): Promise<boolean> {
  const now = params.now ?? new Date();

  const updated = await db
    .update(batches)
    .set({ trialCountedAt: now })
    .where(
      and(
        eq(batches.id, params.batchId),
        isNull(batches.trialCountedAt),
        sql`not exists (
          select 1 from ${billingSubscriptions}
          where ${billingSubscriptions.userId} = ${batches.userId}
            and ${billingSubscriptions.currentPeriodEnd} > ${now}
        )`,
      ),
    )
    .returning({ id: batches.id });

  return updated.length > 0;
}

// ── Оплаченная подписка (§14, задача 4.2) ─────────────────────────────

/**
 * Приложить событие оплаты. Возвращает, что произошло.
 *
 * **Идемпотентность — условие готовности задачи 4.2**, и держится она не
 * здесь, а в базе: `recordEvent` вставляет строку с уникальным ключом
 * «рельс, идентификатор у провайдера, вид». Первая доставка вставилась —
 * обрабатываем; повторная не вставилась — молча отвечаем «уже
 * обработано». Проверять чтением было бы неверно: Робокасса повторяет
 * уведомления, в том числе одновременно, и две параллельные доставки
 * прошли бы обе.
 *
 * **Событие с несошедшейся подписью сюда не попадает** — его отбивает
 * обработчик уведомления, но записывает в журнал (§16): подделка обязана
 * быть видна, а не выглядеть посторонним запросом.
 */
export type AppliedEvent =
  | { readonly kind: 'applied'; readonly paidUntil: Date }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'failed' }
  /** Событие не про нас: метки нет в счетах. */
  | { readonly kind: 'unknown'; readonly why: string };

export async function applyPaymentEvent(
  db: Executor,
  params: {
    readonly provider: Rail;
    readonly event: PaymentEvent;
    readonly method?: string | undefined;
    readonly payload?: unknown;
    /**
     * Сумма строкой, как пришла от провайдера.
     *
     * Хранится сырой, потому что подпись считается по строке: в бою
     * Робокасса присылает шесть знаков после точки, в тесте два, и
     * воспроизвести подпись по числу потом невозможно.
     */
    readonly outSum?: string | undefined;
    readonly now?: Date | undefined;
  },
): Promise<AppliedEvent> {
  const now = params.now ?? new Date();
  const event = params.event;

  const invoice = await invoiceByRef(db, { provider: params.provider, ref: event.ref });

  if (invoice === undefined) {
    return { kind: 'unknown', why: `метки ${event.ref} нет ни в одном счёте` };
  }

  if (invoice.userId === null) {
    // Человек удалил данные, а событие пришло. Платёж записан, доступ
    // возвращать некому: подписка ушла каскадом вместе с ним.
    return { kind: 'unknown', why: 'счёт обезличен: человек удалил данные' };
  }

  /**
   * Ключ идемпотентности берётся у провайдера, а где его нет — у метки.
   *
   * У денежных событий это идентификатор платежа: он уникален и у
   * продлений тоже. У «человек отключил продление» такого ключа нет и не
   * нужно: выставить признак дважды — то же, что один раз.
   */
  const externalId = 'externalId' in event ? event.externalId : `${event.kind}:${event.ref}`;

  const noted = await recordEvent(db, {
    provider: params.provider,
    externalId,
    kind: event.kind,
    signatureOk: true,
    payload: params.payload ?? {},
    ...(params.method === undefined ? {} : { method: params.method }),
    invoiceId: invoice.id,
  });

  if (!noted.first) return { kind: 'duplicate' };

  const finish = async (): Promise<void> => {
    if (noted.id !== undefined) await markEventProcessed(db, noted.id, now);
  };

  if (event.kind === 'renewalStopped') {
    await stopAutoRenew(db, { userId: invoice.userId, provider: params.provider, now });
    await finish();

    return { kind: 'stopped' };
  }

  if (event.kind === 'renewalFailed') {
    /**
     * Доступ не закрывается здесь.
     *
     * Продление не прошло — значит деньги не списались, но оплаченный
     * период ещё идёт: §14 велит держать доступ до его конца. Закрыть
     * сегодня значило бы отобрать оплаченное.
     */
    await markPastDue(db, { userId: invoice.userId, provider: params.provider, now });
    await finish();

    return { kind: 'failed' };
  }

  if (event.kind === 'refunded') {
    /**
     * Возврат обрывает оплаченный период немедленно.
     *
     * Деньги вернулись — значит услуга не оплачена. Оставить доступ до
     * конца периода значило бы отдать месяц бесплатно, и это не то же
     * самое, что отмена автопродления: там человек **заплатил** и вправе
     * дожить период.
     */
    await stopAutoRenew(db, { userId: invoice.userId, provider: params.provider, now });
    await endPeriodNow(db, { userId: invoice.userId, provider: params.provider, now });
    await finish();

    return { kind: 'stopped' };
  }

  // Осталось `paid` — первый платёж или продление.
  const subscription = await subscriptionOf(db, {
    userId: invoice.userId,
    provider: params.provider,
  });

  /**
   * Срок считается от конца оплаченного, а не от «сейчас».
   *
   * Иначе продление, пришедшее на день позже (а оно придёт позже:
   * списание не мгновенно), съедало бы у человека день каждый месяц.
   * Просроченное продление, наоборот, считается от «сейчас» — дарить
   * время задним числом не за что.
   *
   * Если провайдер сам сказал, до какого срока оплачено, верим ему:
   * у звёзд это `subscription_expiration_date`, и спорить с Telegram о
   * его же подписке бессмысленно.
   */
  const from = subscription === undefined ? now : renewFrom(subscription.currentPeriodEnd, now);
  const paidUntil = event.paidUntil ?? periodEndAfter(from, invoice.plan);

  /**
   * Фактический номер счёта берётся из идентификатора платежа.
   *
   * У Робокассы это и есть пришедший `InvId` — тот, по которому потом
   * пойдёт продление. У звёзд идентификатор не числовой, и номера тут
   * нет вовсе; поле останется пустым, и это верно.
   */
  const providerInvId = /^\d+$/u.test(externalId) ? Number(externalId) : undefined;

  await markInvoicePaid(db, {
    id: invoice.id,
    ...(providerInvId === undefined || !Number.isSafeInteger(providerInvId)
      ? {}
      : { providerInvId }),
    ...(params.outSum === undefined ? {} : { outSumReceived: params.outSum }),
    now,
  });

  await upsertSubscription(db, {
    userId: invoice.userId,
    provider: params.provider,
    plan: invoice.plan,
    currentPeriodEnd: paidUntil,
    ...(event.subscriptionRef === undefined ? {} : { subscriptionRef: event.subscriptionRef }),
    /**
     * Автопродление берётся с счёта, а не угадывается по тарифу.
     *
     * Прежде здесь стояло `plan === 'monthly'`, и это была догадка,
     * неверная на **обоих** рельсах: у звёзд годовой тариф продлеваться не
     * умеет вовсе (`subscription_period` в Bot API обязан быть тридцатью
     * днями), а у Робокассы даже месячное продление работает лишь после
     * согласования услуги. Пометь мы подписку продлеваемой без обещания —
     * человек ждал бы автосписания, которого не будет, а суточный
     * работник каждый день ходил бы списывать несписуемое.
     *
     * Пришедшее продление — доказательство сильнее любой записи: если
     * деньги списались сами, продление работает.
     */
    autoRenew: event.renewal ? true : (invoice.autoRenew ?? false),
    renewal: event.renewal,
    now,
  });

  await finish();

  return { kind: 'applied', paidUntil };
}

/**
 * Отменить автопродление — §14 «в один тап».
 *
 * Доступ не трогается: §14 требует сохранить его до конца оплаченного
 * периода. Провайдеру говорит вызывающий — у него есть `subscriptionRef`
 * и клиент; здесь только наша память.
 */
export async function cancelRenewal(
  db: Executor,
  params: { readonly userId: string; readonly provider: Rail; readonly now?: Date | undefined },
): Promise<{ readonly stopped: boolean; readonly paidUntil: Date | undefined }> {
  const now = params.now ?? new Date();
  const before = await subscriptionOf(db, { userId: params.userId, provider: params.provider });

  const stopped = await stopAutoRenew(db, {
    userId: params.userId,
    provider: params.provider,
    now,
  });

  return { stopped, paidUntil: before?.currentPeriodEnd };
}
