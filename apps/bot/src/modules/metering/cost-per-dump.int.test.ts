import { beforeEach, describe, expect, it } from 'vitest';

import { batches } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import { recordAiCall } from './ai-calls.repo.js';
import { costBreakdown } from './cost-breakdown.js';
import { collectCost, loadDumpCalls, withCurrentPrices } from './cost-per-dump.js';
import type { ModelPricing } from './pricing.js';

/**
 * Выборка себестоимости (задача 2.21; ревизия этапов 1–2, дефект №11).
 *
 * Строка учёта означает отправку (§10.5), и сорвавшаяся лежит в таблице
 * рядом с удавшейся. У неё нет ни объёма, ни цены — и не потому, что мы
 * не смогли посчитать, а потому, что платить было не за что. Отчёт,
 * который читает таблицу без разбора, делает из этого две лжи разом:
 * модель с ценой в прайсе объявляется «без цены», а выгрузка с одним
 * сбоем выпадает из средней и 90-го процентиля. Одного отказа за всё
 * время хватает, а по этой средней назначается цена подписки.
 *
 * Сорвавшаяся отправка, за которую **платили** — звук приняли, результат
 * не доехал, — наоборот, обязана остаться: выбросить её значит занизить
 * себестоимость ровно на переплату.
 *
 * Строки пишутся тем же `recordAiCall`, что и в бою: проверяется не
 * придуманная форма отказа, а та, которую учёт кладёт на самом деле.
 */

const RUB = 1_000_000;

/** Цены заданы так, что ответ считается в уме: минута звука — 6 ₽. */
const pricing: Readonly<Record<string, ModelPricing>> = {
  'yandex:yandexgpt/latest': {
    kind: 'tokens',
    currency: 'rub',
    inputPerMillion: 1000,
    outputPerMillion: 1000,
  },
  'yandex:general': { kind: 'audio', currency: 'rub', perMinute: 6 },
};

let userId = '';
let voiceDump = '';
let textDump = '';

async function record(input: {
  readonly batchId: string;
  readonly stage: 'speech' | 'classifier';
  readonly usage: { tokensIn?: number; tokensOut?: number; audioSeconds?: number };
  readonly ok: boolean;
  readonly error?: string;
}): Promise<void> {
  await recordAiCall(testDb(), {
    context: {
      stage: input.stage,
      model: input.stage === 'speech' ? 'yandex:general' : 'yandex:yandexgpt/latest',
      userId,
      batchId: input.batchId,
    },
    usage: input.usage,
    latencyMs: 100,
    ok: input.ok,
    ...(input.error === undefined ? {} : { error: input.error }),
    pricing,
  });
}

beforeEach(async () => {
  const user = await upsertUser(testDb(), { tgId: 500, firstName: 'Аня' });
  userId = user.id;

  const sown = await testDb()
    .insert(batches)
    .values([
      { userId, status: 'done' as const },
      { userId, status: 'done' as const },
    ])
    .returning({ id: batches.id });

  voiceDump = sown[0]?.id ?? '';
  textDump = sown[1]?.id ?? '';

  /**
   * Голосовая выгрузка с двумя сбоями внутри: первая отправка звука
   * принята и оплачена, но результат не доехал (30 секунд); вторая удалась
   * (60 секунд). У классификатора первая отправка получила 429 — пустой
   * расход, платить было не за что, — вторая удалась.
   */
  await record({
    batchId: voiceDump,
    stage: 'speech',
    usage: { audioSeconds: 30 },
    ok: false,
    error: 'таймаут',
  });
  await record({ batchId: voiceDump, stage: 'speech', usage: { audioSeconds: 60 }, ok: true });
  await record({ batchId: voiceDump, stage: 'classifier', usage: {}, ok: false, error: '429' });
  await record({ batchId: voiceDump, stage: 'classifier', usage: { tokensIn: 1000 }, ok: true });

  // Текстовая выгрузка без сбоев — соседка, с которой считается средняя.
  await record({ batchId: textDump, stage: 'classifier', usage: { tokensIn: 1000 }, ok: true });
});

describe('выборка себестоимости', () => {
  it('сорвавшаяся отправка без расхода не делает модель «без цены» и не выбрасывает выгрузку', async () => {
    const rows = await loadDumpCalls(testDb(), undefined);
    const report = collectCost(withCurrentPrices(rows, pricing).calls);

    // Цена yandexgpt в прайсе есть — и отчёт не вправе говорить обратное.
    expect(report.modelsWithoutPrice).toEqual([]);
    // Выгрузка со сбоем остаётся в средней: сбой не сделал её цену неизвестной.
    expect(report.dumps).toBe(2);
    expect(report.dumpsWithUnknownPrice).toBe(0);
    expect(report.cost?.dumps).toBe(2);
    // У стадии цена показана, а не «неизвестна».
    expect(report.byStage.find((one) => one.stage === 'classifier')?.micros).toBe(1 * RUB);
    // Пять отправок в таблице, четыре оплаченных: пустой отказ не в счёт.
    expect(rows).toHaveLength(4);
  });

  it('сорвавшаяся отправка, за которую платили, остаётся в себестоимости', async () => {
    const rows = await loadDumpCalls(testDb(), undefined);
    const report = collectCost(withCurrentPrices(rows, pricing).calls);

    // 30 оплаченных секунд отказа плюс 60 удавшихся — это и есть расход выгрузки.
    expect(report.audioSeconds.max).toBe(90);
    // Голосовая: 3 ₽ + 6 ₽ звука + 1 ₽ токенов; текстовая: 1 ₽.
    expect(report.cost?.max).toBe(10 * RUB);
    expect(report.cost?.average).toBe(5.5 * RUB);
  });

  it('на одних данных панель и скрипт называют одну себестоимость', async () => {
    /**
     * Панель делит привязанный расход на число выгрузок и считает «без
     * цены» условием из `unpriced.ts`; скрипт считал по своему условию, и
     * два отчёта об одних деньгах расходились без способа их свести.
     */
    const panel = await costBreakdown(testDb(), { since: new Date(Date.now() - 60_000) });
    const rows = await loadDumpCalls(testDb(), undefined);
    const script = collectCost(withCurrentPrices(rows, pricing).calls);

    expect(panel.complete).toBe(true);
    expect(panel.dumps).toBe(script.dumps);
    expect(panel.perDump).toEqual([{ currency: 'rub', micros: script.cost?.average }]);
  });

  it('ограничение по дате действует', async () => {
    // Иначе «последние 30 дней» молча считались бы за весь учёт.
    expect(await loadDumpCalls(testDb(), new Date(Date.now() + 60_000))).toHaveLength(0);
    expect(await loadDumpCalls(testDb(), new Date(Date.now() - 60_000))).toHaveLength(4);
  });
});
