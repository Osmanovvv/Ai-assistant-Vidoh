import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { aiCalls, promptVersions } from '../db/schema.js';
import { createLogger } from '../infra/logger.js';
import { PromptRegistry } from '../modules/ai/prompts/registry.js';
import { activatePrompt, seedPrompt } from '../modules/ai/prompts/seed.js';
import { MockLlmProvider } from '../modules/ai/providers/mock.js';
import type { CompletionRequest } from '../modules/ai/providers/types.js';
import {
  CLASSIFIER_SCHEMA_NAME,
  EXTRACTOR_SCHEMA_NAME,
  ROUTER_SCHEMA_NAME,
} from '../modules/ai/schemas/index.js';
import { testDb } from '../test/db.js';
import { loadDataset, DatasetError } from './dataset.js';
import { checkThreshold, collect, format, shares } from './report.js';
import { runDataset } from './runner.js';

/**
 * Стенд контрольного набора (задача 2.19).
 *
 * Условие готовности: прогон даёт отчёт и **ненулевую разницу при
 * намеренной порче промпта**. Проверяется это здесь двумя подменёнными
 * моделями — хорошей и испорченной, — на синтетическом наборе с заранее
 * известным ответом.
 *
 * Живая модель тут не нужна и была бы вредна: стенд должен мерить разбор,
 * а сначала надо убедиться, что сам он не врёт.
 */

const logger = createLogger({ level: 'silent' });
const SYNTHETIC = join(import.meta.dirname, 'synthetic');

const MARKERS = { router: 'МАРШРУТ', extractor: 'ЕДИНИЦЫ', classifier: 'КЛАССЫ' } as const;

function stageOf(request: CompletionRequest): keyof typeof MARKERS | undefined {
  for (const [stage, marker] of Object.entries(MARKERS)) {
    if (request.prompt.includes(marker)) return stage as keyof typeof MARKERS;
  }
  return undefined;
}

const unit = (text: string) => ({ text, isProject: false, isEmotion: false });

const classified = (
  text: string,
  type: string,
  priority: string,
  topic: string,
): Record<string, unknown> => ({
  text,
  type,
  priority,
  topic,
  isProject: false,
  deadline: '',
  deadlineAccuracy: 'none',
  recurrenceKind: 'none',
  recurrenceInterval: 0,
  recurrenceText: '',
});

/** Модель, которая отвечает верно: ровно то, что в ожидании набора. */
function goodModel(): MockLlmProvider {
  return new MockLlmProvider({
    respond: (request) => {
      switch (stageOf(request)) {
        case 'router':
          return JSON.stringify({
            crisis: false,
            segments: [{ intent: 'DUMP', text: request.input }],
          });
        case 'extractor':
          return JSON.stringify({
            units: [
              unit('купить продукты'),
              unit('записаться к врачу'),
              unit('начать бегать по утрам'),
              unit('я ничего не успеваю'),
            ],
          });
        case 'classifier':
          return JSON.stringify({
            items: [
              classified('купить продукты', 'TASK', 'SOON', 'покупки'),
              classified('записаться к врачу', 'TASK', 'SOON', 'здоровье'),
              classified('начать бегать по утрам', 'DESIRE', 'NONE', 'личное'),
              classified('я ничего не успеваю', 'EMOTION', 'NONE', 'личное'),
            ],
          });
        default:
          return '{}';
      }
    },
  });
}

/**
 * Испорченная модель: желание и эмоция стали задачами, а одно дело
 * потерялось. Ровно те ошибки, ради которых стенд и нужен.
 */
function brokenModel(): MockLlmProvider {
  return new MockLlmProvider({
    respond: (request) => {
      switch (stageOf(request)) {
        case 'router':
          return JSON.stringify({
            crisis: false,
            segments: [{ intent: 'DUMP', text: request.input }],
          });
        case 'extractor':
          return JSON.stringify({
            units: [unit('купить продукты'), unit('бегать по утрам'), unit('не успеваю')],
          });
        case 'classifier':
          return JSON.stringify({
            items: [
              // Тема неверная.
              classified('купить продукты', 'TASK', 'SOON', 'личное'),
              // §6.2: желание превратилось в задачу.
              classified('бегать по утрам', 'TASK', 'NOW', 'личное'),
              // §6.3: эмоция превратилась в задачу.
              classified('не успеваю', 'TASK', 'SOON', 'личное'),
            ],
          });
        default:
          return '{}';
      }
    },
  });
}

async function prompts(): Promise<PromptRegistry> {
  const stages = [
    { stage: 'router', schema: ROUTER_SCHEMA_NAME, marker: MARKERS.router },
    { stage: 'extractor', schema: EXTRACTOR_SCHEMA_NAME, marker: MARKERS.extractor },
    { stage: 'classifier', schema: CLASSIFIER_SCHEMA_NAME, marker: MARKERS.classifier },
  ] as const;

  for (const { stage, schema, marker } of stages) {
    await seedPrompt(testDb(), {
      stage,
      version: `${stage}@eval`,
      prompt: marker,
      schemaName: schema,
    });
    await activatePrompt(testDb(), stage, `${stage}@eval`);
  }

  return new PromptRegistry(testDb(), 60_000);
}

function deps(provider: MockLlmProvider, registry: PromptRegistry) {
  return {
    ai: {
      db: testDb(),
      provider,
      prompts: registry,
      logger,
      retry: { attempts: 1, sleep: () => Promise.resolve() },
    },
    logger,
  };
}

beforeEach(async () => {
  await testDb().delete(promptVersions);
  await testDb().delete(aiCalls);
});

describe('набор', () => {
  it('читается и проверяется схемой', async () => {
    const cases = await loadDataset(SYNTHETIC);

    expect(cases.map((item) => item.id)).toEqual(['synthetic-crisis', 'synthetic-known']);
    expect(cases.find((item) => item.id === 'synthetic-known')?.expected.units).toHaveLength(4);
  });

  it('кривой файл — это отказ, а не пропуск', async () => {
    // Набор, из которого молча выпал случай, даёт завышенную оценку
    // качества, и заметить это неоткуда.
    await expect(loadDataset(join(import.meta.dirname, 'нет-такой-папки'))).rejects.toThrow();
  });

  it('пустая папка тоже отказ', async () => {
    await expect(loadDataset(import.meta.dirname)).rejects.toBeInstanceOf(DatasetError);
  });
});

describe('прогон на верной модели', () => {
  it('находит все единицы и даёт полную точность', async () => {
    const registry = await prompts();
    const cases = (await loadDataset(SYNTHETIC)).filter((item) => item.id === 'synthetic-known');

    const report = collect(await runDataset(deps(goodModel(), registry), cases));
    const result = shares(report);

    expect(report.found).toBe(4);
    expect(report.missed).toBe(0);
    expect(report.extra).toBe(0);
    expect(result.type).toBe(1);
    expect(result.topic).toBe(1);
    expect(report.falseTasksFromDesires).toBe(0);
    expect(report.falseTasksFromEmotions).toBe(0);
  });

  it('порог качества пройден', async () => {
    const registry = await prompts();
    const cases = (await loadDataset(SYNTHETIC)).filter((item) => item.id === 'synthetic-known');

    const verdict = checkThreshold(collect(await runDataset(deps(goodModel(), registry), cases)));

    expect(verdict.passed).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  it('расход прогона пишется в учёт', async () => {
    // §10.5: прогон стоит денег, и знать сколько надо.
    const registry = await prompts();
    const cases = (await loadDataset(SYNTHETIC)).filter((item) => item.id === 'synthetic-known');

    await runDataset(deps(goodModel(), registry), cases);

    const stages = new Set((await testDb().select().from(aiCalls)).map((call) => call.stage));
    expect(stages).toEqual(new Set(['router', 'extractor', 'classifier']));
  });
});

describe('порча промпта видна в отчёте', () => {
  it('испорченная модель даёт ненулевую разницу', async () => {
    // Условие готовности задачи. Стенд, который не отличает хороший
    // разбор от плохого, бесполезен — а зелёным при этом выглядит.
    const registry = await prompts();
    const cases = (await loadDataset(SYNTHETIC)).filter((item) => item.id === 'synthetic-known');

    const good = collect(await runDataset(deps(goodModel(), registry), cases));
    const bad = collect(await runDataset(deps(brokenModel(), registry), cases));

    expect(shares(bad).type).toBeLessThan(shares(good).type);
    expect(shares(bad).recall).toBeLessThan(shares(good).recall);
    expect(bad.missed).toBeGreaterThan(good.missed);
  });

  it('ложные задачи из желаний и эмоций считаются отдельно', async () => {
    // §6.2 называет это правилом, которое модели нарушают чаще всего.
    // Порог по нему жёсткий — ноль, поэтому и число, а не доля.
    const registry = await prompts();
    const cases = (await loadDataset(SYNTHETIC)).filter((item) => item.id === 'synthetic-known');

    const bad = collect(await runDataset(deps(brokenModel(), registry), cases));

    expect(bad.falseTasksFromDesires).toBe(1);
    expect(bad.falseTasksFromEmotions).toBe(1);
  });

  it('порог качества не пройден, и сказано почему', async () => {
    const registry = await prompts();
    const cases = (await loadDataset(SYNTHETIC)).filter((item) => item.id === 'synthetic-known');

    const verdict = checkThreshold(collect(await runDataset(deps(brokenModel(), registry), cases)));

    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join(' ')).toContain('желаний');
    expect(verdict.failures.join(' ')).toContain('эмоций');
  });
});

describe('кризисный контур в наборе', () => {
  it('срабатывает и останавливает разбор', async () => {
    const registry = await prompts();
    const cases = (await loadDataset(SYNTHETIC)).filter((item) => item.id === 'synthetic-crisis');

    const provider = goodModel();
    const report = collect(await runDataset(deps(provider, registry), cases));

    expect(report.crisisDetected).toBe(1);
    expect(report.crisisExpected).toBe(1);
    expect(report.crisisFalse).toBe(0);
    expect(report.crisisMissed).toBe(0);
    // Маркер сработал до модели: ни одного обращения.
    expect(provider.callCount).toBe(0);
  });

  it('ложное срабатывание считается промахом', async () => {
    const registry = await prompts();
    const cases = (await loadDataset(SYNTHETIC))
      .filter((item) => item.id === 'synthetic-crisis')
      .map((item) => ({ ...item, expected: { ...item.expected, crisis: false } }));

    const report = collect(await runDataset(deps(goodModel(), registry), cases));

    expect(report.crisisFalse).toBe(1);
  });
});

describe('отчёт', () => {
  it('содержит числа, по которым проверяется порог', async () => {
    const registry = await prompts();
    const report = collect(
      await runDataset(deps(goodModel(), registry), await loadDataset(SYNTHETIC)),
    );

    const text = format(report);

    expect(text).toContain('Точность типа');
    expect(text).toContain('Ложных задач из желаний');
    expect(text).toContain('Кризис');
    expect(text).toContain('classifier=classifier@eval');
  });

  it('показывает разницу с прошлым прогоном', async () => {
    // §10.3: прогон на каждое изменение промпта. Без сравнения с прошлым
    // числа не значат ничего.
    const registry = await prompts();
    const cases = (await loadDataset(SYNTHETIC)).filter((item) => item.id === 'synthetic-known');

    const good = collect(await runDataset(deps(goodModel(), registry), cases));
    const bad = collect(await runDataset(deps(brokenModel(), registry), cases));

    const text = format(bad, good);

    expect(text).toMatch(/п\.п\./u);
    expect(text).toContain('Ложных задач из желаний: 1  (+1)');
  });
});
