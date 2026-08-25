import { beforeEach, describe, expect, it } from 'vitest';

import { aiCalls } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import { meterCall, recordAiCall, spendByUser } from './ai-calls.repo.js';
import type { ModelPricing } from './pricing.js';

const pricing: Readonly<Record<string, ModelPricing>> = {
  'main-model': { kind: 'tokens', currency: 'usd', inputPerMillion: 3, outputPerMillion: 15 },
  'speech-model': { kind: 'audio', currency: 'usd', perMinute: 0.006 },
  'rub-model': { kind: 'tokens', currency: 'rub', inputPerMillion: 200, outputPerMillion: 600 },
};

let userId: string;

beforeEach(async () => {
  const user = await upsertUser(testDb(), { tgId: 500, firstName: 'Аня' });
  userId = user.id;
});

describe('recordAiCall', () => {
  it('записывает успешный вызов со стоимостью', async () => {
    await recordAiCall(testDb(), {
      context: { stage: 'classifier', model: 'main-model', userId },
      usage: { tokensIn: 4_300, tokensOut: 1_150 },
      latencyMs: 1_200,
      ok: true,
      pricing,
    });

    const [row] = await testDb().select().from(aiCalls);
    expect(row?.stage).toBe('classifier');
    expect(row?.tokensIn).toBe(4_300);
    expect(row?.costMicros).toBe(30_150);
    // Сумма без валюты бессмысленна, поэтому пишутся обе или ни одна.
    expect(row?.costCurrency).toBe('usd');
    expect(row?.ok).toBe(true);
    expect(row?.error).toBeNull();
  });

  it('записывает расход по аудио', async () => {
    await recordAiCall(testDb(), {
      context: { stage: 'speech', model: 'speech-model', userId },
      usage: { audioSeconds: 120 },
      latencyMs: 5_000,
      ok: true,
      pricing,
    });

    const [row] = await testDb().select().from(aiCalls);
    expect(row?.audioSeconds).toBe(120);
    expect(row?.costMicros).toBe(12_000);
  });

  it('неизвестная модель пишется с null в стоимости, а не с нулём', async () => {
    await recordAiCall(testDb(), {
      context: { stage: 'router', model: 'модель-без-цены', userId },
      usage: { tokensIn: 100 },
      latencyMs: 10,
      ok: true,
      pricing,
    });

    const [row] = await testDb().select().from(aiCalls);
    expect(row?.costMicros).toBeNull();
    // Валюта тоже пустая: иначе в отчёте появился бы нулевой расход
    // в конкретной валюте вместо честного «неизвестно».
    expect(row?.costCurrency).toBeNull();
  });

  it('записывает расход в рублях, не приводя его к долларам', async () => {
    // Курс на дату вызова задним числом не восстановить, поэтому валюта
    // хранится как есть.
    await recordAiCall(testDb(), {
      context: { stage: 'router', model: 'rub-model', userId },
      usage: { tokensIn: 1_000_000 },
      latencyMs: 10,
      ok: true,
      pricing,
    });

    const [row] = await testDb().select().from(aiCalls);
    expect(row?.costMicros).toBe(200_000_000);
    expect(row?.costCurrency).toBe('rub');
  });

  it('вызов без пользователя допустим', async () => {
    await recordAiCall(testDb(), {
      context: { stage: 'embedder', model: 'main-model' },
      usage: { tokensIn: 10 },
      latencyMs: 5,
      ok: true,
      pricing,
    });

    const [row] = await testDb().select().from(aiCalls);
    expect(row?.userId).toBeNull();
  });
});

describe('meterCall', () => {
  it('возвращает результат и записывает расход', async () => {
    const value = await meterCall(
      testDb(),
      { stage: 'router', model: 'main-model', userId },
      () => Promise.resolve({ value: 'разобрано', usage: { tokensIn: 600, tokensOut: 150 } }),
      { pricing },
    );

    expect(value).toBe('разобрано');
    const [row] = await testDb().select().from(aiCalls);
    expect(row?.ok).toBe(true);
    expect(row?.tokensIn).toBe(600);
  });

  it('записывает неуспешный вызов и пробрасывает ошибку', async () => {
    // §10.5 ТЗ: учёт ведётся и по неуспешным вызовам, иначе расход
    // на повторах после сбоев не виден вообще.
    await expect(
      meterCall(
        testDb(),
        { stage: 'speech', model: 'speech-model', userId },
        () => Promise.reject(new Error('провайдер недоступен')),
        { pricing },
      ),
    ).rejects.toThrow('провайдер недоступен');

    const [row] = await testDb().select().from(aiCalls);
    expect(row?.ok).toBe(false);
    expect(row?.error).toBe('провайдер недоступен');
    expect(row?.costMicros).toBeNull();
  });

  it('замеряет задержку', async () => {
    await meterCall(
      testDb(),
      { stage: 'router', model: 'main-model', userId },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { value: null, usage: { tokensIn: 1 } };
      },
      { pricing },
    );

    const [row] = await testDb().select().from(aiCalls);
    expect(row?.latencyMs).toBeGreaterThanOrEqual(50);
  });

  it('сохраняет версию промпта', async () => {
    await meterCall(
      testDb(),
      { stage: 'extractor', model: 'main-model', userId, promptVersion: 'extractor@3' },
      () => Promise.resolve({ value: null, usage: { tokensIn: 1 } }),
      { pricing },
    );

    const [row] = await testDb().select().from(aiCalls);
    expect(row?.promptVersion).toBe('extractor@3');
  });
});

describe('spendByUser', () => {
  const since = new Date(Date.now() - 60 * 60_000);

  it('суммирует расход за период', async () => {
    for (const tokens of [1_000_000, 1_000_000]) {
      await recordAiCall(testDb(), {
        context: { stage: 'classifier', model: 'main-model', userId },
        usage: { tokensIn: tokens },
        latencyMs: 100,
        ok: true,
        pricing,
      });
    }

    const summary = await spendByUser(testDb(), userId, since);

    expect(summary.calls).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.totals).toEqual({ usd: 6_000_000 });
    expect(summary.complete).toBe(true);
  });

  it('не складывает разные валюты в одно число', async () => {
    await recordAiCall(testDb(), {
      context: { stage: 'classifier', model: 'main-model', userId },
      usage: { tokensIn: 1_000_000 },
      latencyMs: 100,
      ok: true,
      pricing,
    });
    await recordAiCall(testDb(), {
      context: { stage: 'router', model: 'rub-model', userId },
      usage: { tokensIn: 1_000_000 },
      latencyMs: 100,
      ok: true,
      pricing,
    });

    const summary = await spendByUser(testDb(), userId, since);

    // Три доллара плюс двести рублей — это не «двести три чего-то».
    expect(summary.totals).toEqual({ usd: 3_000_000, rub: 200_000_000 });
    expect(summary.complete).toBe(true);
  });

  it('считает неуспешные вызовы отдельно', async () => {
    await recordAiCall(testDb(), {
      context: { stage: 'speech', model: 'speech-model', userId },
      usage: {},
      latencyMs: 100,
      ok: false,
      error: 'таймаут',
      pricing,
    });

    const summary = await spendByUser(testDb(), userId, since);

    expect(summary.calls).toBe(1);
    expect(summary.failed).toBe(1);
    // Хотя бы одна неизвестная цена делает итог нижней оценкой,
    // а не расходом.
    expect(summary.complete).toBe(false);
    expect(summary.totals).toEqual({});
  });

  it('не учитывает вызовы старше границы', async () => {
    await recordAiCall(testDb(), {
      context: { stage: 'router', model: 'main-model', userId },
      usage: { tokensIn: 1 },
      latencyMs: 1,
      ok: true,
      pricing,
    });

    const summary = await spendByUser(testDb(), userId, new Date(Date.now() + 60_000));

    expect(summary.calls).toBe(0);
  });

  it('пустая история даёт нулевой расход', async () => {
    await expect(spendByUser(testDb(), userId, since)).resolves.toEqual({
      calls: 0,
      failed: 0,
      totals: {},
      complete: true,
    });
  });
});
