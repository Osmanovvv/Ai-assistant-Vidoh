import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appSettings,
  billingEvents,
  billingInvoices,
  billingSubscriptions,
  users,
} from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { putSetting, SettingsRegistry } from '../settings/settings.repo.js';
import { upsertUser } from '../users/users.repo.js';
import { createInvoice, nextInvId, subscriptionOf } from './billing.repo.js';
import { applyPaymentEvent } from './subscription.service.js';
import {
  RENEWAL_TICK_MS,
  resolveAwaiting,
  runRenewals,
  ROBOKASSA_RAIL,
  startRenewals,
} from './renewal.service.js';
import type { PaymentProvider } from './provider.js';

/**
 * Продление рублёвой подписки (§14 ТЗ, задача 4.2).
 *
 * Проверяется главное: **денег не берут дважды**. Всё остальное здесь
 * дешевле любой ошибки в этом.
 *
 * Дочернее списание не спрашивает человека. Значит второй проход, второй
 * процесс и перезапуск в середине обязаны упереться в запрет — и запрет
 * этот в базе, а не в осторожности кода. Проверить его можно только на
 * настоящей базе: уникальный индекс подделке не поддаётся.
 */

const logger = createLogger({ level: 'silent' });

let userId = '';
let settings: SettingsRegistry;

/** Заглушка Робокассы: помнит, о чём просили, и отвечает как велено. */
function robokassa(answer: string | Error) {
  const asked: URLSearchParams[] = [];

  return {
    asked,
    deps: {
      merchantLogin: 'выдох',
      password1: 'п1',
      password2: 'п2',
      recurringApproved: true,
      logger,
      fetch: ((_url: unknown, init: unknown) => {
        const body = (init as { body: string }).body;
        asked.push(new URLSearchParams(body));

        if (answer instanceof Error) return Promise.reject(answer);

        return Promise.resolve({ text: () => Promise.resolve(answer) });
      }) as unknown as typeof globalThis.fetch,
    },
  };
}

/**
 * Человек с оплаченной подпиской, которой пора продлеваться.
 *
 * Собирается настоящим путём — через `applyPaymentEvent`, — а не записью
 * в таблицы. Иначе проверка мерила бы не то: продлению нужен
 * **фактический** номер материнского платежа, и появляется он именно
 * оплатой.
 */
async function payingPerson(params: {
  readonly periodEnd: Date;
  /**
   * Второй платящий в том же тесте.
   *
   * Ссылка и внешний номер задаются вместе с человеком нарочно: ключ
   * идемпотентности события оплаты — внешний номер, и повтор «5001»
   * отбился бы как дубль. Второй человек молча остался бы без подписки,
   * а проверка мерила бы не то, что думает.
   */
  readonly who?: string | undefined;
  readonly ref?: string | undefined;
  readonly externalId?: string | undefined;
}): Promise<void> {
  const person = params.who ?? userId;
  const ref = params.ref ?? 'first';

  await createInvoice(testDb(), {
    provider: ROBOKASSA_RAIL,
    userId: person,
    plan: 'monthly',
    kind: 'initial',
    amountMinor: 39_900,
    currency: 'RUB',
    ref,
    invId: await nextInvId(testDb()),
    autoRenew: true,
  });

  await applyPaymentEvent(testDb(), {
    provider: ROBOKASSA_RAIL,
    event: {
      kind: 'paid',
      externalId: params.externalId ?? '5001',
      ref,
      amount: 39_900,
      currency: 'RUB',
      renewal: false,
      paidUntil: params.periodEnd,
    },
  });
}

beforeEach(async () => {
  await testDb().delete(billingEvents);
  await testDb().delete(billingSubscriptions);
  await testDb().delete(billingInvoices);
  await testDb().delete(appSettings);
  await testDb().delete(users);

  const person = await upsertUser(testDb(), { tgId: 4_400_001, firstName: 'Мила' });
  userId = person.id;

  settings = new SettingsRegistry({ db: testDb(), logger, ttlMs: 0 });
  await putSetting(testDb(), { name: 'priceMonthlyRub', value: '39900' });
});

describe('продление уходит вовремя и один раз', () => {
  it('за сутки до конца периода списание создаётся', async () => {
    /**
     * Сутки запаса — не про скорость: неудачное списание оставляет
     * человеку день, чтобы заплатить руками и не потерять доступ ни на
     * час.
     */
    await payingPerson({ periodEnd: new Date('2026-10-01T10:00:00.000Z') });

    const rk = robokassa('OK1234');

    const round = await runRenewals({
      db: testDb(),
      logger,
      robokassa: rk.deps,
      settings,
      now: () => new Date('2026-09-30T12:00:00.000Z'),
    });

    expect(round).toEqual({ charged: 1, failed: 0, skipped: 0 });

    // В PreviousInvoiceID уходит ФАКТИЧЕСКИЙ номер материнского платежа.
    expect(rk.asked[0]?.get('PreviousInvoiceID')).toBe('5001');
    expect(rk.asked[0]?.get('OutSum')).toBe('399.00');
  });

  it('за неделю до конца — ещё нет', async () => {
    await payingPerson({ periodEnd: new Date('2026-10-01T10:00:00.000Z') });

    const rk = robokassa('OK1234');

    const round = await runRenewals({
      db: testDb(),
      logger,
      robokassa: rk.deps,
      settings,
      now: () => new Date('2026-09-24T10:00:00.000Z'),
    });

    expect(round.charged).toBe(0);
    expect(rk.asked).toHaveLength(0);
  });

  it('два прохода подряд списывают ОДИН раз', async () => {
    /**
     * **Главная проверка задачи.** Проход просыпается каждый час, и за
     * сутки перед концом периода человек попадает в выборку двадцать
     * четыре раза. Списаться должно один раз.
     *
     * Держит это уникальный индекс по тройке «рельс, человек, конец
     * продлеваемого периода», а не флаг в памяти: флаг не переживает
     * перезапуск и ничего не знает о втором процессе.
     */
    await payingPerson({ periodEnd: new Date('2026-10-01T10:00:00.000Z') });

    const rk = robokassa('OK1234');
    const now = () => new Date('2026-09-30T12:00:00.000Z');

    const first = await runRenewals({ db: testDb(), logger, robokassa: rk.deps, settings, now });
    const second = await runRenewals({ db: testDb(), logger, robokassa: rk.deps, settings, now });

    expect(first.charged).toBe(1);
    expect(second.charged).toBe(0);

    /**
     * Второй проход подписку **даже не берёт**, и это лучше, чем брать и
     * пропускать.
     *
     * До ревизии она оставалась в выборке навсегда: сортировка по концу
     * периода ставила её первой, каждый час она тратила номер из
     * последовательности и упиралась в запрет второго списания.
     * Пятьдесят таких — и выборка целиком из них, продления
     * прекращались у всех платящих сразу, причём молча.
     *
     * Теперь ушедшее списание исключает подписку из выборки
     * полусоединением, поэтому `skipped` остаётся нулём: пропускать
     * нечего.
     */
    expect(second).toEqual({ charged: 0, failed: 0, skipped: 0 });

    // Один запрос к Робокассе, а не два: считаем отправки, а не записи.
    expect(rk.asked).toHaveLength(1);
  });

  it('ушедшее списание не вытесняет живые подписки из выборки', async () => {
    /**
     * **Главная проверка находки.** Прежде застрявшая подписка шла
     * первой всегда, и при пятидесяти таких ни одна живая до списания не
     * доходила. Здесь их две: у первой списание уже ушло, у второй нет —
     * и вторая обязана быть обслужена.
     */
    await payingPerson({ periodEnd: new Date('2026-10-01T10:00:00.000Z') });

    const other = (await upsertUser(testDb(), { tgId: 4_400_002, firstName: 'Оля' })).id;

    await createInvoice(testDb(), {
      provider: ROBOKASSA_RAIL,
      userId: other,
      plan: 'monthly',
      kind: 'initial',
      amountMinor: 39_900,
      currency: 'RUB',
      ref: 'олин',
      invId: await nextInvId(testDb()),
      autoRenew: true,
    });

    await applyPaymentEvent(testDb(), {
      provider: ROBOKASSA_RAIL,
      event: {
        kind: 'paid',
        externalId: '5002',
        ref: 'олин',
        amount: 39_900,
        currency: 'RUB',
        renewal: false,
        // Её период кончается позже — значит в выборке она была бы второй.
        paidUntil: new Date('2026-10-01T11:00:00.000Z'),
      },
    });

    const rk = robokassa('OK1234');
    const now = () => new Date('2026-09-30T12:00:00.000Z');

    // Первый проход обслуживает обоих.
    expect(
      (await runRenewals({ db: testDb(), logger, robokassa: rk.deps, settings, now })).charged,
    ).toBe(2);

    // Второй — никого: у обоих списание ушло.
    expect(
      (await runRenewals({ db: testDb(), logger, robokassa: rk.deps, settings, now })).charged,
    ).toBe(0);

    expect(rk.asked).toHaveLength(2);
  });

  it('два одновременных прохода — тоже один раз', async () => {
    /**
     * Так выглядит выкладка: старый процесс ещё жив, новый уже поднялся,
     * и оба просыпаются в одну секунду. Проверка идёт настоящей
     * параллельностью, а не по очереди: индекс обязан отбить второго на
     * вставке, а не после неё.
     */
    await payingPerson({ periodEnd: new Date('2026-10-01T10:00:00.000Z') });

    const rk = robokassa('OK1234');
    const now = () => new Date('2026-09-30T12:00:00.000Z');

    const rounds = await Promise.all([
      runRenewals({ db: testDb(), logger, robokassa: rk.deps, settings, now }),
      runRenewals({ db: testDb(), logger, robokassa: rk.deps, settings, now }),
    ]);

    expect(rounds.reduce((sum, round) => sum + round.charged, 0)).toBe(1);
    expect(rk.asked).toHaveLength(1);
  });

  it('срок подписки списанием НЕ двигается', async () => {
    /**
     * `OK<номер>` от Робокассы означает **создание операции**, а не
     * списание денег. Продлевает подписку пришедшее уведомление;
     * сдвинуть срок сейчас значило бы подарить месяц за попытку.
     */
    const periodEnd = new Date('2026-10-01T10:00:00.000Z');
    await payingPerson({ periodEnd });

    await runRenewals({
      db: testDb(),
      logger,
      robokassa: robokassa('OK1234').deps,
      settings,
      now: () => new Date('2026-09-30T12:00:00.000Z'),
    });

    const subscription = await subscriptionOf(testDb(), { userId, provider: ROBOKASSA_RAIL });

    expect(subscription?.currentPeriodEnd.toISOString()).toBe(periodEnd.toISOString());
  });
});

describe('когда продлевать нельзя', () => {
  it('снятая цена останавливает списание, а не заставляет угадывать', async () => {
    await payingPerson({ periodEnd: new Date('2026-10-01T10:00:00.000Z') });
    await testDb().delete(appSettings);
    settings.forget();

    const rk = robokassa('OK1234');

    const warned: { userId: string; paidUntil: Date }[] = [];

    const round = await runRenewals({
      db: testDb(),
      logger,
      robokassa: rk.deps,
      settings,
      now: () => new Date('2026-09-30T12:00:00.000Z'),
      onFailed: (params) => {
        warned.push(params);
        return Promise.resolve();
      },
    });

    // Списывать наугад нельзя — но и молчать нельзя.
    expect(round).toEqual({ charged: 0, failed: 1, skipped: 0 });
    expect(rk.asked).toHaveLength(0);

    /**
     * **Молчание здесь было самым дорогим следствием.** Ноль в панели
     * означает «тариф не продаётся», и заказчица ставит его, чтобы
     * закрыть продажу новым, — а вместе с продажей молча
     * останавливались продления **всем действующим** подписчикам. Ни
     * счёта, ни строки в разделе ошибок, ни слова человеку: через
     * день-два платящие слышали «Пробные разборы закончились», а в
     * обзоре стояло «Платят сейчас: 0».
     */
    expect(warned).toHaveLength(1);

    const subscription = await subscriptionOf(testDb(), { userId, provider: ROBOKASSA_RAIL });

    expect(subscription?.status).toBe('past_due');
    // Доступ при этом цел: §14 велит держать до конца оплаченного.
    expect(subscription?.currentPeriodEnd.toISOString()).toBe('2026-10-01T10:00:00.000Z');
  });

  it('отменённое продление не списывается', async () => {
    await payingPerson({ periodEnd: new Date('2026-10-01T10:00:00.000Z') });

    await testDb()
      .update(billingSubscriptions)
      .set({ autoRenew: false })
      .where(eq(billingSubscriptions.userId, userId));

    const rk = robokassa('OK1234');

    await runRenewals({
      db: testDb(),
      logger,
      robokassa: rk.deps,
      settings,
      now: () => new Date('2026-09-30T12:00:00.000Z'),
    });

    expect(rk.asked).toHaveLength(0);
  });

  it('без материнского платежа списание не выдумывается', async () => {
    /**
     * Подписка есть, а оплаченного счёта с фактическим номером нет — так
     * бывает после переноса данных. Подставить в `PreviousInvoiceID`
     * наш номер значило бы отправить списание в пустоту и получить
     * ошибку 40.
     */
    await testDb()
      .insert(billingSubscriptions)
      .values({
        provider: ROBOKASSA_RAIL,
        userId,
        plan: 'monthly',
        autoRenew: true,
        currentPeriodEnd: new Date('2026-10-01T10:00:00.000Z'),
      });

    const rk = robokassa('OK1234');

    const round = await runRenewals({
      db: testDb(),
      logger,
      robokassa: rk.deps,
      settings,
      now: () => new Date('2026-09-30T12:00:00.000Z'),
    });

    expect(round.skipped).toBe(1);
    expect(rk.asked).toHaveLength(0);
  });
});

describe('неудача продления', () => {
  it('отказ Робокассы помечает подписку и предупреждает человека', async () => {
    /**
     * Доступ при этом **не закрывается**: §14 велит держать его до конца
     * оплаченного периода. Человек платил, не отменял — отобрать сегодня
     * значило бы отобрать оплаченное.
     */
    const periodEnd = new Date('2026-10-01T10:00:00.000Z');
    await payingPerson({ periodEnd });

    const warned: { userId: string; paidUntil: Date }[] = [];

    const round = await runRenewals({
      db: testDb(),
      logger,
      robokassa: robokassa('34').deps,
      settings,
      now: () => new Date('2026-09-30T12:00:00.000Z'),
      onFailed: (params) => {
        warned.push(params);
        return Promise.resolve();
      },
    });

    expect(round).toEqual({ charged: 0, failed: 1, skipped: 0 });

    const subscription = await subscriptionOf(testDb(), { userId, provider: ROBOKASSA_RAIL });

    expect(subscription?.status).toBe('past_due');
    expect(subscription?.currentPeriodEnd.toISOString()).toBe(periodEnd.toISOString());

    expect(warned).toEqual([{ userId, paidUntil: periodEnd }]);

    /**
     * **Код ошибки провайдера доезжает до счёта** (ревизия этапа 4).
     *
     * Прежде столбец `error_code` у неудачного счёта оставался **вечно
     * пустым**: разбор кода в коде был (`errorTextOf`), но вызывающих у
     * него не было ни одного вне проверок. В панели любое неудачное
     * продление выглядело одинаково — «что-то не так», — хотя чинятся
     * они разными людьми: код 34 («услуга не подключена магазину») ждёт
     * владельца магазина, а код 29 («не сошлась подпись») — нас.
     *
     * Проверяется и текст: «ERROR: 34» разбирающему не говорит ничего,
     * пока он не откроет документацию, а объяснение — говорит всё.
     */
    const [failedInvoice] = await testDb()
      .select({ code: billingInvoices.errorCode, text: billingInvoices.errorText })
      .from(billingInvoices)
      .where(eq(billingInvoices.status, 'failed'));

    expect(failedInvoice?.code).toBe(34);
    expect(failedInvoice?.text).toContain('услуга не подключена');
    // И сырой ответ рядом: объяснение наше, а ответ — их, и спорить о
    // том, что именно приехало, не придётся.
    expect(failedInvoice?.text).toContain('34');
  });

  it('незнакомый код всё равно записывается числом, а не теряется', async () => {
    /**
     * Ревизия этапа 4. У Робокассы список кодов открытый, и объяснения
     * на всякий код у нас нет. Записать в этом случае **ничего** было бы
     * возвратом к прежнему дефекту: разбирающий увидел бы пустоту там,
     * где провайдер назвал причину. Поэтому объяснение необязательно, а
     * число — обязательно.
     */
    await payingPerson({ periodEnd: new Date('2026-10-01T10:00:00.000Z') });

    const round = await runRenewals({
      db: testDb(),
      logger,
      robokassa: robokassa('ERROR: 777').deps,
      settings,
      now: () => new Date('2026-09-30T12:00:00.000Z'),
    });

    expect(round.failed).toBe(1);

    const [failedInvoice] = await testDb()
      .select({ code: billingInvoices.errorCode, text: billingInvoices.errorText })
      .from(billingInvoices)
      .where(eq(billingInvoices.status, 'failed'));

    expect(failedInvoice?.code).toBe(777);
    // Объяснения нет — значит в тексте сырой ответ, а не пустота.
    expect(failedInvoice?.text).toBe('ERROR: 777');
  });

  it('потерянный ответ повтора НЕ вызывает', async () => {
    /**
     * «Робокасса не ответила» ≠ «не списала»: операция могла создаться, а
     * ответ потеряться в сети. Повтор здесь означал бы, что человек
     * заплатил дважды — самая дорогая ошибка во всей задаче.
     */
    await payingPerson({ periodEnd: new Date('2026-10-01T10:00:00.000Z') });

    const rk = robokassa(new Error('сеть моргнула'));
    const now = () => new Date('2026-09-30T12:00:00.000Z');

    const warned: { userId: string; paidUntil: Date }[] = [];

    const first = await runRenewals({
      db: testDb(),
      logger,
      robokassa: rk.deps,
      settings,
      now,
      onFailed: (params) => {
        warned.push(params);
        return Promise.resolve();
      },
    });

    const second = await runRenewals({ db: testDb(), logger, robokassa: rk.deps, settings, now });

    expect(first.failed).toBe(1);
    // Второй проход не пробует снова: попытка на период израсходована, и
    // подписка уже выведена из выборки ушедшим списанием.
    expect(second).toEqual({ charged: 0, failed: 0, skipped: 0 });
    expect(rk.asked).toHaveLength(1);

    /**
     * **И человек об этом узнаёт.** Прежде в этой ветке была только
     * запись в журнал: подписка оставалась `active` с включённым
     * продлением, а доступ кончался внезапно у того, кто платил и не
     * отменял. План обещал обратное дословно.
     */
    expect(warned).toHaveLength(1);

    expect((await subscriptionOf(testDb(), { userId, provider: ROBOKASSA_RAIL }))?.status).toBe(
      'past_due',
    );
  });

  it('упавшее предупреждение не роняет проход', async () => {
    // Телеграм молчит — продление всё равно должно быть учтено, иначе
    // следующий проход спишет второй раз.
    await payingPerson({ periodEnd: new Date('2026-10-01T10:00:00.000Z') });

    const round = await runRenewals({
      db: testDb(),
      logger,
      robokassa: robokassa('34').deps,
      settings,
      now: () => new Date('2026-09-30T12:00:00.000Z'),
      onFailed: () => Promise.reject(new Error('телеграм молчит')),
    });

    expect(round.failed).toBe(1);
  });
});

describe('разбор ушедших списаний без ответа', () => {
  /**
   * Ответ «OK<номер>» означает **создание операции**, а не списание
   * денег. Если денег на карте не хватило, уведомления не будет никогда
   * — и прежде такой счёт оставался «выставленным» навсегда: не виден ни
   * в выручке, ни в разделе ошибок, а человек не знал, что доступ
   * кончится.
   */

  /** Провайдер, отвечающий на вопрос о состоянии операции. */
  function asking(paid: boolean | Error): PaymentProvider {
    return {
      name: ROBOKASSA_RAIL,
      createCheckout: () => Promise.reject(new Error('не нужно')),
      readEvent: () => Promise.resolve(undefined),
      stopRenewal: () => Promise.resolve(),
      statusOf: () =>
        paid instanceof Error ? Promise.reject(paid) : Promise.resolve({ active: paid }),
    };
  }

  /** Ушедшее списание, ответа на которое нет уже три часа. */
  async function sent(): Promise<void> {
    const rk = robokassa('OK1234');

    await runRenewals({
      db: testDb(),
      logger,
      robokassa: rk.deps,
      settings,
      now: () => new Date('2026-09-30T12:00:00.000Z'),
    });

    await testDb()
      .update(billingInvoices)
      .set({ createdAt: new Date('2026-09-30T09:00:00.000Z') })
      .where(eq(billingInvoices.kind, 'renewal'));
  }

  it('деньги есть, уведомление потерялось — оплата доводится сама', async () => {
    /**
     * **Это про деньги человека.** Он заплатил, уведомление не дошло, и
     * прежде доступ у него кончался бы по сроку, хотя деньги списаны.
     *
     * Ключ идемпотентности у построенного события тот же, что принесло
     * бы уведомление — номер счёта, — поэтому опоздавшее уведомление
     * отобьётся как повтор, а не продлит период второй раз.
     */
    await payingPerson({ periodEnd: new Date('2026-10-01T10:00:00.000Z') });
    await sent();

    const round = await resolveAwaiting({
      db: testDb(),
      logger,
      robokassa: robokassa('OK1234').deps,
      settings,
      provider: asking(true),
      now: () => new Date('2026-09-30T12:00:00.000Z'),
    });

    expect(round.finished).toBe(1);

    const subscription = await subscriptionOf(testDb(), { userId, provider: ROBOKASSA_RAIL });

    // Период продлён от конца прежнего, а не от «сейчас».
    expect(subscription?.currentPeriodEnd.getTime()).toBeGreaterThan(
      new Date('2026-10-01T10:00:00.000Z').getTime(),
    );
    expect(subscription?.status).toBe('active');
  });

  it('опоздавшее уведомление после этого не продлевает второй раз', async () => {
    await payingPerson({ periodEnd: new Date('2026-10-01T10:00:00.000Z') });
    await sent();

    const deps = {
      db: testDb(),
      logger,
      robokassa: robokassa('OK1234').deps,
      settings,
      provider: asking(true),
      now: () => new Date('2026-09-30T12:00:00.000Z'),
    };

    await resolveAwaiting(deps);

    const after = await subscriptionOf(testDb(), { userId, provider: ROBOKASSA_RAIL });

    const [renewal] = await testDb()
      .select()
      .from(billingInvoices)
      .where(eq(billingInvoices.kind, 'renewal'));

    // Теперь приходит то самое уведомление — с тем же номером счёта.
    const outcome = await applyPaymentEvent(testDb(), {
      provider: ROBOKASSA_RAIL,
      event: {
        kind: 'paid',
        externalId: String(renewal?.invId ?? 0),
        ref: renewal?.ref ?? '',
        amount: 39_900,
        currency: 'RUB',
        renewal: true,
      },
    });

    expect(outcome.kind).toBe('duplicate');

    const again = await subscriptionOf(testDb(), { userId, provider: ROBOKASSA_RAIL });

    expect(again?.currentPeriodEnd.toISOString()).toBe(after?.currentPeriodEnd.toISOString());
  });

  it('денег нет — подписка помечена, человек предупреждён, доступ цел', async () => {
    const periodEnd = new Date('2026-10-01T10:00:00.000Z');

    await payingPerson({ periodEnd });
    await sent();

    const warned: { userId: string; paidUntil: Date }[] = [];

    const round = await resolveAwaiting({
      db: testDb(),
      logger,
      robokassa: robokassa('OK1234').deps,
      settings,
      provider: asking(false),
      now: () => new Date('2026-09-30T12:00:00.000Z'),
      onFailed: (params) => {
        warned.push(params);
        return Promise.resolve();
      },
    });

    expect(round.failed).toBe(1);
    expect(warned).toHaveLength(1);

    const subscription = await subscriptionOf(testDb(), { userId, provider: ROBOKASSA_RAIL });

    expect(subscription?.status).toBe('past_due');
    // §14: доступ живёт до конца оплаченного периода.
    expect(subscription?.currentPeriodEnd.toISOString()).toBe(periodEnd.toISOString());

    // И счёт стал виден в разделе ошибок: он больше не «выставлен».
    const [renewal] = await testDb()
      .select()
      .from(billingInvoices)
      .where(eq(billingInvoices.kind, 'renewal'));

    expect(renewal?.status).toBe('failed');
    expect(renewal?.errorText).toContain('денег не поступило');
  });

  it('молчание провайдера ничего не решает: переспросим следующим проходом', async () => {
    /**
     * Принять «Робокасса не ответила» за «денег нет» значило бы напугать
     * платящего человека без причины — и снять с продления живую
     * подписку.
     */
    await payingPerson({ periodEnd: new Date('2026-10-01T10:00:00.000Z') });
    await sent();

    const warned: unknown[] = [];

    const round = await resolveAwaiting({
      db: testDb(),
      logger,
      robokassa: robokassa('OK1234').deps,
      settings,
      provider: asking(new Error('сеть моргнула')),
      now: () => new Date('2026-09-30T12:00:00.000Z'),
      onFailed: () => {
        warned.push(1);
        return Promise.resolve();
      },
    });

    expect(round).toEqual({ finished: 0, failed: 0, unknown: 1 });
    expect(warned).toHaveLength(0);
    expect((await subscriptionOf(testDb(), { userId, provider: ROBOKASSA_RAIL }))?.status).toBe(
      'active',
    );
  });

  it('свежее ожидание не разбирается: уведомление ещё может дойти', async () => {
    /**
     * Робокасса повторяет доставку, банк списывает не мгновенно.
     * Спросить через минуту значило бы принять «ещё не дошло» за «денег
     * нет».
     */
    await payingPerson({ periodEnd: new Date('2026-10-01T10:00:00.000Z') });

    const rk = robokassa('OK1234');
    const now = () => new Date('2026-09-30T12:00:00.000Z');

    await runRenewals({ db: testDb(), logger, robokassa: rk.deps, settings, now });

    // Счёт заведён только что — два часа ещё не прошли.
    const round = await resolveAwaiting({
      db: testDb(),
      logger,
      robokassa: rk.deps,
      settings,
      provider: asking(false),
      now,
    });

    expect(round).toEqual({ finished: 0, failed: 0, unknown: 0 });
  });

  it('без провайдера разбор не работает — и это законное состояние', async () => {
    // Так живут все проверки, писавшиеся до ревизии.
    await payingPerson({ periodEnd: new Date('2026-10-01T10:00:00.000Z') });
    await sent();

    expect(
      await resolveAwaiting({
        db: testDb(),
        logger,
        robokassa: robokassa('OK1234').deps,
        settings,
        now: () => new Date('2026-09-30T12:00:00.000Z'),
      }),
    ).toEqual({ finished: 0, failed: 0, unknown: 0 });
  });
});

describe('подъём не ждёт первого часа', () => {
  /**
   * **Находка ревизии этапов 1–2.** Продление просыпалось только по
   * таймеру: чистый `setInterval` с шагом час и без первого прохода.
   *
   * Каждая выкладка убивает процесс и заводит таймер заново, то есть
   * обнуляет час. День с выкладками чаще часа — а такой день бывает
   * ровно тогда, когда что-то чинят, — и продление не проходит **ни
   * разу**. Списание уходит за сутки до конца периода; сутки без единого
   * прохода означают, что у платящего человека подписка просто кончится,
   * и он об этом даже не будет предупреждён: `giveUp` тоже живёт внутри
   * прохода.
   *
   * У досмотра первого прохода нет НАРОЧНО (см. `startRecoverySweep`):
   * его работу при подъёме делает `recoverAfterRestart`, и второй раз
   * она была бы вредна. У продления такого второго входа нет — значит
   * довод досмотра здесь не работает, и первый проход нужен.
   */
  it('первый проход идёт при подъёме, а не через час', async () => {
    await payingPerson({ periodEnd: new Date('2026-10-01T10:00:00.000Z') });

    const rk = robokassa('OK1234');
    const stop = startRenewals(
      {
        db: testDb(),
        logger,
        robokassa: rk.deps,
        settings,
        now: () => new Date('2026-09-30T12:00:00.000Z'),
      },
      // Шаг настоящий, часовой: проверка должна доказать, что списание
      // ушло ДО первого тика, а не подкрутить таймер до миллисекунды.
      RENEWAL_TICK_MS,
    );

    try {
      await vi.waitFor(
        () => {
          expect(rk.asked).toHaveLength(1);
        },
        { timeout: 5_000, interval: 10 },
      );
    } finally {
      stop();
    }
  });

  it('первый проход при подъёме не берёт денег второй раз', async () => {
    /**
     * **Главный вопрос к первому проходу**, и отвечает на него база, а
     * не рассуждение. Так выглядит выкладка посреди суток списания:
     * старый процесс уже списал Миле, новый поднялся и первым же делом
     * пошёл по той же выборке.
     *
     * Вера здесь маяк: ей списать ещё можно, и её списание означает, что
     * первый проход прошёл выборку целиком, а не остановился раньше
     * Милы. Без маяка проверка ждала бы «чтобы ничего не случилось» —
     * то есть зеленела бы и на невыполненном проходе.
     */
    const вера = await upsertUser(testDb(), { tgId: 4_400_002, firstName: 'Вера' });

    // Мила продлевается сегодня, Вера — сутками позже. Так старый
    // процесс берёт только Милу, а выкладка назавтра застаёт обеих.
    await payingPerson({ periodEnd: new Date('2026-10-01T10:00:00.000Z') });
    await payingPerson({
      periodEnd: new Date('2026-10-02T10:00:00.000Z'),
      who: вера.id,
      ref: 'second',
      externalId: '5002',
    });

    const rk = robokassa('OK1234');
    const depsAt = (moment: string) => ({
      db: testDb(),
      logger,
      robokassa: rk.deps,
      settings,
      now: () => new Date(moment),
    });

    // Старый процесс списал Миле и умер.
    await runRenewals(depsAt('2026-09-30T12:00:00.000Z'));
    expect(rk.asked).toHaveLength(1);

    /**
     * Выкладка сутки спустя. Срок Милы к этому моменту уже прошёл, и от
     * второго списания её держит только заведённое продление: подписка
     * по-прежнему `active`, а `currentPeriodEnd` по-прежнему подходит
     * под условие выборки.
     */
    const stop = startRenewals(depsAt('2026-10-01T12:00:00.000Z'), RENEWAL_TICK_MS);

    try {
      await vi.waitFor(
        () => {
          expect(rk.asked).toHaveLength(2);
        },
        { timeout: 5_000, interval: 10 },
      );
    } finally {
      stop();
    }

    /**
     * Мила заплатила один раз: одно продление в базе и разные номера в
     * двух отправках. Считаем отправки, а не записи, — платит отправка.
     */
    const мила = await testDb()
      .select()
      .from(billingInvoices)
      .where(and(eq(billingInvoices.userId, userId), eq(billingInvoices.kind, 'renewal')));

    expect(мила).toHaveLength(1);
    expect(new Set(rk.asked.map((one) => one.get('InvoiceID'))).size).toBe(2);
  });
});
