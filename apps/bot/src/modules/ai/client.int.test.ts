import { asc } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { aiCalls, promptVersions } from '../../db/schema.js';
import { TransientError } from '../../infra/failures.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { requestStructured } from './client.js';
import { PromptRegistry } from './prompts/registry.js';
import { activatePrompt, seedPrompt } from './prompts/seed.js';
import { MockLlmProvider } from './providers/mock.js';
import { PermanentLlmError, TransientLlmError } from './providers/types.js';
import { EXTRACTOR_SCHEMA_NAME, type ExtractedUnits } from './schemas/index.js';

/**
 * Обращение к модели со строгой схемой, на живой базе.
 *
 * Проверяется поведение, от которого зависит, потеряется ли текст
 * человека: недоступность модели, ответ не по схеме, учёт расхода.
 * Провайдер подменён — живой вызов недетерминирован и стоит денег.
 */

const logger = createLogger({ level: 'silent' });

const PROMPT = 'Разбери поток мыслей на отдельные дела.';
const INPUT = 'надо записаться к врачу и купить продукты';

const VALID = JSON.stringify({
  units: [
    { text: 'записаться к врачу', isProject: false, isEmotion: false },
    { text: 'купить продукты', isProject: false, isEmotion: false },
  ],
});

async function prepare(): Promise<PromptRegistry> {
  await seedPrompt(testDb(), {
    stage: 'extractor',
    version: 'extractor@1',
    prompt: PROMPT,
    schemaName: EXTRACTOR_SCHEMA_NAME,
  });
  await activatePrompt(testDb(), 'extractor', 'extractor@1');

  return new PromptRegistry(testDb(), 60_000);
}

function deps(provider: MockLlmProvider, prompts: PromptRegistry) {
  return {
    db: testDb(),
    provider,
    prompts,
    logger,
    // Паузы в тестах не нужны: проверяется логика, а не терпение.
    retry: { attempts: 2, sleep: () => Promise.resolve() },
  };
}

beforeEach(async () => {
  await testDb().delete(promptVersions);
  await testDb().delete(aiCalls);
});

describe('успешный разбор', () => {
  it('возвращает разобранное значение и версию промпта', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [VALID] });

    const outcome = await requestStructured<ExtractedUnits>(deps(provider, prompts), {
      stage: 'extractor',
      input: INPUT,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.units).toHaveLength(2);
    expect(outcome.value.units[0]?.text).toBe('записаться к врачу');
    expect(outcome.promptVersion).toBe('extractor@1');
    expect(outcome.attempts).toBe(1);
  });

  it('отправляет модели активный промпт и схему из него же', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [VALID] });

    await requestStructured(deps(provider, prompts), { stage: 'extractor', input: INPUT });

    const sent = provider.requests[0];
    expect(sent?.prompt).toBe(PROMPT);
    expect(sent?.input).toBe(INPUT);
    expect(sent?.jsonSchema).toMatchObject({ type: 'object' });
  });

  it('снимает обрамление в кодовый блок', async () => {
    // Тройные кавычки вокруг JSON — частая привычка моделей. Содержимое
    // при этом верное, и терять годный разбор из-за оформления глупо.
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: ['```json\n' + VALID + '\n```'] });

    const outcome = await requestStructured<ExtractedUnits>(deps(provider, prompts), {
      stage: 'extractor',
      input: INPUT,
    });

    expect(outcome.ok).toBe(true);
    expect(provider.callCount).toBe(1);
  });
});

describe('ответ не по схеме', () => {
  it('повторяет один раз с усиленной инструкцией', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: ['{"units":"не массив"}', VALID] });

    const outcome = await requestStructured<ExtractedUnits>(deps(provider, prompts), {
      stage: 'extractor',
      input: INPUT,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(2);

    // Во второй заход промпт усилен, а не повторён дословно.
    expect(provider.requests[1]?.prompt).toContain(PROMPT);
    expect(provider.requests[1]?.prompt).toContain('строго JSON');
    expect(provider.requests[1]?.prompt.length).toBeGreaterThan(
      provider.requests[0]?.prompt.length ?? 0,
    );
  });

  it('после двух неудач возвращает отказ, а не бросает исключение', async () => {
    // §17 ТЗ: терять текст нельзя. Запись сохранится черновиком без
    // классификации, и это решает вызывающий код — поэтому здесь отказ,
    // а не исключение.
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: ['мусор', 'снова мусор'] });

    const outcome = await requestStructured<ExtractedUnits>(deps(provider, prompts), {
      stage: 'extractor',
      input: INPUT,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    expect(outcome.attempts).toBe(2);
    // Сырой ответ отдаётся наружу: он пойдёт в черновик для разбора руками.
    expect(outcome.raw).toBe('снова мусор');
    expect(outcome.problem).toContain('JSON');
    expect(outcome.promptVersion).toBe('extractor@1');
  });

  it('третьего захода не делает: он стоил бы денег и дал бы то же', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ respond: () => 'мусор' });

    await requestStructured(deps(provider, prompts), { stage: 'extractor', input: INPUT });

    expect(provider.callCount).toBe(2);
  });

  it('объясняет, чем именно ответ не подошёл', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      respond: () => JSON.stringify({ units: [{ text: 'дело', isProject: 'да' }] }),
    });

    const outcome = await requestStructured(deps(provider, prompts), {
      stage: 'extractor',
      input: INPUT,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toContain('схеме');
  });
});

describe('модель недоступна', () => {
  it('пробрасывает временную ошибку наружу', async () => {
    // Дальше работает то, что построено на первом этапе: выгрузка
    // возвращается в очередь, текст человека не теряется.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      failFirst: { times: 10, error: new TransientLlmError('модель занята') },
    });

    await expect(
      requestStructured(deps(provider, prompts), { stage: 'extractor', input: INPUT }),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it('повторяет временный сбой и доводит дело до конца', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: ['', VALID],
      failFirst: { times: 1, error: new TransientLlmError('сеть моргнула') },
    });

    const outcome = await requestStructured<ExtractedUnits>(deps(provider, prompts), {
      stage: 'extractor',
      input: INPUT,
    });

    expect(outcome.ok).toBe(true);
    expect(provider.callCount).toBe(2);
  });

  it('постоянную ошибку не повторяет', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      failFirst: { times: 10, error: new PermanentLlmError('ключ не тот') },
    });

    await expect(
      requestStructured(deps(provider, prompts), { stage: 'extractor', input: INPUT }),
    ).rejects.toThrow(/ключ не тот/u);

    expect(provider.callCount).toBe(1);
  });
});

describe('учёт расхода', () => {
  it('помечает вызов версией промпта (§10.3 ТЗ)', async () => {
    // Без этого жалобу «бот стал хуже» не с чем сопоставить.
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [VALID], tokensIn: 247, tokensOut: 582 });

    await requestStructured(deps(provider, prompts), {
      stage: 'extractor',
      input: INPUT,
      batchId: undefined,
    });

    const [call] = await testDb().select().from(aiCalls);
    expect(call?.stage).toBe('extractor');
    expect(call?.promptVersion).toBe('extractor@1');
    expect(call?.model).toBe('mock-llm');
    expect(call?.tokensIn).toBe(247);
    expect(call?.tokensOut).toBe(582);
    expect(call?.ok).toBe(true);
  });

  it('каждый заход — отдельная строка: он потрачен и оплачен', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: ['мусор', VALID] });

    await requestStructured(deps(provider, prompts), { stage: 'extractor', input: INPUT });

    const calls = await testDb().select().from(aiCalls).orderBy(asc(aiCalls.createdAt));
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.ok)).toBe(true);
  });

  it('полный отказ модели тоже записывается', async () => {
    // §10.5 ТЗ: пишется каждый вызов, включая неуспешный.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      failFirst: { times: 10, error: new PermanentLlmError('отказ') },
    });

    await expect(
      requestStructured(deps(provider, prompts), { stage: 'extractor', input: INPUT }),
    ).rejects.toThrow();

    const [call] = await testDb().select().from(aiCalls);
    expect(call?.ok).toBe(false);
    expect(call?.error).toContain('отказ');
    expect(call?.promptVersion).toBe('extractor@1');
  });
});

describe('без активной версии промпта', () => {
  it('падает внятно и до обращения к модели', async () => {
    const provider = new MockLlmProvider({ responses: [VALID] });
    const prompts = new PromptRegistry(testDb(), 60_000);

    await expect(
      requestStructured(deps(provider, prompts), { stage: 'extractor', input: INPUT }),
    ).rejects.toThrow(/Нет активной версии/u);

    // Денег не потратили.
    expect(provider.callCount).toBe(0);
    expect(await testDb().select().from(aiCalls)).toHaveLength(0);
  });
});
