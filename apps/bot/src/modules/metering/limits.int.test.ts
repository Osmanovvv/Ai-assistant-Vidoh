import { beforeEach, describe, expect, it } from 'vitest';

import { aiCalls, users } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import { checkSpend, limitFromEnv, periodStart } from './limits.js';

/**
 * Мягкий лимит расхода (§10.5 ТЗ, задача 2.22).
 *
 * Проверяется то, из-за чего лимит может навредить вместо пользы:
 * расчётный период, чужая валюта и неизвестная цена. Само переключение
 * на лёгкую модель проверяется в разборе выгрузки целиком — там видно,
 * что человек ничего не замечает.
 */

const LIMIT = { micros: 10_000_000, currency: 'rub' as const };

let userId: string;

async function record(options: {
  readonly micros?: number | undefined;
  readonly currency?: 'rub' | 'usd' | undefined;
  readonly at?: Date | undefined;
  /** Сорвавшийся вызов: у него цены нет и быть не может. */
  readonly ok?: boolean | undefined;
}): Promise<void> {
  await testDb()
    .insert(aiCalls)
    .values({
      userId,
      stage: 'classifier',
      model: 'модель',
      latencyMs: 10,
      ok: options.ok ?? true,
      ...(options.micros === undefined
        ? {}
        : { costMicros: options.micros, costCurrency: options.currency ?? 'rub' }),
      ...(options.at === undefined ? {} : { createdAt: options.at }),
    });
}

beforeEach(async () => {
  await testDb().delete(aiCalls);
  await testDb().delete(users);
  const user = await upsertUser(testDb(), { tgId: 4_100_001, firstName: 'Лимит' });
  userId = user.id;
});

describe('расчётный период', () => {
  it('начинается с первого числа месяца', () => {
    expect(periodStart(new Date('2026-08-26T18:00:00.000Z')).toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });

  it('расход прошлого месяца в лимит не входит', async () => {
    // Иначе человек, потративший много в августе, деградировал бы и в
    // сентябре, и в октябре — лимит превратился бы в наказание.
    const now = new Date('2026-09-10T12:00:00.000Z');
    await record({ micros: 12_000_000, at: new Date('2026-08-20T12:00:00.000Z') });

    const verdict = await checkSpend(testDb(), { userId, now, limit: LIMIT });

    expect(verdict.spentMicros).toBe(0);
    expect(verdict.exceeded).toBe(false);
  });

  it('расход этого месяца складывается', async () => {
    const now = new Date('2026-08-26T18:00:00.000Z');
    await record({ micros: 6_000_000, at: new Date('2026-08-02T10:00:00.000Z') });
    await record({ micros: 5_000_000, at: new Date('2026-08-25T10:00:00.000Z') });

    const verdict = await checkSpend(testDb(), { userId, now, limit: LIMIT });

    expect(verdict.spentMicros).toBe(11_000_000);
    expect(verdict.exceeded).toBe(true);
    expect(verdict.blind).toBe(false);
  });
});

describe('когда лимит работать не может', () => {
  it('неизвестная цена хотя бы одного вызова делает лимит слепым', async () => {
    const now = new Date('2026-08-26T18:00:00.000Z');
    await record({ micros: 12_000_000, at: new Date('2026-08-10T10:00:00.000Z') });
    await record({ at: new Date('2026-08-11T10:00:00.000Z') });

    const verdict = await checkSpend(testDb(), { userId, now, limit: LIMIT });

    // Потрачено больше лимита, но признать это превышением нельзя:
    // сумма — нижняя оценка. Деградация из-за пустого прайс-листа
    // ударила бы по человеку за нашу недоделку.
    expect(verdict.blind).toBe(true);
    expect(verdict.exceeded).toBe(false);
  });

  it('а сорвавшийся вызов лимит слепым НЕ делает — иначе один таймаут выключал бы §10.5', async () => {
    /**
     * Ревизия панели, и находка оказалась дороже, чем выглядела.
     *
     * `blind` включается, когда цена **модели** неизвестна: тогда сумма —
     * нижняя оценка, и признать превышение нельзя. Но считалось это как
     * «цены нет», без условия на успех, а у отказа цены нет и быть не
     * может: 403, таймаут и обрыв не тарифицируются, `callCost` на пустом
     * ответе возвращает `null`.
     *
     * Следствие было не косметическим. `blind` запрещает `exceeded`
     * (см. `checkSpend`), значит **один сорвавшийся вызов выключал
     * суточный лимит расхода этому человеку на весь период** — а сбои
     * модели случаются штатно, ради них и написаны повторы. Лимит §10.5
     * молча не работал именно тогда, когда он нужнее всего: в день,
     * когда модель отвечает плохо.
     */
    const now = new Date('2026-08-26T18:00:00.000Z');

    // Потрачено больше лимита — и всё это известной ценой.
    await record({ micros: 12_000_000, at: new Date('2026-08-10T10:00:00.000Z') });
    // Плюс сбой: он не стоил ничего и знания о расходе не отнимает.
    await record({ ok: false, at: new Date('2026-08-11T10:00:00.000Z') });

    const verdict = await checkSpend(testDb(), { userId, now, limit: LIMIT });

    expect(verdict.blind).toBe(false);
    expect(verdict.exceeded).toBe(true);
  });

  it('расход в другой валюте тоже делает лимит слепым', async () => {
    // Лимит в рублях ничего не говорит о расходе в долларах, а курс на
    // дату вызова задним числом не восстановить.
    const now = new Date('2026-08-26T18:00:00.000Z');
    await record({ micros: 1_000_000, currency: 'usd', at: new Date('2026-08-10T10:00:00.000Z') });

    const verdict = await checkSpend(testDb(), { userId, now, limit: LIMIT });

    expect(verdict.blind).toBe(true);
    expect(verdict.exceeded).toBe(false);
  });
});

describe('лимит из переменной окружения', () => {
  it('рубли превращаются в микрорубли', () => {
    expect(limitFromEnv(150)).toEqual({ micros: 150_000_000, currency: 'rub' });
  });

  it('не задан — лимита нет', () => {
    expect(limitFromEnv(undefined)).toBeUndefined();
  });
});
