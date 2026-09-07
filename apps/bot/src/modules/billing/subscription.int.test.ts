import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  appSettings,
  batches,
  billingEvents,
  billingInvoices,
  billingSubscriptions,
  users,
} from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { putSetting, SettingsRegistry } from '../settings/settings.repo.js';
import { upsertUser } from '../users/users.repo.js';
import {
  createInvoice,
  invoiceByRef,
  nextInvId,
  paidInvoicesCount,
  subscriptionOf,
} from './billing.repo.js';
import type { PaymentEvent, PaymentProvider } from './provider.js';
import {
  accessOf,
  applyPaymentEvent,
  cancelRenewal,
  markTrialSpent,
  stopAllRenewals,
  trialSpent,
} from './subscription.service.js';
import { periodEndAfter, priceOf, renewFrom, tariffsOf } from './tariffs.js';

/**
 * Подписка и оплата (§14 ТЗ, задача 4.2).
 *
 * **Условие готовности названо одной строкой: «повторная доставка события
 * оплаты не создаёт второй платёж».** Поэтому главная проверка здесь не
 * «оплата работает», а «оплата, пришедшая дважды, работает один раз» — и
 * отдельно та же проверка на одновременную доставку: Робокасса повторяет
 * уведомления, и чтение перед вставкой такую гонку пропускает.
 *
 * Провайдер здесь не участвует вовсе: событие уже приведено к нашему
 * виду. Так и задумано — разбор формата и проверка подписи живут в
 * провайдере, а эта служба отвечает за смысл: кому продлить, до какого
 * числа и что сделать с доступом.
 */

const RAIL = 'robokassa:smz';

let userId = '';
let settings: SettingsRegistry;

/**
 * Счёт, по метке которого потом придёт событие.
 *
 * `autoRenew` задаётся здесь, а не угадывается по тарифу: обещание
 * продления знает только провайдер, и знает он его при выставлении
 * счёта. По умолчанию `true` — так выглядит счёт с рельса, где продление
 * согласовано; случаи без обещания зовут с `autoRenew: false`.
 */
async function invoiceFor(params: {
  readonly plan: 'monthly' | 'yearly';
  readonly kind: 'initial' | 'renewal';
  readonly ref: string;
  readonly amountMinor?: number;
  readonly autoRenew?: boolean;
}): Promise<void> {
  await createInvoice(testDb(), {
    provider: RAIL,
    userId,
    plan: params.plan,
    kind: params.kind,
    amountMinor: params.amountMinor ?? 39_900,
    currency: 'RUB',
    ref: params.ref,
    invId: await nextInvId(testDb()),
    autoRenew: params.autoRenew ?? true,
  });
}

/**
 * Событие оплаты. Тип узкий — именно `paid`, а не весь союз.
 *
 * Иначе `{ ...paid(…), amount: 1 }` в проверках на недоплату не
 * складывается: у «человек отписался» суммы нет вовсе, и союз это
 * справедливо запрещает.
 */
function paid(params: {
  readonly ref: string;
  readonly externalId: string;
  readonly renewal?: boolean;
}): Extract<PaymentEvent, { kind: 'paid' }> {
  return {
    kind: 'paid',
    externalId: params.externalId,
    ref: params.ref,
    amount: 39_900,
    currency: 'RUB',
    renewal: params.renewal ?? false,
  };
}

beforeEach(async () => {
  await testDb().delete(billingEvents);
  await testDb().delete(billingSubscriptions);
  await testDb().delete(billingInvoices);
  await testDb().delete(batches);
  await testDb().delete(appSettings);
  await testDb().delete(users);

  const person = await upsertUser(testDb(), { tgId: 4_200_001, firstName: 'Аня' });
  userId = person.id;

  settings = new SettingsRegistry({ db: testDb(), ttlMs: 0 });
});

describe('повторная доставка — условие готовности 4.2', () => {
  it('второе такое же событие не продлевает подписку дважды', async () => {
    /**
     * **Главная проверка задачи, дословно по условию готовности.**
     *
     * Робокасса повторяет уведомления, если не получила ответа, — и
     * ответ она могла не получить уже после того, как мы всё сделали.
     * Второе продление означало бы, что человек получил два месяца за
     * один платёж, а мы узнали бы об этом от бухгалтера.
     */
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'r-1' });

    const event = paid({ ref: 'r-1', externalId: '1001' });
    const now = new Date('2026-09-07T10:00:00.000Z');

    const first = await applyPaymentEvent(testDb(), { provider: RAIL, event, now });
    const second = await applyPaymentEvent(testDb(), { provider: RAIL, event, now });

    expect(first.kind).toBe('applied');
    expect(second.kind).toBe('duplicate');

    const subscription = await subscriptionOf(testDb(), { userId, provider: RAIL });

    // Ровно один месяц, а не два.
    expect(subscription?.currentPeriodEnd.toISOString()).toBe('2026-10-07T10:00:00.000Z');
  });

  it('и одновременная доставка тоже даёт одно продление', async () => {
    /**
     * Ровно то, что проверка чтением пропускает: «посмотрели — не было —
     * вставили» у двух запросов сходится в одно и то же «не было».
     * Держит это уникальный индекс, и вот доказательство.
     */
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'r-2' });

    const event = paid({ ref: 'r-2', externalId: '1002' });
    const now = new Date('2026-09-07T10:00:00.000Z');

    const outcomes = await Promise.all([
      applyPaymentEvent(testDb(), { provider: RAIL, event, now }),
      applyPaymentEvent(testDb(), { provider: RAIL, event, now }),
      applyPaymentEvent(testDb(), { provider: RAIL, event, now }),
    ]);

    expect(outcomes.filter((one) => one.kind === 'applied')).toHaveLength(1);
    expect(outcomes.filter((one) => one.kind === 'duplicate')).toHaveLength(2);

    expect(await testDb().select().from(billingEvents)).toHaveLength(1);
  });

  it('разные платежи одного человека обрабатываются оба', async () => {
    // Иначе идемпотентность съела бы продление: у него другой платёж, но
    // тот же человек и тот же тариф.
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'r-3' });
    await invoiceFor({ plan: 'monthly', kind: 'renewal', ref: 'r-4' });

    const first = await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'r-3', externalId: '1003' }),
      now: new Date('2026-09-07T10:00:00.000Z'),
    });

    const second = await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'r-4', externalId: '1004', renewal: true }),
      now: new Date('2026-10-07T10:05:00.000Z'),
    });

    expect(first.kind).toBe('applied');
    expect(second.kind).toBe('applied');

    const subscription = await subscriptionOf(testDb(), { userId, provider: RAIL });
    expect(subscription?.currentPeriodEnd.toISOString()).toBe('2026-11-07T10:00:00.000Z');
  });

  it('событие с неизвестной меткой не создаёт подписку из ничего', async () => {
    const outcome = await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'такого-счёта-нет', externalId: '9999' }),
    });

    expect(outcome.kind).toBe('unknown');
    expect(await testDb().select().from(billingSubscriptions)).toHaveLength(0);
  });
});

describe('срок оплаченного периода', () => {
  it('продление считается от конца периода, а не от «сейчас»', async () => {
    /**
     * Списание не мгновенно: продление приходит на день-два позже. Считай
     * мы от «сейчас», человек терял бы по дню каждый месяц — двенадцать
     * дней в год, которые он оплатил.
     */
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'p-1' });
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'p-1', externalId: '2001' }),
      now: new Date('2026-09-07T10:00:00.000Z'),
    });

    await invoiceFor({ plan: 'monthly', kind: 'renewal', ref: 'p-2' });
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'p-2', externalId: '2002', renewal: true }),
      // Продление пришло на два дня позже конца периода.
      now: new Date('2026-10-09T03:00:00.000Z'),
    });

    const subscription = await subscriptionOf(testDb(), { userId, provider: RAIL });

    // Не 9 ноября: месяц прибавлен к концу оплаченного, а не к «сейчас».
    expect(subscription?.currentPeriodEnd.toISOString()).toBe('2026-11-07T10:00:00.000Z');
  });

  it('а сильно просроченное продление — от «сейчас»', () => {
    /**
     * Иначе оплата после месяца простоя дарила бы время задним числом:
     * человек заплатил бы и получил период, кончившийся в прошлом.
     *
     * Порог — неделя: внутрь недели укладываются задержка списания и
     * повторы, всё дольше — уже не опоздание, а простой.
     */
    const end = new Date('2026-09-07T10:00:00.000Z');

    // Полтора месяца простоя — считаем от «сейчас».
    const late = new Date('2026-11-01T10:00:00.000Z');
    expect(renewFrom(end, late).toISOString()).toBe(late.toISOString());

    // А два дня опоздания — от конца периода: их человек оплатил.
    const slightly = new Date('2026-09-09T03:00:00.000Z');
    expect(renewFrom(end, slightly).toISOString()).toBe(end.toISOString());

    // И ровно на границе недели — ещё опоздание, а не простой.
    const edge = new Date(end.getTime() + 7 * 24 * 60 * 60_000);
    expect(renewFrom(end, edge).toISOString()).toBe(end.toISOString());
  });

  it('месяц календарный, а не тридцать дней', () => {
    /**
     * Тридцать дней дают тринадцать списаний в год вместо двенадцати, и
     * замечают это по счёту, а не по нашему коду.
     */
    expect(periodEndAfter(new Date('2026-01-15T00:00:00.000Z'), 'monthly').toISOString()).toBe(
      '2026-02-15T00:00:00.000Z',
    );

    expect(periodEndAfter(new Date('2026-01-15T00:00:00.000Z'), 'yearly').toISOString()).toBe(
      '2027-01-15T00:00:00.000Z',
    );
  });

  it('31 января плюс месяц — 28 февраля, а не 3 марта', () => {
    /**
     * `Date` в JavaScript сам перекидывает лишние дни вперёд, и без
     * обрезки человек, заплативший 31-го, получал бы списание третьего
     * числа следующего месяца — с каждым разом всё позже.
     */
    expect(periodEndAfter(new Date('2026-01-31T12:00:00.000Z'), 'monthly').toISOString()).toBe(
      '2026-02-28T12:00:00.000Z',
    );
  });

  it('срок от провайдера главнее нашего расчёта', async () => {
    // У звёзд Telegram сам говорит, до какого числа оплачено, и спорить
    // с ним о его же подписке бессмысленно.
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'p-3' });

    const until = new Date('2026-12-01T00:00:00.000Z');

    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: {
        kind: 'paid',
        externalId: '2003',
        ref: 'p-3',
        amount: 39_900,
        currency: 'RUB',
        renewal: false,
        paidUntil: until,
      },
      now: new Date('2026-09-07T10:00:00.000Z'),
    });

    const subscription = await subscriptionOf(testDb(), { userId, provider: RAIL });
    expect(subscription?.currentPeriodEnd.toISOString()).toBe(until.toISOString());
  });
});

describe('отмена автопродления — §14 «в один тап»', () => {
  it('доступ сохраняется до конца оплаченного периода', async () => {
    /**
     * §14 дословно: «Отключение автосписания в один тап, доступ
     * сохраняется до конца оплаченного периода». Закрыть доступ в день
     * отмены значило бы отобрать оплаченное.
     */
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'c-1' });
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'c-1', externalId: '3001' }),
      now: new Date('2026-09-07T10:00:00.000Z'),
    });

    const canceled = await cancelRenewal(testDb(), {
      userId,
      provider: RAIL,
      now: new Date('2026-09-10T10:00:00.000Z'),
    });

    expect(canceled.stopped).toBe(true);

    const subscription = await subscriptionOf(testDb(), { userId, provider: RAIL });
    expect(subscription?.autoRenew).toBe(false);
    // Срок не тронут.
    expect(subscription?.currentPeriodEnd.toISOString()).toBe('2026-10-07T10:00:00.000Z');

    // И доступ ещё есть.
    const access = await accessOf(testDb(), {
      userId,
      settings,
      now: new Date('2026-09-20T10:00:00.000Z'),
    });

    expect(access.allowed).toBe(true);
    expect(access.source).toBe('subscription');
  });

  it('а после конца периода доступа уже нет', async () => {
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'c-2' });
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'c-2', externalId: '3002' }),
      now: new Date('2026-09-07T10:00:00.000Z'),
    });

    await cancelRenewal(testDb(), { userId, provider: RAIL });

    // Пробный период при этом не тратился: человек платил.
    const access = await accessOf(testDb(), {
      userId,
      settings,
      now: new Date('2026-11-01T10:00:00.000Z'),
    });

    expect(access.source).toBe('trial');
    expect(access.allowed).toBe(true);
  });

  it('месячный тариф без обещания продления автопродления НЕ включает', async () => {
    /**
     * **Главная проверка этого раздела.** Прежде автопродление
     * выводилось из тарифа: `plan === 'monthly'`. Догадка неверна на
     * обоих рельсах — у звёзд годовой тариф продлеваться не умеет вовсе,
     * а у Робокассы даже месячное продление работает лишь после
     * согласования услуги. Подписка помечалась продлеваемой, продление
     * не приходило, а суточный проход каждый день ходил бы списывать
     * несписуемое.
     *
     * Правду знает провайдер и говорит её при выставлении счёта. Здесь
     * счёт без обещания — и подписка обязана это сохранить.
     */
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'c-9', autoRenew: false });
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'c-9', externalId: '3009' }),
    });

    const subscription = await subscriptionOf(testDb(), { userId, provider: RAIL });

    expect(subscription?.autoRenew).toBe(false);
    // Доступ при этом полный: человек заплатил за период.
    expect(subscription?.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
  });

  it('пришедшее продление включает автопродление даже без обещания', async () => {
    /**
     * Списавшиеся деньги — доказательство сильнее любой записи. Если
     * продление пришло, оно работает, что бы ни было обещано при первом
     * платеже: так бывает, когда услугу согласовали уже после оплаты.
     */
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'c-10', autoRenew: false });
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'c-10', externalId: '3010', renewal: true }),
    });

    expect((await subscriptionOf(testDb(), { userId, provider: RAIL }))?.autoRenew).toBe(true);
  });

  it('фактический номер платежа сохраняется — по нему пойдёт продление', async () => {
    /**
     * Проверка на опечатку, которая ничего не ломала громко: регулярка
     * распознавания номера была написана как `/^d+$/` вместо `/^\d+$/` и
     * ловила строку из букв «d», а не цифры. Номер не сохранялся никогда,
     * а продлевать без него нечем: в `PreviousInvoiceID` пришлось бы
     * подставить наш номер, и Робокасса ответила бы ошибкой 40.
     */
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'c-11' });
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'c-11', externalId: '4242' }),
    });

    const invoice = await invoiceByRef(testDb(), { provider: RAIL, ref: 'c-11' });

    expect(invoice?.providerInvId).toBe(4242);
  });

  it('нечисловой идентификатор платежа в номер счёта не превращается', async () => {
    // У звёзд идентификатор не числовой. Записать его как номер значило
    // бы отправить продление по выдуманному номеру.
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'c-12' });
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'c-12', externalId: 'charge_abc' }),
    });

    expect(
      (await invoiceByRef(testDb(), { provider: RAIL, ref: 'c-12' }))?.providerInvId,
    ).toBeNull();
  });

  it('оплата меньше счёта доступа НЕ даёт', async () => {
    /**
     * **Подпись не про сумму, а про целостность.** Она подтверждает, что
     * уведомление от Робокассы, а не то, что заплачено столько, сколько
     * мы просили: `OutSum` — сумма, зачисленная магазину, и она может
     * отличаться от запрошенной (конвертация валюты, изменение суммы в
     * кабинете, частичная оплата).
     *
     * Без этой сверки платёж на рубль по счёту на 399 давал бы полный
     * месяц, и заметить это было бы нечем: событие прошло, подписка
     * продлилась, в журнале успех.
     */
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'мало' });

    const outcome = await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: { ...paid({ ref: 'мало', externalId: '3100' }), amount: 100 },
    });

    expect(outcome.kind).toBe('underpaid');
    expect(await subscriptionOf(testDb(), { userId, provider: RAIL })).toBeUndefined();

    // Счёт помечен неудачным, и видно, сколько же пришло.
    const invoice = await invoiceByRef(testDb(), { provider: RAIL, ref: 'мало' });

    expect(invoice?.status).toBe('failed');
    expect(invoice?.errorText).toContain('100');
  });

  it('переплату у человека не отбирают', async () => {
    // Доступ он получил, и отказывать из-за лишних копеек значило бы
    // взять деньги и не дать услугу.
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'много' });

    const outcome = await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: { ...paid({ ref: 'много', externalId: '3101' }), amount: 50_000 },
    });

    expect(outcome.kind).toBe('applied');
  });

  it('чужая валюта на ту же сумму доступа не даёт', async () => {
    // 150 звёзд по рублёвому счёту — это не 150 рублей.
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'валюта' });

    const outcome = await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: { ...paid({ ref: 'валюта', externalId: '3102' }), currency: 'XTR' },
    });

    expect(outcome.kind).toBe('underpaid');
  });

  it('недоплата остаётся видна в журнале событий', async () => {
    // Деньги пришли, услуга не выдана — разбирать это должен человек, а
    // не следующий платёж. Молчаливый отказ означал бы, что разбирать
    // нечем.
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'журнал' });

    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: { ...paid({ ref: 'журнал', externalId: '3103' }), amount: 1 },
    });

    const events = await testDb().select().from(billingEvents);

    expect(events).toHaveLength(1);
    expect(events[0]?.externalId).toBe('3103');
  });

  it('повторная доставка недоплаты не превращается в оплату', async () => {
    // Идемпотентность обязана работать и на отказе: иначе повтор того же
    // уведомления однажды прошёл бы по другой ветке.
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'повтор-мало' });

    const event = { ...paid({ ref: 'повтор-мало', externalId: '3104' }), amount: 1 };

    expect((await applyPaymentEvent(testDb(), { provider: RAIL, event })).kind).toBe('underpaid');
    expect((await applyPaymentEvent(testDb(), { provider: RAIL, event })).kind).toBe('duplicate');

    expect(await subscriptionOf(testDb(), { userId, provider: RAIL })).toBeUndefined();
  });

  it('продление оплаченного счёта заводит НОВУЮ строку, а не правит старую', async () => {
    /**
     * **Так устроены звёзды**: Telegram присылает продление с тем же
     * `invoice_payload`, и счёт по метке находится тот же — оплаченный
     * месяц назад. Пометь мы его оплаченным снова, `paid_at` уехал бы на
     * новую дату, уничтожив дату первого платежа, а выручка за три
     * месяца показала бы **один** платёж вместо трёх.
     *
     * Отказ был бы полностью молчаливым: подписка продлевается, доступ
     * есть, в журнале успех — и только отчёт о выручке занижен на всё,
     * кроме последнего периода.
     */
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'звёздная' });

    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'звёздная', externalId: 'charge-1' }),
      now: new Date('2026-09-07T10:00:00.000Z'),
    });

    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'звёздная', externalId: 'charge-2', renewal: true }),
      now: new Date('2026-10-07T10:00:00.000Z'),
    });

    const rows = await testDb()
      .select()
      .from(billingInvoices)
      .where(eq(billingInvoices.ref, 'звёздная'));

    expect(rows).toHaveLength(2);
    expect(rows.filter((one) => one.status === 'paid')).toHaveLength(2);

    // Дата первого платежа цела — по ней считается выручка того месяца.
    const dates = rows
      .map((one) => one.paidAt?.toISOString())
      .sort((first, second) => (first ?? '').localeCompare(second ?? ''));

    expect(dates).toEqual(['2026-09-07T10:00:00.000Z', '2026-10-07T10:00:00.000Z']);

    // Второй счёт — продление, и скидка на него не переносится.
    const renewal = rows.find((one) => one.kind === 'renewal');

    expect(renewal).toBeDefined();
    expect(renewal?.promoCode).toBeNull();
    expect(renewal?.amountFullMinor).toBeNull();
  });

  it('следующее продление находит свежий счёт, а не первый', async () => {
    // Иначе третий месяц снова правил бы первую строку, и разошлось бы
    // всё то же самое, только на шаг позже.
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'трижды' });

    for (const [index, charge] of ['c-1', 'c-2', 'c-3'].entries()) {
      await applyPaymentEvent(testDb(), {
        provider: RAIL,
        event: paid({ ref: 'трижды', externalId: charge, renewal: index > 0 }),
        now: new Date(Date.UTC(2026, 8 + index, 7, 10)),
      });
    }

    const rows = await testDb()
      .select()
      .from(billingInvoices)
      .where(eq(billingInvoices.ref, 'трижды'));

    expect(rows).toHaveLength(3);
  });

  it('продление неоплаченного счёта новой строки не заводит', async () => {
    /**
     * Так приходит Робокасса: продление у неё уже имеет свой счёт со
     * своей меткой, заведённый суточным проходом и ещё не оплаченный.
     * Завести рядом второй значило бы удвоить выручку на рублёвом
     * рельсе — ошибка, обратная звёздной.
     */
    await invoiceFor({ plan: 'monthly', kind: 'renewal', ref: 'рублёвое' });

    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'рублёвое', externalId: '7001', renewal: true }),
    });

    const rows = await testDb()
      .select()
      .from(billingInvoices)
      .where(eq(billingInvoices.ref, 'рублёвое'));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('paid');
  });

  it('повторная отмена не ломается и говорит правду', async () => {
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'c-3' });
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'c-3', externalId: '3003' }),
    });

    expect((await cancelRenewal(testDb(), { userId, provider: RAIL })).stopped).toBe(true);
    // Второй раз отменять нечего — и это не ошибка.
    expect((await cancelRenewal(testDb(), { userId, provider: RAIL })).stopped).toBe(false);
  });

  it('продление, уехавшее до отмены, НЕ включает автосписание обратно', async () => {
    /**
     * **Главная проверка отмены.** Человек нажимает «отключить
     * продление», но операция у провайдера уже уехала, и её уведомление
     * приходит через день. Прежде оно включало автопродление обратно — и
     * следующий период списывался вопреки отмене, а экран подписки при
     * этом говорил «продлевается сама».
     *
     * Отмена в один тап (§14) превращалась в отмену на один раз.
     */
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'c-20' });
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'c-20', externalId: '3020' }),
      now: new Date('2026-09-07T10:00:00.000Z'),
    });

    await cancelRenewal(testDb(), {
      userId,
      provider: RAIL,
      now: new Date('2026-09-08T10:00:00.000Z'),
    });

    // Уведомление о продлении приходит уже после отмены.
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'c-20', externalId: '3021', renewal: true }),
      now: new Date('2026-09-09T10:00:00.000Z'),
    });

    const subscription = await subscriptionOf(testDb(), { userId, provider: RAIL });

    // Деньги пришли — период продлён: человек заплатил, пусть и не по
    // своей воле, и отбирать оплаченное нельзя.
    expect(subscription?.currentPeriodEnd.getTime()).toBeGreaterThan(
      new Date('2026-10-07T10:00:00.000Z').getTime(),
    );

    // А вот продление остаётся выключенным, и отметка отмены цела.
    expect(subscription?.autoRenew).toBe(false);
    expect(subscription?.canceledAt).not.toBeNull();
  });

  it('оплата после отмены снимает пометку «отменено»', async () => {
    // Человек передумал. Показывать ему «подписка отменена» на только что
    // оплаченной подписке было бы неправдой.
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'c-4' });
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'c-4', externalId: '3004' }),
    });
    await cancelRenewal(testDb(), { userId, provider: RAIL });

    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'c-5' });
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'c-5', externalId: '3005' }),
    });

    const subscription = await subscriptionOf(testDb(), { userId, provider: RAIL });

    expect(subscription?.autoRenew).toBe(true);
    expect(subscription?.canceledAt).toBeNull();
  });
});

describe('что делать с неудачей и возвратом', () => {
  it('неудачное продление не закрывает оплаченный доступ', async () => {
    /**
     * Деньги не списались, но оплаченный период ещё идёт. Закрыть его
     * сегодня значило бы отобрать оплаченное за то, что у человека
     * кончились деньги на карте.
     */
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'f-1' });
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'f-1', externalId: '4001' }),
      now: new Date('2026-09-07T10:00:00.000Z'),
    });

    await invoiceFor({ plan: 'monthly', kind: 'renewal', ref: 'f-2' });
    const outcome = await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: { kind: 'renewalFailed', ref: 'f-2' },
      now: new Date('2026-10-07T10:00:00.000Z'),
    });

    expect(outcome.kind).toBe('failed');

    const subscription = await subscriptionOf(testDb(), { userId, provider: RAIL });
    expect(subscription?.status).toBe('past_due');
    expect(subscription?.currentPeriodEnd.toISOString()).toBe('2026-10-07T10:00:00.000Z');
  });

  it('возврат обрывает период сразу, в отличие от отмены', async () => {
    /**
     * Разница принципиальная. При отмене человек **заплатил** и вправе
     * дожить период; при возврате деньги вернулись, и месяц бесплатно
     * отдавать не за что.
     */
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'f-3' });
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'f-3', externalId: '4003' }),
      now: new Date('2026-09-07T10:00:00.000Z'),
    });

    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: {
        kind: 'refunded',
        externalId: '4003',
        ref: 'f-3',
        amount: 39_900,
        currency: 'RUB',
      },
      now: new Date('2026-09-08T10:00:00.000Z'),
    });

    const access = await accessOf(testDb(), {
      userId,
      settings,
      now: new Date('2026-09-09T10:00:00.000Z'),
    });

    expect(access.source).not.toBe('subscription');
  });

  it('«человек отключил продление сам» доходит до нашей таблицы', async () => {
    // У Stars человек отменяет подписку средствами Telegram, и узнаём мы
    // об этом только событием. Без него мы продолжали бы считать, что
    // продление включено.
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'f-4' });
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'f-4', externalId: '4004' }),
    });

    const outcome = await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: { kind: 'renewalStopped', ref: 'f-4' },
    });

    expect(outcome.kind).toBe('stopped');
    expect((await subscriptionOf(testDb(), { userId, provider: RAIL }))?.autoRenew).toBe(false);
  });
});

describe('пробный период и оплата не воюют', () => {
  it('у платящего пробный период не тратится', async () => {
    /**
     * Иначе человек, заплативший сразу, сжёг бы бесплатные выгрузки, а
     * отменив подписку через год, остался бы вообще без ничего.
     */
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 't-1' });
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 't-1', externalId: '5001' }),
      now: new Date('2026-09-07T10:00:00.000Z'),
    });

    const [batch] = await testDb()
      .insert(batches)
      .values({ userId, status: 'done' })
      .returning({ id: batches.id });

    const marked = await markTrialSpent(testDb(), {
      batchId: batch?.id ?? '',
      now: new Date('2026-09-08T10:00:00.000Z'),
    });

    expect(marked).toBe(false);
    expect(await trialSpent(testDb(), userId)).toBe(0);
  });

  it('а у неплатящего тратится, как раньше', async () => {
    const [batch] = await testDb()
      .insert(batches)
      .values({ userId, status: 'done' })
      .returning({ id: batches.id });

    expect(await markTrialSpent(testDb(), { batchId: batch?.id ?? '' })).toBe(true);
    expect(await trialSpent(testDb(), userId)).toBe(1);
  });

  it('доступ от подписки перекрывает исчерпанный пробный период', async () => {
    await putSetting(testDb(), { name: 'trialDumps', value: '1' });

    const [batch] = await testDb()
      .insert(batches)
      .values({ userId, status: 'done' })
      .returning({ id: batches.id });

    await markTrialSpent(testDb(), { batchId: batch?.id ?? '' });

    const before = await accessOf(testDb(), { userId, settings });
    expect(before.allowed).toBe(false);
    expect(before.source).toBe('none');

    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 't-2' });
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 't-2', externalId: '5002' }),
    });

    const after = await accessOf(testDb(), { userId, settings });
    expect(after.allowed).toBe(true);
    expect(after.source).toBe('subscription');
  });

  it('две подписки на разных рельсах: действует та, что кончается позже', async () => {
    /**
     * Человек может заплатить и рублями, и звёздами — например, забыв про
     * первую подписку. Обратное правило («последняя выигрывает») отобрало
     * бы у него оплаченное.
     */
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'm-1' });
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'm-1', externalId: '6001' }),
      now: new Date('2026-09-07T10:00:00.000Z'),
    });

    await createInvoice(testDb(), {
      provider: 'telegram:stars',
      userId,
      plan: 'monthly',
      kind: 'initial',
      amountMinor: 150,
      currency: 'XTR',
      ref: 'm-2',
    });

    await applyPaymentEvent(testDb(), {
      provider: 'telegram:stars',
      event: {
        kind: 'paid',
        externalId: 'stars-charge-1',
        ref: 'm-2',
        amount: 150,
        currency: 'XTR',
        renewal: false,
      },
      // Звёздами заплатил раньше: его период кончается раньше.
      now: new Date('2026-08-20T10:00:00.000Z'),
    });

    const access = await accessOf(testDb(), {
      userId,
      settings,
      now: new Date('2026-09-25T10:00:00.000Z'),
    });

    // Рублёвая подписка ещё жива — доступ есть, хотя звёздная кончилась.
    expect(access.allowed).toBe(true);
    expect(access.paidUntil?.toISOString()).toBe('2026-10-07T10:00:00.000Z');
  });
});

describe('цены задаются в админке — §14', () => {
  it('пока цена не задана, тарифа нет вовсе', async () => {
    /**
     * Ноль означает «цена не задана», а не «бесплатно». Придуманная нами
     * цена по умолчанию означала бы, что бот однажды продаст подписку за
     * выдуманные деньги, а узнали бы мы об этом по чужой жалобе.
     */
    expect(await priceOf(settings, { plan: 'monthly', rail: RAIL })).toBeUndefined();
    expect(await tariffsOf(settings, RAIL)).toEqual([]);
  });

  it('заданная цена доходит до тарифа — без выкладки', async () => {
    await putSetting(testDb(), { name: 'priceMonthlyRub', value: '39900' });
    await putSetting(testDb(), { name: 'priceYearlyStars', value: '1500' });

    expect(await priceOf(settings, { plan: 'monthly', rail: RAIL })).toEqual({
      amountMinor: 39_900,
      currency: 'RUB',
    });

    expect(await priceOf(settings, { plan: 'yearly', rail: 'telegram:stars' })).toEqual({
      amountMinor: 1_500,
      currency: 'XTR',
    });

    // На рублёвом рельсе задан только месяц — годового тарифа там нет.
    expect((await tariffsOf(settings, RAIL)).map((one) => one.plan)).toEqual(['monthly']);
  });
});

describe('номера счетов', () => {
  it('каждый следующий номер новый и больше нуля', async () => {
    /**
     * Повторный номер Робокасса отвергает ошибкой 40, а ноль означает
     * «назначу сам» — и тогда наш номер окажется мёртвым, а продление
     * через месяц уйдёт в пустоту.
     */
    const first = await nextInvId(testDb());
    const second = await nextInvId(testDb());

    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
  });

  it('номера не переиспользуются даже после отката', async () => {
    // Последовательность в Postgres не откатывается вместе с транзакцией —
    // ровно то поведение, которое здесь нужно.
    const before = await nextInvId(testDb());

    await testDb()
      .transaction(async (tx) => {
        await nextInvId(tx);
        throw new Error('откат');
      })
      .catch(() => undefined);

    const after = await nextInvId(testDb());

    expect(after).toBeGreaterThan(before + 1);
  });
});

describe('§16: удаление данных человека', () => {
  it('подписка уходит вместе с человеком, а счёт обезличивается', async () => {
    /**
     * Разные решения по разным причинам. В подписке лежит ключ к способу
     * оплаты — такому переживать удаление нельзя. А счёт — это наша
     * выручка, в нём нет ни строчки его текста, и без него нельзя
     * сказать, сколько продукт заработал.
     */
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'd-1' });
    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'd-1', externalId: '7001' }),
    });

    await testDb().delete(users).where(eq(users.id, userId));

    expect(await testDb().select().from(billingSubscriptions)).toHaveLength(0);

    const invoices = await testDb().select().from(billingInvoices);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.userId).toBeNull();
    expect(invoices[0]?.amountMinor).toBe(39_900);
  });

  it('событие оплаты по обезличенному счёту не воскрешает подписку', async () => {
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'd-2' });
    await testDb().delete(users).where(eq(users.id, userId));

    const outcome = await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'd-2', externalId: '7002' }),
    });

    expect(outcome.kind).toBe('unknown');
    expect(await testDb().select().from(billingSubscriptions)).toHaveLength(0);
  });
});

describe('деньги видны, даже когда услугу выдать некому (ревизия этапа)', () => {
  it('оплата по обезличенному счёту записывается, а не исчезает', async () => {
    /**
     * **Найдено ревизией четвёртого этапа.** Человек нажал «Перейти к
     * оплате», ушёл на страницу провайдера и до её завершения нажал
     * «Удалить мои данные». Настоящее подписанное уведомление приходило
     * на обезличенный счёт — и прежде тут стоял простой возврат
     * `unknown` **до** записи события: Робокасса получала `OK` и не
     * повторяла, строки события не было, счёт оставался «выставленным».
     *
     * Деньги приходили и не были видны нигде: ни в выручке (та считает
     * оплаченные), ни в разделе ошибок (тот читает неудачные).
     * Обращение «я заплатила» в панели не находилось.
     */
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'обезличен' });

    await testDb()
      .update(billingInvoices)
      .set({ userId: null })
      .where(eq(billingInvoices.ref, 'обезличен'));

    const outcome = await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'обезличен', externalId: '8001' }),
      outSum: '399.00',
    });

    expect(outcome.kind).toBe('unknown');

    // Событие записано — есть по чему разбирать обращение.
    const events = await testDb().select().from(billingEvents);
    expect(events).toHaveLength(1);
    expect(events[0]?.externalId).toBe('8001');

    // И счёт помечен оплаченным пришедшей суммой.
    const invoice = await invoiceByRef(testDb(), { provider: RAIL, ref: 'обезличен' });
    expect(invoice?.status).toBe('paid');
    expect(invoice?.outSumReceived).toBe('399.00');
  });

  it('повторная доставка по обезличенному счёту не задваивается', async () => {
    // Идемпотентность обязана работать и здесь: Робокасса повторяет
    // доставку, пока не получит OK, а OK мы отдаём.
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'обезличен-2' });

    await testDb()
      .update(billingInvoices)
      .set({ userId: null })
      .where(eq(billingInvoices.ref, 'обезличен-2'));

    const event = paid({ ref: 'обезличен-2', externalId: '8002' });

    expect((await applyPaymentEvent(testDb(), { provider: RAIL, event })).kind).toBe('unknown');
    expect((await applyPaymentEvent(testDb(), { provider: RAIL, event })).kind).toBe('duplicate');

    expect(await testDb().select().from(billingEvents)).toHaveLength(1);
  });
});

describe('вторая оплата той же ссылки — это второй платёж (ревизия этапа)', () => {
  it('оплата уже оплаченного счёта заводит новую строку даже без признака продления', async () => {
    /**
     * **Найдено ревизией.** Промо-счёт уходит разовым, значит вторая
     * оплата той же ссылки приходит **без** признака продления — и
     * прежде переписывала уже оплаченную строку: восемьдесят звёзд
     * получены, сорок учтены, в промокодах «одно применение» вместо
     * двух, и подписка при этом продлена.
     *
     * Дважды оплаченная ссылка — это два платежа, чем бы они себя ни
     * называли.
     */
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'дважды' });

    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'дважды', externalId: '8101' }),
      now: new Date('2026-09-07T10:00:00.000Z'),
    });

    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      // Признака продления нет: это просто вторая оплата той же ссылки.
      event: paid({ ref: 'дважды', externalId: '8102' }),
      now: new Date('2026-09-08T10:00:00.000Z'),
    });

    const rows = await testDb()
      .select()
      .from(billingInvoices)
      .where(eq(billingInvoices.ref, 'дважды'));

    expect(rows).toHaveLength(2);
    expect(rows.filter((one) => one.status === 'paid')).toHaveLength(2);

    // Вторая строка — не продление: назвать её так значило бы соврать в
    // отчёте о том, за что заплатили.
    const second = rows.find((one) => one.paidAt?.toISOString().startsWith('2026-09-08'));
    expect(second?.kind).toBe('initial');
    expect(second?.autoRenew).toBe(false);
  });
});

describe('возврат виден как возврат (ревизия этапа)', () => {
  it('возвращённый счёт перестаёт быть оплаченным', async () => {
    /**
     * **Найдено ревизией.** Доступ снимался правильно, а счёт оставался
     * `paid`: выручка в панели продолжала считать вернувшиеся деньги,
     * отличить возврат было нечем, а человек навсегда числился
     * платившим — то есть терял право на промокод «первый период», не
     * получив периода.
     */
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'вернули' });

    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'вернули', externalId: '8201' }),
    });

    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: {
        kind: 'refunded',
        externalId: '8202',
        ref: 'вернули',
        amount: 39_900,
        currency: 'RUB',
      },
      now: new Date('2026-09-20T10:00:00.000Z'),
    });

    const invoice = await invoiceByRef(testDb(), { provider: RAIL, ref: 'вернули' });

    expect(invoice?.status).toBe('refunded');
    expect(invoice?.refundedAt?.toISOString()).toBe('2026-09-20T10:00:00.000Z');
    // Дата оплаты цела: обе нужны отчёту того месяца.
    expect(invoice?.paidAt).not.toBeNull();

    /**
     * Доступ снят: период обрывается моментом возврата, а не «сейчас».
     * Деньги вернулись — значит услуга не оплачена.
     */
    const subscription = await subscriptionOf(testDb(), { userId, provider: RAIL });
    expect(subscription?.currentPeriodEnd.toISOString()).toBe('2026-09-20T10:00:00.000Z');
  });

  it('после возврата человек снова считается не платившим', async () => {
    // Периода он не получил, значит промокод «на первый период» ему
    // по-прежнему положен.
    await invoiceFor({ plan: 'monthly', kind: 'initial', ref: 'вернули-2' });

    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: paid({ ref: 'вернули-2', externalId: '8301' }),
    });

    expect(await paidInvoicesCount(testDb(), userId)).toBe(1);

    await applyPaymentEvent(testDb(), {
      provider: RAIL,
      event: {
        kind: 'refunded',
        externalId: '8302',
        ref: 'вернули-2',
        amount: 39_900,
        currency: 'RUB',
      },
    });

    expect(await paidInvoicesCount(testDb(), userId)).toBe(0);
  });
});

describe('удаление данных отменяет продление у провайдера (§16, ревизия этапа)', () => {
  /**
   * **Найдено ревизией, и это была утечка денег человека.** Ключ отмены
   * звёздной подписки лежит в подписке, а она уходит каскадом вместе с
   * человеком: §16 требует удалить его данные, и ключ — тоже его данные.
   *
   * Что получалось: человек нажимал «удалить данные», бот отвечал
   * «Готово. Всё удалено», а Telegram продолжал списывать 150 звёзд
   * каждый месяц. Отменить это не мог никто — ни он (бот отвечал «нечего
   * отменять»), ни мы (ключа больше нет), ни панель.
   */

  /** Провайдер, помнящий, о чём просили, и умеющий отказать. */
  function watching(fails = false) {
    const asked: string[] = [];

    return {
      asked,
      provider: {
        name: 'telegram:stars',
        createCheckout: () => Promise.reject(new Error('не нужно')),
        readEvent: () => Promise.resolve(undefined),
        stopRenewal: (params: { readonly subscriptionRef: string }) => {
          if (fails) return Promise.reject(new Error('Telegram молчит'));

          asked.push(params.subscriptionRef);
          return Promise.resolve();
        },
        statusOf: () => Promise.resolve(undefined),
      } as PaymentProvider,
    };
  }

  async function starsSubscription(params: { readonly ref: string | null }): Promise<void> {
    await testDb()
      .insert(billingSubscriptions)
      .values({
        provider: 'telegram:stars',
        userId,
        plan: 'monthly',
        autoRenew: true,
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 3_600_000),
        ...(params.ref === null ? {} : { subscriptionRef: params.ref }),
      });
  }

  it('живая подписка отменяется ключом первого платежа', async () => {
    await starsSubscription({ ref: 'charge-первый' });

    const watcher = watching();

    const outcome = await stopAllRenewals(testDb(), {
      userId,
      tgId: 4_200_001,
      providers: { 'telegram:stars': watcher.provider },
    });

    expect(watcher.asked).toEqual(['charge-первый']);
    expect(outcome.stopped).toEqual(['telegram:stars']);
    expect(outcome.failed).toEqual([]);

    // И у себя тоже: если удаление не состоится, состояние сойдётся.
    expect(
      (await subscriptionOf(testDb(), { userId, provider: 'telegram:stars' }))?.autoRenew,
    ).toBe(false);
  });

  it('отказ провайдера возвращается наверх, а не глотается', async () => {
    /**
     * §16 — право человека, и заложником чужого сбоя оно быть не может:
     * удаление всё равно состоится. Но молчать нельзя, иначе он узнает
     * о списании из своего счёта.
     */
    await starsSubscription({ ref: 'charge-первый' });

    const outcome = await stopAllRenewals(testDb(), {
      userId,
      tgId: 4_200_001,
      providers: { 'telegram:stars': watching(true).provider },
    });

    expect(outcome.failed).toEqual(['telegram:stars']);
    expect(outcome.stopped).toEqual([]);
  });

  it('подписка без ключа отмены — тоже отказ, а не «всё в порядке»', async () => {
    // Списание продолжится, и сказать об этом надо: молчание здесь и
    // есть та самая утечка.
    await starsSubscription({ ref: null });

    const outcome = await stopAllRenewals(testDb(), {
      userId,
      tgId: 4_200_001,
      providers: { 'telegram:stars': watching().provider },
    });

    expect(outcome.failed).toEqual(['telegram:stars']);
  });

  it('выключенный рельс — отказ: отменять нечем', async () => {
    await starsSubscription({ ref: 'charge-первый' });

    const outcome = await stopAllRenewals(testDb(), {
      userId,
      tgId: 4_200_001,
      providers: {},
    });

    expect(outcome.failed).toEqual(['telegram:stars']);
  });

  it('кончившуюся подписку провайдеру не несут', async () => {
    /**
     * Списаний она не породит, а лишний отказ человек прочтёт как «что-то
     * не удалилось».
     */
    await testDb()
      .insert(billingSubscriptions)
      .values({
        provider: 'telegram:stars',
        userId,
        plan: 'monthly',
        autoRenew: true,
        currentPeriodEnd: new Date(Date.now() - 24 * 3_600_000),
        subscriptionRef: 'charge-старый',
      });

    const watcher = watching();

    const outcome = await stopAllRenewals(testDb(), {
      userId,
      tgId: 4_200_001,
      providers: { 'telegram:stars': watcher.provider },
    });

    expect(watcher.asked).toEqual([]);
    expect(outcome).toEqual({ stopped: [], failed: [] });
  });

  it('отменённое продление второй раз не отменяют', async () => {
    await testDb()
      .insert(billingSubscriptions)
      .values({
        provider: 'telegram:stars',
        userId,
        plan: 'monthly',
        autoRenew: false,
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 3_600_000),
        subscriptionRef: 'charge-первый',
      });

    const watcher = watching();

    await stopAllRenewals(testDb(), {
      userId,
      tgId: 4_200_001,
      providers: { 'telegram:stars': watcher.provider },
    });

    expect(watcher.asked).toEqual([]);
  });
});
