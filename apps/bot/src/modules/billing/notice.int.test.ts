import { eq } from 'drizzle-orm';
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
import { RENEWAL_NOTICE_LEAD_MS, runRenewalNotices, type RenewalNotice } from './notice.service.js';
import { ROBOKASSA_RAIL } from './renewal.service.js';
import { applyPaymentEvent } from './subscription.service.js';
import { RENEWAL_LEAD_MS, type Rail } from './tariffs.js';

/**
 * Предупреждение о предстоящем автосписании (оферта п. 7.4.1: не позднее
 * чем за 3 календарных дня; письмо Робокассы от 11.09.2026:
 * «автопродление без уведомления — избегайте»).
 */
const logger = createLogger({ level: 'silent' });
const DAY = 24 * 3_600_000;
const NOW = new Date('2026-10-01T10:00:00.000Z');

let settings: SettingsRegistry;
let userId = '';

function recorder(): { told: RenewalNotice[]; notify: (n: RenewalNotice) => Promise<void> } {
  const told: RenewalNotice[] = [];
  return {
    told,
    notify: (notice) => {
      told.push(notice);
      return Promise.resolve();
    },
  };
}

async function subscriber(params: {
  readonly who?: string;
  readonly rail?: Rail;
  readonly periodEnd: Date;
  readonly autoRenew?: boolean;
  readonly amount?: number;
}): Promise<void> {
  const who = params.who ?? userId;
  const rail = params.rail ?? ROBOKASSA_RAIL;
  const ref = `first-${who}-${rail}`;
  const stars = rail === 'telegram:stars';
  await createInvoice(testDb(), {
    provider: rail,
    userId: who,
    plan: 'monthly',
    kind: 'initial',
    amountMinor: params.amount ?? (stars ? 150 : 39_900),
    currency: stars ? 'XTR' : 'RUB',
    ref,
    ...(stars ? {} : { invId: await nextInvId(testDb()) }),
    autoRenew: params.autoRenew ?? true,
  });
  await applyPaymentEvent(testDb(), {
    provider: rail,
    event: {
      kind: 'paid',
      externalId: `ext-${who}-${rail}`,
      ref,
      amount: params.amount ?? (stars ? 150 : 39_900),
      currency: stars ? 'XTR' : 'RUB',
      renewal: false,
      paidUntil: params.periodEnd,
      ...(stars ? { subscriptionRef: `charge-${who}` } : {}),
    },
  });
}

async function run(now: Date, told = recorder()) {
  const result = await runRenewalNotices(
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

  userId = (await upsertUser(testDb(), { tgId: 4_600_001, firstName: 'Мила' })).id;
  settings = new SettingsRegistry({ db: testDb(), logger, ttlMs: 0 });
  await putSetting(testDb(), { name: 'priceMonthlyRub', value: '39900' });
});

describe('предупреждение о списании — оферта п. 7.4.1', () => {
  it('уходит за четверо суток до списания: сумма, дата, один раз на период', async () => {
    // Списание — за сутки до конца периода; предупреждение — за четверо
    // суток до списания, чтобы «не позднее чем за 3 календарных дня»
    // выполнялось и при часовом шаге прохода.
    expect(RENEWAL_NOTICE_LEAD_MS).toBe(4 * DAY);

    const periodEnd = new Date(
      NOW.getTime() + RENEWAL_LEAD_MS + RENEWAL_NOTICE_LEAD_MS - 3_600_000,
    );
    await subscriber({ periodEnd });

    const { result, told } = await run(NOW);

    expect(result).toEqual({ noticed: 1, skipped: 0 });
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      userId,
      rail: ROBOKASSA_RAIL,
      price: { amountMinor: 39_900, currency: 'RUB' },
    });
    expect(told[0]?.chargeAt.getTime()).toBe(periodEnd.getTime() - RENEWAL_LEAD_MS);

    const [row] = await testDb()
      .select({ noticedFor: billingSubscriptions.renewalNoticedFor })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.userId, userId));
    expect(row?.noticedFor?.getTime()).toBe(periodEnd.getTime());

    const again = await run(new Date(NOW.getTime() + 3_600_000));
    expect(again.told).toEqual([]);
  });

  it('до срока — молчит; после списания — тоже', async () => {
    await subscriber({ periodEnd: new Date(NOW.getTime() + 10 * DAY) });
    expect((await run(NOW)).told).toEqual([]);

    await subscriber({
      who: (await upsertUser(testDb(), { tgId: 4_600_002, firstName: 'Оля' })).id,
      periodEnd: new Date(NOW.getTime() + 3_600_000), // списание уже позади
    });
    expect((await run(NOW)).told).toEqual([]);
  });

  it('без автопродления — не о чем предупреждать', async () => {
    await subscriber({ periodEnd: new Date(NOW.getTime() + 2 * DAY), autoRenew: false });

    expect((await run(NOW)).told).toEqual([]);
  });

  it('сумма — та, что спишется в день списания, а не сегодняшняя цена панели', async () => {
    // Цену подняли, но по п. 7.8 продления 30 дней идут по прежней: в
    // предупреждении — прежняя.
    const { syncPriceChanges } = await import('./price-change.service.js');
    await syncPriceChanges(
      { db: testDb(), settings, logger, notify: () => Promise.resolve() },
      { now: new Date(NOW.getTime() - 10 * DAY) },
    );
    await putSetting(testDb(), { name: 'priceMonthlyRub', value: '49900' });
    await syncPriceChanges(
      { db: testDb(), settings, logger, notify: () => Promise.resolve() },
      { now: new Date(NOW.getTime() - 9 * DAY) },
    );
    await subscriber({ periodEnd: new Date(NOW.getTime() + 2 * DAY) });

    const { told } = await run(NOW);

    expect(told[0]?.price.amountMinor).toBe(39_900);
  });

  it('звёзды: списывает Telegram в конце периода — предупреждаем с суммой первого платежа', async () => {
    const periodEnd = new Date(NOW.getTime() + RENEWAL_NOTICE_LEAD_MS - 3_600_000);
    await subscriber({ rail: 'telegram:stars', periodEnd, amount: 150 });

    const { told } = await run(NOW);

    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      rail: 'telegram:stars',
      price: { amountMinor: 150, currency: 'XTR' },
    });
    expect(told[0]?.chargeAt.getTime()).toBe(periodEnd.getTime());
  });

  it('новый период — новое предупреждение', async () => {
    const periodEnd = new Date(NOW.getTime() + 2 * DAY);
    await subscriber({ periodEnd });
    await run(NOW);

    // Продлилось: конец периода уехал на месяц.
    const nextEnd = new Date(periodEnd.getTime() + 30 * DAY);
    await testDb()
      .update(billingSubscriptions)
      .set({ currentPeriodEnd: nextEnd })
      .where(eq(billingSubscriptions.userId, userId));

    const { told } = await run(new Date(nextEnd.getTime() - RENEWAL_LEAD_MS - 2 * DAY));

    expect(told).toHaveLength(1);
    expect(told[0]?.chargeAt.getTime()).toBe(nextEnd.getTime() - RENEWAL_LEAD_MS);
  });
});
