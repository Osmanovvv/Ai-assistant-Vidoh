import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express, { type Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { billingEvents, billingInvoices, billingSubscriptions, users } from '../db/schema.js';
import { testDb } from '../test/db.js';
import { createInvoice, nextInvId, subscriptionOf } from '../modules/billing/billing.repo.js';
import { createRobokassaProvider } from '../modules/billing/providers/robokassa.js';
import { resultSignature } from '../modules/billing/providers/robokassa-signature.js';
import { upsertUser } from '../modules/users/users.repo.js';
import { createBillingRouter, ROBOKASSA_RESULT_PATH } from './billing.js';

/**
 * Приём уведомления об оплате целиком (§14 ТЗ, задача 4.2).
 *
 * Путь от запроса до продлённой подписки: разбор, проверка подписи,
 * идемпотентность, ответ. Половинки этого проверены по отдельности —
 * подпись в провайдере, идемпотентность в службе, — но между ними есть
 * шов, и он тут: что именно приходит от express в `readEvent` и что
 * уходит обратно Робокассе.
 *
 * **Ответ проверяется сырым текстом, а не статусом.** Робокасса ждёт
 * ровно `OK<номер>`; двухсотка с чем угодно другим означает для неё
 * «не доставлено», и она будет повторять.
 */

const DEPS = { merchantLogin: 'выдох', password1: 'п1', password2: 'п2' };

let userId = '';
let base = '';
const running: Server[] = [];

async function listen(app: Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => {
      resolve(started);
    });
  });

  running.push(server);
  const { port } = server.address() as AddressInfo;

  return `http://127.0.0.1:${String(port)}`;
}

/**
 * Уведомление с настоящей подписью.
 *
 * Метка латиницей нарочно: значение Shp_-параметра с кириллицей наш же
 * валидатор отвергает — двоеточие и посторонние знаки ломают подпись.
 * Поймано этой самой проверкой на первом прогоне.
 */
function signed(params: {
  readonly outSum: string;
  readonly invId: string;
  readonly ref: string;
}): Record<string, string> {
  const userParams = { Shp_kind: 'initial', Shp_ref: params.ref };

  return {
    OutSum: params.outSum,
    InvId: params.invId,
    ...userParams,
    SignatureValue: resultSignature({
      outSum: params.outSum,
      invId: params.invId,
      password2: DEPS.password2,
      userParams,
    }),
  };
}

beforeEach(async () => {
  await testDb().delete(billingEvents);
  await testDb().delete(billingSubscriptions);
  await testDb().delete(billingInvoices);
  await testDb().delete(users);

  const person = await upsertUser(testDb(), { tgId: 4_300_001, firstName: 'Аня' });
  userId = person.id;

  const app = express();
  app.use(createBillingRouter({ db: testDb(), robokassa: createRobokassaProvider(DEPS) }));

  base = await listen(app);

  await createInvoice(testDb(), {
    provider: 'robokassa:smz',
    userId,
    plan: 'monthly',
    kind: 'initial',
    amountMinor: 39_900,
    currency: 'RUB',
    ref: 'inv-1',
    invId: await nextInvId(testDb()),
  });
});

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

describe('уведомление доходит и продлевает подписку', () => {
  it('POST с формой: подписка появилась, ответ ровно OK<номер>', async () => {
    const response = await fetch(`${base}${ROBOKASSA_RESULT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(
        signed({ outSum: '399.000000', invId: '1001', ref: 'inv-1' }),
      ).toString(),
    });

    expect(response.status).toBe(200);
    // Сырым текстом: любое «улучшение» ответа Робокасса считает неудачей.
    expect(await response.text()).toBe('OK1001');

    const subscription = await subscriptionOf(testDb(), {
      userId,
      provider: 'robokassa:smz',
    });

    expect(subscription?.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
  });

  it('GET со строкой запроса — тоже', async () => {
    /**
     * Метод уведомления выбирает владелец магазина в личном кабинете, а
     * не мы. Поддержи мы один — однажды не получили бы ни одного
     * уведомления и искали бы причину в подписи.
     */
    const query = new URLSearchParams(signed({ outSum: '399.00', invId: '1002', ref: 'inv-1' }));

    const response = await fetch(`${base}${ROBOKASSA_RESULT_PATH}?${query.toString()}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK1002');
  });

  it('повторная доставка отвечает OK и не продлевает второй раз', async () => {
    /**
     * Условие готовности задачи, увиденное со стороны Робокассы: она
     * повторяет уведомление, пока не получит `OK`. Ответить отказом на
     * повтор значило бы позвать её повторять вечно.
     */
    const body = new URLSearchParams(
      signed({ outSum: '399.00', invId: '1003', ref: 'inv-1' }),
    ).toString();

    const send = async (): Promise<string> => {
      const response = await fetch(`${base}${ROBOKASSA_RESULT_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });

      return await response.text();
    };

    expect(await send()).toBe('OK1003');
    expect(await send()).toBe('OK1003');

    const subscription = await subscriptionOf(testDb(), { userId, provider: 'robokassa:smz' });
    const end = subscription?.currentPeriodEnd.getTime() ?? 0;

    // Месяц, а не два: разница с «сейчас» меньше сорока дней.
    expect(end - Date.now()).toBeLessThan(40 * 24 * 3_600_000);
    expect(await testDb().select().from(billingEvents)).toHaveLength(1);
  });
});

describe('подделка не проходит', () => {
  it('уведомление с чужой подписью не продлевает и не отвечает OK', async () => {
    /**
     * **Главная проверка этого пути.** Адрес нашего ResultURL знает кто
     * угодно, и продлить себе подписку бесплатно — первое, что здесь
     * попробуют.
     */
    const forged = signed({ outSum: '399.00', invId: '1004', ref: 'inv-1' });
    forged['SignatureValue'] = '0'.repeat(32);

    const response = await fetch(`${base}${ROBOKASSA_RESULT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(forged).toString(),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('OK');

    expect(await testDb().select().from(billingSubscriptions)).toHaveLength(0);
  });

  it('но попытка остаётся видна в журнале — §16', async () => {
    // Молчаливый отказ означал бы, что подделка выглядит как посторонний
    // запрос: разобрать потом «кто пытался» было бы нечем.
    const forged = signed({ outSum: '399.00', invId: '1005', ref: 'inv-1' });
    forged['OutSum'] = '1.00';

    await fetch(`${base}${ROBOKASSA_RESULT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(forged).toString(),
    });

    const events = await testDb().select().from(billingEvents);

    expect(events).toHaveLength(1);
    expect(events[0]?.signatureOk).toBe(false);
    expect(events[0]?.kind).toBe('forged');
  });

  it('посторонний запрос по адресу не роняет и не пишет в журнал', async () => {
    const response = await fetch(`${base}${ROBOKASSA_RESULT_PATH}`);

    expect(response.status).toBe(400);
    expect(await testDb().select().from(billingEvents)).toHaveLength(0);
  });
});

describe('сумма сверяется со счётом', () => {
  it('оплата не на ту сумму отвечает OK, но доступа не даёт', async () => {
    /**
     * Подпись здесь **настоящая**: это не подделка, а другая сумма.
     * `OutSum` — сумма, зачисленная магазину, и она может отличаться от
     * запрошенной. Без сверки платёж на рубль по счёту на 399 давал бы
     * полный месяц.
     *
     * Ответ `OK` — потому что уведомление доставлено, и повторять его
     * незачем: второй раз придёт та же сумма. Отказ позвал бы Робокассу
     * повторять вечно.
     */
    const response = await fetch(`${base}${ROBOKASSA_RESULT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(signed({ outSum: '1.00', invId: '1010', ref: 'inv-1' })).toString(),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK1010');

    // А подписки нет: услуга не выдана.
    expect(await testDb().select().from(billingSubscriptions)).toHaveLength(0);
  });

  it('и человеку про такую оплату не сообщают', async () => {
    // Сказать «оплата прошла» там, где доступа не дали, — худший вид
    // неправды: человек пойдёт пользоваться и упрётся в отказ.
    const said: string[] = [];

    const app = express();
    app.use(
      createBillingRouter({
        db: testDb(),
        robokassa: createRobokassaProvider(DEPS),
        onPaid: (params) => {
          said.push(params.userId);
          return Promise.resolve();
        },
      }),
    );

    const where = await listen(app);

    await fetch(`${where}${ROBOKASSA_RESULT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(signed({ outSum: '1.00', invId: '1011', ref: 'inv-1' })).toString(),
    });

    expect(said).toEqual([]);
  });
});

describe('оповещение человека не мешает ответить Робокассе', () => {
  it('упавшее оповещение не превращается в отказ', async () => {
    /**
     * Подписка уже продлена. Не ответь мы `OK` — Робокасса повторит
     * доставку, повтор отобьётся идемпотентностью, и человек не узнает
     * вообще ничего.
     */
    const app = express();
    app.use(
      createBillingRouter({
        db: testDb(),
        robokassa: createRobokassaProvider(DEPS),
        onPaid: () => Promise.reject(new Error('телеграм молчит')),
      }),
    );

    const where = await listen(app);

    const response = await fetch(`${where}${ROBOKASSA_RESULT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(
        signed({ outSum: '399.00', invId: '1006', ref: 'inv-1' }),
      ).toString(),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK1006');

    const subscription = await subscriptionOf(testDb(), { userId, provider: 'robokassa:smz' });
    expect(subscription).toBeDefined();
  });

  it('и оповещение получает того самого человека', async () => {
    const seen: string[] = [];

    const app = express();
    app.use(
      createBillingRouter({
        db: testDb(),
        robokassa: createRobokassaProvider(DEPS),
        onPaid: (params) => {
          seen.push(params.userId);
          return Promise.resolve();
        },
      }),
    );

    const where = await listen(app);

    await fetch(`${where}${ROBOKASSA_RESULT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(
        signed({ outSum: '399.00', invId: '1007', ref: 'inv-1' }),
      ).toString(),
    });

    expect(seen).toEqual([userId]);
  });
});
