import { describe, expect, it } from 'vitest';

import { collectCost, type DumpCall } from './cost-per-dump.js';

/**
 * Себестоимость выгрузки (задача 2.21).
 *
 * Проверяется главное свойство отчёта: он не превращает незнание в ноль.
 * Выгрузка с неизвестной ценой хотя бы одного вызова не входит в среднюю,
 * а считается отдельно — иначе отсутствие прайс-листа выглядело бы как
 * дешёвый разбор, и цену подписки назначили бы по нему.
 */

const call = (over: Partial<DumpCall> = {}): DumpCall => ({
  batchId: 'выгрузка-1',
  stage: 'classifier',
  model: 'yandex:yandexgpt/latest',
  tokensIn: 1000,
  tokensOut: 500,
  audioSeconds: null,
  costMicros: 1_000_000,
  costCurrency: 'rub',
  ...over,
});

describe('объёмы', () => {
  it('считаются на выгрузку, а не на вызов', () => {
    const report = collectCost([
      call({ batchId: 'а', stage: 'speech', audioSeconds: 60, tokensIn: null, tokensOut: null }),
      call({ batchId: 'а', stage: 'extractor', tokensIn: 800, tokensOut: 300 }),
      call({ batchId: 'а', stage: 'classifier', tokensIn: 2200, tokensOut: 1100 }),
      call({ batchId: 'б', stage: 'extractor', tokensIn: 400, tokensOut: 100 }),
    ]);

    expect(report.dumps).toBe(2);
    expect(report.tokensIn.average).toBe((3000 + 400) / 2);
    expect(report.audioSeconds.average).toBe(30);
  });

  it('вызовы без выгрузки считаются отдельно и в среднюю не идут', () => {
    // Так выглядят вызовы, чья выгрузка удалена по §16, и прогоны стенда.
    const report = collectCost([
      call({ batchId: 'а', tokensIn: 1000 }),
      call({ batchId: null, tokensIn: 9999 }),
    ]);

    expect(report.dumps).toBe(1);
    expect(report.unlinkedCalls).toBe(1);
    expect(report.tokensIn.average).toBe(1000);
  });

  it('вызовы без выгрузки не раздувают разбивку по стадиям', () => {
    // Поймано на живых данных: в базе стенда лежали вызовы прошлых
    // прогонов без привязки, и разбивка разделила их на три выгрузки,
    // показав у классификации в десять раз больше токенов. Итог на
    // выгрузку был при этом верным — то есть врало ровно то место, куда
    // смотрят, решая, какая стадия дорогая.
    const report = collectCost([
      call({ batchId: 'а', stage: 'classifier', tokensIn: 2200, tokensOut: 1100 }),
      call({ batchId: null, stage: 'classifier', tokensIn: 90_000, tokensOut: 40_000 }),
    ]);

    const classifier = report.byStage.find((one) => one.stage === 'classifier');
    expect(classifier?.tokensIn).toBe(2200);
    expect(classifier?.calls).toBe(1);
    expect(report.unlinkedCalls).toBe(1);
  });

  it('90-й процентиль берёт настоящую тяжёлую выгрузку, а не среднее между двумя', () => {
    const calls = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100].map((seconds, index) =>
      call({
        batchId: `в-${String(index)}`,
        stage: 'speech',
        audioSeconds: seconds,
        tokensIn: null,
        tokensOut: null,
      }),
    );

    const report = collectCost(calls);

    expect(report.audioSeconds.p90).toBe(9);
    expect(report.audioSeconds.max).toBe(100);
  });
});

describe('стоимость', () => {
  it('считается по выгрузкам с полностью известной ценой', () => {
    const report = collectCost([
      call({ batchId: 'а', costMicros: 2_000_000 }),
      call({ batchId: 'б', costMicros: 4_000_000 }),
    ]);

    expect(report.cost?.average).toBe(3_000_000);
    expect(report.cost?.currency).toBe('rub');
    expect(report.dumpsWithUnknownPrice).toBe(0);
  });

  it('выгрузка с одним неизвестным вызовом в среднюю не входит', () => {
    // Ключевое свойство: незнание не превращается в ноль. Иначе выгрузка
    // с неизвестной ценой расшифровки выглядела бы дешевле настоящей.
    const report = collectCost([
      call({ batchId: 'а', costMicros: 2_000_000 }),
      call({
        batchId: 'б',
        stage: 'speech',
        audioSeconds: 90,
        costMicros: null,
        costCurrency: null,
        model: 'yandex:general',
      }),
      call({ batchId: 'б', costMicros: 2_000_000 }),
    ]);

    expect(report.cost?.dumps).toBe(1);
    expect(report.cost?.average).toBe(2_000_000);
    expect(report.dumpsWithUnknownPrice).toBe(1);
    expect(report.modelsWithoutPrice).toEqual(['yandex:general']);
    // Объёмы при этом известны у обеих: их и надо умножать на цену.
    expect(report.dumps).toBe(2);
    expect(report.audioSeconds.average).toBe(45);
  });

  it('без единой известной цены стоимости нет вовсе', () => {
    const report = collectCost([call({ costMicros: null, costCurrency: null })]);

    expect(report.cost).toBeUndefined();
    expect(report.dumps).toBe(1);
  });

  it('разные валюты не складываются', () => {
    // Сумма долларов с рублями не значит ничего, а выбрать одну за
    // пользователя мы не вправе: курс на дату вызова не восстановить.
    const report = collectCost([
      call({ batchId: 'а', costMicros: 1_000_000, costCurrency: 'rub' }),
      call({ batchId: 'б', costMicros: 1_000_000, costCurrency: 'usd' }),
    ]);

    expect(report.cost).toBeUndefined();
  });
});

describe('разбивка по стадиям', () => {
  it('показывает, чем именно платим за выгрузку', () => {
    const report = collectCost([
      call({ batchId: 'а', stage: 'speech', audioSeconds: 80, tokensIn: null, tokensOut: null }),
      call({ batchId: 'а', stage: 'router', tokensIn: 1100, tokensOut: 250 }),
      call({ batchId: 'а', stage: 'embedder', tokensIn: 120, tokensOut: null }),
    ]);

    const stages = new Map(report.byStage.map((one) => [one.stage, one]));
    expect(stages.get('speech')?.audioSeconds).toBe(80);
    expect(stages.get('router')?.tokensIn).toBe(1100);
    expect(stages.get('embedder')?.tokensIn).toBe(120);
  });

  it('у стадии с неизвестной ценой стоимость не показывается', () => {
    const report = collectCost([
      call({ stage: 'speech', costMicros: null, costCurrency: null, model: 'yandex:general' }),
    ]);

    expect(report.byStage[0]?.micros).toBeUndefined();
    expect(report.byStage[0]?.unknownPrices).toBe(1);
  });
});
