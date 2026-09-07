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
import { createInvoice, invoiceByRef, nextInvId, subscriptionOf } from './billing.repo.js';
import type { PaymentEvent } from './provider.js';
import {
  accessOf,
  applyPaymentEvent,
  cancelRenewal,
  markTrialSpent,
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
