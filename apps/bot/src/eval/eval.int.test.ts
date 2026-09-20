import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { eq } from 'drizzle-orm';

import { aiCalls, items, promptVersions, users } from '../db/schema.js';
import { createLogger } from '../infra/logger.js';
import { PromptRegistry } from '../modules/ai/prompts/registry.js';
import { activatePrompt, seedPrompt } from '../modules/ai/prompts/seed.js';
import { MockLlmProvider } from '../modules/ai/providers/mock.js';
import type { CompletionRequest } from '../modules/ai/providers/types.js';
import {
  CLASSIFIER_SCHEMA_NAME,
  EXTRACTOR_SCHEMA_NAME,
  RESOLVER_SCHEMA_NAME,
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

const MARKERS = {
  router: 'МАРШРУТ',
  extractor: 'ЕДИНИЦЫ',
  classifier: 'КЛАССЫ',
  resolver: 'РЕЗОЛВЕР',
} as const;

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
  deadlineText: '',
});

/** Верный ответ на каждом этапе: ровно то, что в ожидании набора. */
function answerCorrectly(request: CompletionRequest): string {
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
}

/** Модель, которая отвечает верно: ровно то, что в ожидании набора. */
function goodModel(): MockLlmProvider {
  return new MockLlmProvider({ respond: answerCorrectly });
}

/**
 * Маршрутизатор, который увёл всю выгрузку из `DUMP`: единственный отрезок
 * с намерением `PATCH`. Извлечение и классификация — верные, как у
 * `goodModel()`: дойди стенд до них, он показал бы полную точность.
 *
 * В бою до них дело не доходит: при пустом наборе отрезков `DUMP`
 * обработка кончается раньше извлечения, и человек не получает ни одной
 * записи. Стенд обязан показать ту же потерю.
 */
function routerLosesEverything(): MockLlmProvider {
  return new MockLlmProvider({
    respond: (request) =>
      stageOf(request) === 'router'
        ? JSON.stringify({
            crisis: false,
            segments: [{ intent: 'PATCH', text: request.input }],
          })
        : answerCorrectly(request),
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
    { stage: 'resolver', schema: RESOLVER_SCHEMA_NAME, marker: MARKERS.resolver },
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

describe('маршрутизатор увёл всю выгрузку из DUMP', () => {
  it('все ожидания потеряны, как и в бою, а не найдены по запасному тексту', async () => {
    // Шестой случай той же болезни: стенд мерил не то, что работает.
    // При пустом наборе отрезков `DUMP` бой не разбирает ничего, а стенд
    // подставлял текст случая и показывал «найдено 100%». Регрессия
    // промпта маршрутизатора, уводящая выгрузку из `DUMP`, оставалась бы
    // в отчёте невидимой — а человек не получал бы ни одной записи.
    const registry = await prompts();
    const cases = (await loadDataset(SYNTHETIC)).filter((item) => item.id === 'synthetic-known');

    const report = collect(await runDataset(deps(routerLosesEverything(), registry), cases));

    expect(report.found).toBe(0);
    expect(report.missed).toBe(4);
    expect(shares(report).recall).toBe(0);
    // Потеря, а не отказ: разбор прошёл, просто не оставил ничего.
    // «Разбор не удался» — про сеть и модель, и смешивать их нельзя:
    // прогон из одних таких случаев не должен выбрасываться как незамер.
    expect(report.failed).toBe(0);
    expect(report.crisisDetected).toBe(0);
  });

  it('порог ловит потерю строкой «найдено единиц»', async () => {
    const registry = await prompts();
    const cases = (await loadDataset(SYNTHETIC)).filter((item) => item.id === 'synthetic-known');

    const verdict = checkThreshold(
      collect(await runDataset(deps(routerLosesEverything(), registry), cases)),
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join(' ')).toContain('найдено единиц 0.0% ниже порога');
    expect(verdict.failures.join(' ')).toContain('(0 из 4)');
    expect(verdict.failures.join(' ')).not.toContain('разбор не удался');
  });

  it('дальше маршрутизатора денег не тратит — как бой', async () => {
    // §10.5: бой при пустом `DUMP` не зовёт ни извлечение, ни классификацию.
    // Стенд, который их зовёт, врал бы и про качество, и про себестоимость.
    const registry = await prompts();
    const cases = (await loadDataset(SYNTHETIC)).filter((item) => item.id === 'synthetic-known');

    const provider = routerLosesEverything();
    await runDataset(deps(provider, registry), cases);

    expect(provider.callCount).toBe(1);
    const stages = new Set((await testDb().select().from(aiCalls)).map((call) => call.stage));
    expect(stages).toEqual(new Set(['router']));
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

describe('след прогона', () => {
  /**
   * Прогон 17.09.2026 на живой расшифровке: срок «пройти диспансеризацию»
   * остался неделей 21.09, хотя правило названного месяца в коде есть.
   * Отчёт хранил только числа — и по нему нельзя было понять, что
   * именно дошло до правила: слова единицы, текст модели, её цитата
   * срока. Число без объясняющей строки — не доказательство, поэтому
   * исход случая несёт след: вход извлечения, единицы и сырой ответ
   * классификации до правок кода.
   */
  it('исход хранит вход извлечения, единицы и сырой ответ классификации', async () => {
    const registry = await prompts();
    const cases = (await loadDataset(SYNTHETIC)).filter((item) => item.id === 'synthetic-known');

    const [outcome] = await runDataset(deps(goodModel(), registry), cases);

    expect(outcome?.trace?.dumpText).toBe(cases[0]?.text);
    expect(outcome?.trace?.units.map((unit) => unit.text)).toEqual([
      'купить продукты',
      'записаться к врачу',
      'начать бегать по утрам',
      'я ничего не успеваю',
    ]);
    expect(outcome?.trace?.fromModel[1]).toMatchObject({
      text: 'записаться к врачу',
      type: 'TASK',
      deadline: '',
      deadlineText: '',
    });
    expect(outcome?.trace?.items[1]).toMatchObject({
      text: 'записаться к врачу',
      topic: 'здоровье',
    });
  });

  it('разбор не дошёл до записей — следа нет, но исход есть', async () => {
    const registry = await prompts();
    const cases = (await loadDataset(SYNTHETIC)).filter((item) => item.id === 'synthetic-known');

    const [outcome] = await runDataset(deps(routerLosesEverything(), registry), cases);

    expect(outcome?.trace).toBeUndefined();
    expect(outcome?.result.missed).toHaveLength(4);
  });

  /**
   * Прогон 20.09.2026 на живом наборе: случай «оговорка» потерял единственное
   * ожидание, а случай «десятый голос» — два дела из восьми. В обоих след
   * начинался с `dumpText`, и **что именно сделал маршрутизатор** — увёл
   * отрезок в `PATCH`, потерял его, склеил с соседним — узнать было нечем,
   * кроме повторного платного прогона. Отрезки маршрутизатора хранятся в
   * исходе всегда, в том числе когда до записей не дошло: именно тогда они
   * и нужны.
   */
  it('исход хранит отрезки маршрутизатора — и когда до записей не дошло', async () => {
    const registry = await prompts();
    const cases = (await loadDataset(SYNTHETIC)).filter((item) => item.id === 'synthetic-known');

    const [lost] = await runDataset(deps(routerLosesEverything(), registry), cases);
    expect(lost?.routed).toEqual([{ intent: 'PATCH', text: cases[0]?.text }]);

    const [parsed] = await runDataset(deps(goodModel(), registry), cases);
    expect(parsed?.routed).toEqual([{ intent: 'DUMP', text: cases[0]?.text }]);
  });
});

describe('стенд идёт тем же путём, что бой (шестое расхождение, 20.09.2026)', () => {
  /**
   * Живой набор 20.09.2026: «во вторник надо отвести дочку к врачу, хотя
   * нет, к врачу лучше в пятницу, ещё оплатить садик до 20» —
   * маршрутизатор отдал хвост правкой. Бой: правка после мысли ищет цель
   * среди записей своей выгрузки, модель резолвера говорит «это новая
   * мысль», и хвост идёт в разбор своим проходом — «Оплатить садик»
   * появляется. Прежний стенд резолвер не звал и считал хвост потерянным:
   * четыре «потери» из восьми были такими.
   */
  const THOUGHT = 'надо продукты купить и к врачу записаться';
  const TAIL = 'ещё оплатить садик до 20';

  function routerSplitsTail(): MockLlmProvider {
    return new MockLlmProvider({
      respond: (request) => {
        switch (stageOf(request)) {
          case 'router':
            return JSON.stringify({
              crisis: false,
              segments: [
                { intent: 'DUMP', text: THOUGHT },
                { intent: 'PATCH', text: TAIL },
              ],
            });
          case 'extractor':
            return JSON.stringify({
              units: request.input.includes('садик')
                ? [unit('оплатить садик')]
                : [unit('купить продукты'), unit('записаться к врачу')],
            });
          case 'classifier':
            return JSON.stringify({
              items: request.input.includes('садик')
                ? [classified('оплатить садик', 'TASK', 'SOON', 'семья')]
                : [
                    classified('купить продукты', 'TASK', 'SOON', 'покупки'),
                    classified('записаться к врачу', 'TASK', 'SOON', 'здоровье'),
                  ],
            });
          case 'resolver':
            // Как живая модель: среди продуктов и врача садика нет.
            return JSON.stringify({
              action: 'new',
              mode: 'replace',
              itemId: '',
              confidence: 0.1,
              changes: {
                note: '',
                text: '',
                deadline: '',
                deadlineAccuracy: 'none',
                recurrenceKind: 'none',
                recurrenceInterval: 0,
                recurrenceText: '',
              },
              reason: 'это новая мысль',
            });
          default:
            return '{}';
        }
      },
    });
  }

  it('правка без цели после мысли доходит до записи вторым проходом, как в бою', async () => {
    const registry = await prompts();
    const [base] = (await loadDataset(SYNTHETIC)).filter((item) => item.id === 'synthetic-known');
    const item = {
      ...base!,
      text: `${THOUGHT}, ${TAIL}`,
      expected: {
        ...base!.expected,
        units: [
          { ...base!.expected.units[0]!, keywords: ['продукт'] },
          { ...base!.expected.units[1]!, keywords: ['врач'] },
          { ...base!.expected.units[0]!, keywords: ['садик'], topic: 'семья' },
        ],
      },
    };

    const provider = routerSplitsTail();
    const [outcome] = await runDataset(deps(provider, registry), [item]);

    expect(outcome?.failed).toBeUndefined();
    expect(outcome?.result.missed).toEqual([]);
    expect(outcome?.result.matched.map((one) => one.actual.text)).toEqual([
      'Купить продукты',
      'Записаться к врачу',
      'Оплатить садик',
    ]);
    // Бой зовёт резолвер один раз — на втором проходе, среди своей выгрузки.
    const stages = (await testDb().select().from(aiCalls)).map((call) => call.stage);
    expect(stages.filter((stage) => stage === 'resolver')).toHaveLength(1);
    // След видит оба прохода: основной и поздней мысли.
    expect(outcome?.trace?.units.map((one) => one.text)).toEqual([
      'купить продукты',
      'записаться к врачу',
      'оплатить садик',
    ]);
    expect(outcome?.routed).toEqual([
      { intent: 'DUMP', text: THOUGHT },
      { intent: 'PATCH', text: TAIL },
    ]);
  });

  it('обстановка случая — сферы и пояс — заводится у пользователя стенда, а не берётся из умолчаний', async () => {
    const registry = await prompts();
    const [base] = (await loadDataset(SYNTHETIC)).filter((item) => item.id === 'synthetic-known');
    const item = {
      ...base!,
      topics: ['учёба', 'здоровье'],
      defaultTopic: 'учёба',
      timeZone: 'Asia/Yekaterinburg',
    };

    const provider = new MockLlmProvider({
      respond: (request) => {
        if (stageOf(request) !== 'classifier') return answerCorrectly(request);
        // Что видит классификация: сферы человека — из случая, впереди
        // базовых, которые бой подсказывает следом (16.09.2026).
        expect(request.input).toContain('учёба');
        expect(request.input.indexOf('учёба')).toBeLessThan(request.input.indexOf('покупки'));
        return answerCorrectly(request);
      },
    });

    const [outcome] = await runDataset(deps(provider, registry), [item]);

    expect(outcome?.failed).toBeUndefined();
    const [user] = await testDb().select().from(users).where(eq(users.tgId, 999_000_700));
    expect(user?.timezone).toBe('Asia/Yekaterinburg');
  });

  it('второй прогон того же случая начинает с чистого пользователя стенда', async () => {
    const registry = await prompts();
    const cases = (await loadDataset(SYNTHETIC)).filter((item) => item.id === 'synthetic-known');

    await runDataset(deps(goodModel(), registry), cases);
    const [second] = await runDataset(deps(goodModel(), registry), cases);

    // Записи первого прогона не стали ни кандидатами, ни повторами.
    expect(second?.result.extra).toEqual([]);
    expect(second?.result.matched).toHaveLength(4);
    const saved = await testDb().select().from(items);
    expect(saved).toHaveLength(4);
  });
});
