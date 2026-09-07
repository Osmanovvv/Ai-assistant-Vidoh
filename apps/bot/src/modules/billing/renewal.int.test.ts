import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

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
import { runRenewals, ROBOKASSA_RAIL } from './renewal.service.js';

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
async function payingPerson(params: { readonly periodEnd: Date }): Promise<void> {
  await createInvoice(testDb(), {
    provider: ROBOKASSA_RAIL,
    userId,
    plan: 'monthly',
    kind: 'initial',
    amountMinor: 39_900,
    currency: 'RUB',
    ref: 'first',
    invId: await nextInvId(testDb()),
    autoRenew: true,
  });

  await applyPaymentEvent(testDb(), {
    provider: ROBOKASSA_RAIL,
    event: {
      kind: 'paid',
      externalId: '5001',
      ref: 'first',
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
    expect(second.skipped).toBe(1);

    // Один запрос к Робокассе, а не два: считаем отправки, а не записи.
    expect(rk.asked).toHaveLength(1);
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

    const round = await runRenewals({
      db: testDb(),
      logger,
      robokassa: rk.deps,
      settings,
      now: () => new Date('2026-09-30T12:00:00.000Z'),
    });

    expect(round).toEqual({ charged: 0, failed: 0, skipped: 1 });
    expect(rk.asked).toHaveLength(0);
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

    const first = await runRenewals({ db: testDb(), logger, robokassa: rk.deps, settings, now });
    const second = await runRenewals({ db: testDb(), logger, robokassa: rk.deps, settings, now });

    expect(first.failed).toBe(1);
    // Второй проход не пробует снова: попытка на период израсходована.
    expect(second).toEqual({ charged: 0, failed: 0, skipped: 1 });
    expect(rk.asked).toHaveLength(1);
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
