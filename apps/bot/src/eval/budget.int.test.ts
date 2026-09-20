import { beforeEach, describe, expect, it } from 'vitest';

import { aiCalls } from '../db/schema.js';
import { SpendCeilingError } from '../infra/failures.js';
import type { SpendGuard } from '../modules/metering/spend-guard.js';
import { testDb, truncateAll } from '../test/db.js';
import { withRunBudget } from './budget.js';

/**
 * Страж потолка прогона (20.09.2026): три прогона по 73 ₽ при обещанных
 * «≈20–25 ₽» — потому что остановить их было нечем, кроме руки.
 */

const startedAt = new Date('2026-09-20T14:00:00.000Z');

/** Внутренний страж, который считает, сколько раз его спросили. */
function counting(): SpendGuard & { readonly asked: () => number; readonly noted: () => number } {
  let asked = 0;
  let noted = 0;
  return {
    beforeCall: () => {
      asked += 1;
      return Promise.resolve();
    },
    noteSpent: () => {
      noted += 1;
    },
    report: () => Promise.resolve([]),
    asked: () => asked,
    noted: () => noted,
  };
}

async function spent(rubles: number, at: Date): Promise<void> {
  await testDb()
    .insert(aiCalls)
    .values({
      stage: 'classifier',
      model: 'yandex:yandexgpt/latest',
      costMicros: Math.round(rubles * 1_000_000),
      costCurrency: 'rub',
      latencyMs: 1_000,
      ok: true,
      createdAt: at,
    });
}

beforeEach(async () => {
  await truncateAll();
});

describe('потолок прогона', () => {
  it('пока расход прогона ниже потолка — пропускает и спрашивает внутреннего стража', async () => {
    const inner = counting();
    const guard = withRunBudget(inner, { db: testDb(), startedAt, budgetRub: 40 });
    await spent(30, new Date('2026-09-20T14:05:00.000Z'));

    await expect(guard.beforeCall()).resolves.toBeUndefined();
    expect(inner.asked()).toBe(1);
    expect((await guard.report()).some((notice) => notice.exceeded)).toBe(false);
  });

  it('дошёл до потолка — следующий вызов не делается, и это видно в отчёте', async () => {
    const inner = counting();
    const guard = withRunBudget(inner, { db: testDb(), startedAt, budgetRub: 40 });
    await spent(25, new Date('2026-09-20T14:05:00.000Z'));
    await spent(15, new Date('2026-09-20T14:06:00.000Z'));

    await expect(guard.beforeCall()).rejects.toBeInstanceOf(SpendCeilingError);
    await expect(guard.beforeCall()).rejects.toThrow('40.00 ₽');
    // До внутреннего стража дело не дошло: вызов запрещён уже здесь.
    expect(inner.asked()).toBe(0);
    expect((await guard.report()).some((notice) => notice.exceeded)).toBe(true);
  });

  it('расход до отметки начала прогона — не его расход', async () => {
    // Сегодняшние 219 ₽ на счёте не должны запирать прогон с потолком 40:
    // потолок прогона — про этот прогон, суточный — про сутки.
    const guard = withRunBudget(counting(), { db: testDb(), startedAt, budgetRub: 40 });
    await spent(219, new Date('2026-09-20T12:00:00.000Z'));

    await expect(guard.beforeCall()).resolves.toBeUndefined();
  });

  it('потраченное передаётся внутреннему стражу', () => {
    const inner = counting();
    const guard = withRunBudget(inner, { db: testDb(), startedAt, budgetRub: 40 });

    guard.noteSpent(1_000);

    expect(inner.noted()).toBe(1);
  });
});
