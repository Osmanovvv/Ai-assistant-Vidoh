import { beforeEach, describe, expect, it } from 'vitest';

import {
  appSettings,
  billingInvoices,
  billingPriceChanges,
  billingSubscriptions,
  users,
} from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { putSetting, SettingsRegistry } from '../settings/settings.repo.js';
import { upsertUser } from '../users/users.repo.js';
import { createInvoice, nextInvId } from './billing.repo.js';
import {
  effectivePriceAt,
  PRICE_CHANGE_NOTICE_MS,
  syncPriceChanges,
  type PriceChangeNotice,
} from './price-change.service.js';
import { ROBOKASSA_RAIL } from './renewal.service.js';
import { applyPaymentEvent } from './subscription.service.js';

/**
 * Изменение цены для действующих подписок — правило 30 дней (оферта
 * п. 7.8; письмо Робокассы от 11.09.2026: «изменения цены без
 * предупреждения — избегайте»).
 */
const logger = createLogger({ level: 'silent' });
const DAY = 24 * 3_600_000;
const NOW = new Date('2026-10-01T10:00:00.000Z');

let settings: SettingsRegistry;
let userId = '';

function recorder(): {
  told: PriceChangeNotice[];
  notify: (n: PriceChangeNotice) => Promise<void>;
} {
  const told: PriceChangeNotice[] = [];
  return {
    told,
    notify: (notice) => {
      told.push(notice);
      return Promise.resolve();
    },
  };
}

async function subscriber(who: string, periodEnd: Date, autoRenew = true): Promise<void> {
  const ref = `first-${who}`;
  await createInvoice(testDb(), {
    provider: ROBOKASSA_RAIL,
    userId: who,
    plan: 'monthly',
    kind: 'initial',
    amountMinor: 39_900,
    currency: 'RUB',
    ref,
    invId: await nextInvId(testDb()),
    autoRenew,
  });
  await applyPaymentEvent(testDb(), {
    provider: ROBOKASSA_RAIL,
    event: {
      kind: 'paid',
      externalId: `ext-${who}`,
      ref,
      amount: 39_900,
      currency: 'RUB',
      renewal: false,
      paidUntil: periodEnd,
    },
  });
}

async function sync(now: Date, told = recorder()) {
  const result = await syncPriceChanges(
    { db: testDb(), settings, logger, notify: told.notify },
    { now },
  );
  return { result, told: told.told };
}

beforeEach(async () => {
  await testDb().delete(billingPriceChanges);
  await testDb().delete(billingSubscriptions);
  await testDb().delete(billingInvoices);
  await testDb().delete(appSettings);
  await testDb().delete(users);

  userId = (await upsertUser(testDb(), { tgId: 4_500_001, firstName: 'Мила' })).id;
  settings = new SettingsRegistry({ db: testDb(), logger, ttlMs: 0 });
  await putSetting(testDb(), { name: 'priceMonthlyRub', value: '39900' });
});

describe('цена для продлений — по оферте п. 7.8', () => {
  it('первая замеченная цена вступает в силу сразу и никого не беспокоит', async () => {
    const { result, told } = await sync(NOW);

    expect(result).toEqual({ seeded: 1, announced: 0, notified: 0, canceled: 0 });
    expect(told).toEqual([]);
    expect(
      await effectivePriceAt(testDb(), settings, {
        plan: 'monthly',
        rail: ROBOKASSA_RAIL,
        at: NOW,
      }),
    ).toEqual({ amountMinor: 39_900, currency: 'RUB' });
  });

  it('новая цена в панели: подписчики предупреждены, продления 30 дней идут по прежней', async () => {
    await subscriber(userId, new Date('2026-10-20T10:00:00.000Z'));
    await sync(NOW);
    await putSetting(testDb(), { name: 'priceMonthlyRub', value: '49900' });

    const { result, told } = await sync(new Date(NOW.getTime() + DAY));

    expect(result).toEqual({ seeded: 0, announced: 1, notified: 1, canceled: 0 });
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      userId,
      oldPrice: { amountMinor: 39_900, currency: 'RUB' },
      newPrice: { amountMinor: 49_900, currency: 'RUB' },
    });
    // Ровно через 30 дней после уведомления, не раньше.
    expect(told[0]?.effectiveAt.getTime()).toBe(NOW.getTime() + DAY + PRICE_CHANGE_NOTICE_MS);
    expect(PRICE_CHANGE_NOTICE_MS).toBe(30 * DAY);

    const at = (days: number) => new Date(NOW.getTime() + DAY + days * DAY);
    const price = (when: Date) =>
      effectivePriceAt(testDb(), settings, { plan: 'monthly', rail: ROBOKASSA_RAIL, at: when });

    expect((await price(at(0)))?.amountMinor).toBe(39_900);
    expect((await price(at(29)))?.amountMinor).toBe(39_900);
    expect((await price(at(30)))?.amountMinor).toBe(49_900);
  });

  it('второй проход ту же перемену не объявляет заново', async () => {
    await subscriber(userId, new Date('2026-10-20T10:00:00.000Z'));
    await sync(NOW);
    await putSetting(testDb(), { name: 'priceMonthlyRub', value: '49900' });
    await sync(new Date(NOW.getTime() + DAY));

    const { result, told } = await sync(new Date(NOW.getTime() + 2 * DAY));

    expect(result).toEqual({ seeded: 0, announced: 0, notified: 0, canceled: 0 });
    expect(told).toEqual([]);
  });

  it('предупреждаются только действующие подписки с автопродлением', async () => {
    const other = (await upsertUser(testDb(), { tgId: 4_500_002, firstName: 'Оля' })).id;
    await subscriber(userId, new Date('2026-10-20T10:00:00.000Z'));
    await subscriber(other, new Date('2026-10-20T10:00:00.000Z'), false);
    await sync(NOW);
    await putSetting(testDb(), { name: 'priceMonthlyRub', value: '49900' });

    const { told } = await sync(new Date(NOW.getTime() + DAY));

    expect(told.map((one) => one.userId)).toEqual([userId]);
  });

  it('цену вернули до вступления в силу — перемена отменена, продления как были', async () => {
    await subscriber(userId, new Date('2026-10-20T10:00:00.000Z'));
    await sync(NOW);
    await putSetting(testDb(), { name: 'priceMonthlyRub', value: '49900' });
    await sync(new Date(NOW.getTime() + DAY));
    await putSetting(testDb(), { name: 'priceMonthlyRub', value: '39900' });

    const { result } = await sync(new Date(NOW.getTime() + 2 * DAY));

    expect(result.canceled).toBe(1);
    expect(result.announced).toBe(0);
    const far = new Date(NOW.getTime() + 60 * DAY);
    expect(
      (
        await effectivePriceAt(testDb(), settings, {
          plan: 'monthly',
          rail: ROBOKASSA_RAIL,
          at: far,
        })
      )?.amountMinor,
    ).toBe(39_900);
  });

  it('снижение — тоже через уведомление и 30 дней: оферта не различает направления', async () => {
    await subscriber(userId, new Date('2026-10-20T10:00:00.000Z'));
    await sync(NOW);
    await putSetting(testDb(), { name: 'priceMonthlyRub', value: '29900' });

    const { result, told } = await sync(new Date(NOW.getTime() + DAY));

    expect(result.announced).toBe(1);
    expect(told[0]?.newPrice.amountMinor).toBe(29_900);
    expect(
      (
        await effectivePriceAt(testDb(), settings, {
          plan: 'monthly',
          rail: ROBOKASSA_RAIL,
          at: NOW,
        })
      )?.amountMinor,
    ).toBe(39_900);
  });

  it('тариф снят (ноль в панели) — продлевать нечем, истории это не трогает', async () => {
    await sync(NOW);
    await putSetting(testDb(), { name: 'priceMonthlyRub', value: '0' });

    const { result } = await sync(new Date(NOW.getTime() + DAY));

    expect(result).toEqual({ seeded: 0, announced: 0, notified: 0, canceled: 0 });
    expect(
      await effectivePriceAt(testDb(), settings, {
        plan: 'monthly',
        rail: ROBOKASSA_RAIL,
        at: NOW,
      }),
    ).toBeUndefined();
  });
});
