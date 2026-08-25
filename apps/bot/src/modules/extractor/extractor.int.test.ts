import { beforeEach, describe, expect, it } from 'vitest';

import { aiCalls, promptVersions } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { PromptRegistry } from '../ai/prompts/registry.js';
import { activatePrompt, seedPrompt } from '../ai/prompts/seed.js';
import { MockLlmProvider } from '../ai/providers/mock.js';
import { TransientLlmError } from '../ai/providers/types.js';
import { EXTRACTOR_SCHEMA_NAME } from '../ai/schemas/index.js';
import { extractUnits } from './extractor.service.js';

/**
 * Извлечение единиц на живой базе с подменённой моделью.
 *
 * Качество самого разбора проверяется на контрольном наборе живой
 * моделью — это задачи 2.19 и 2.20. Здесь проверяется обвязка: что
 * ответ доходит, повторы схлопываются, отказ не теряет текст.
 */

const logger = createLogger({ level: 'silent' });

const unit = (text: string, extra: Record<string, boolean> = {}) => ({
  text,
  isProject: false,
  isEmotion: false,
  ...extra,
});

async function prepare(): Promise<PromptRegistry> {
  await seedPrompt(testDb(), {
    stage: 'extractor',
    version: 'extractor@1',
    prompt: 'Раздели на дела.',
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
    retry: { attempts: 2, sleep: () => Promise.resolve() },
  };
}

beforeEach(async () => {
  await testDb().delete(promptVersions);
  await testDb().delete(aiCalls);
});

describe('извлечение единиц', () => {
  it('перечисление даёт три единицы', async () => {
    // Условие готовности задачи 2.5 дословно.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        JSON.stringify({
          units: [
            unit('купить продукты'),
            unit('записаться к врачу'),
            unit('забрать из химчистки'),
          ],
        }),
      ],
    });

    const result = await extractUnits(deps(provider, prompts), {
      input: 'продукты, врач, химчистка',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.units).toHaveLength(3);
    expect(result.promptVersion).toBe('extractor@1');
  });

  it('составная цель остаётся одной единицей с признаком проекта', async () => {
    // «День рождения сына» — внутри много дел, но человек думает о ней
    // как об одном, и дробить нельзя.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [JSON.stringify({ units: [unit('день рождения сына', { isProject: true })] })],
    });

    const result = await extractUnits(deps(provider, prompts), { input: 'день рождения сына' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.isProject).toBe(true);
  });

  it('оценочная реплика помечается эмоцией, а не делом', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        JSON.stringify({ units: [unit('я вообще ничего не успеваю', { isEmotion: true })] }),
      ],
    });

    const result = await extractUnits(deps(provider, prompts), {
      input: 'я вообще ничего не успеваю',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.units[0]?.isEmotion).toBe(true);
  });

  it('схлопывает повторы, которые пропустила модель', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        JSON.stringify({
          units: [unit('конспектировать марафон'), unit('Конспектировать марафон.')],
        }),
      ],
    });

    const result = await extractUnits(deps(provider, prompts), {
      input: 'конспектировать марафон',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.units).toHaveLength(1);
    expect(result.collapsed).toBe(1);
  });

  it('пустой ответ допустим: человек мог не назвать ни одного дела', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [JSON.stringify({ units: [] })] });

    const result = await extractUnits(deps(provider, prompts), { input: 'ну ладно, спасибо' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.units).toEqual([]);
  });
});

describe('когда извлечение не удалось', () => {
  it('возвращает отказ с сырым ответом, ничего не выдумывая', async () => {
    // Замену здесь придумать нечего: любая подстановка означала бы
    // записи, которых человек не говорил. Текст пойдёт в черновик.
    const prompts = await prepare();
    const provider = new MockLlmProvider({ respond: () => 'это не json' });

    const result = await extractUnits(deps(provider, prompts), { input: 'продукты, врач' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.raw).toBe('это не json');
    expect(result.problem).toContain('JSON');
    expect(result.promptVersion).toBe('extractor@1');
  });

  it('недоступность модели пробрасывает наружу', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      failFirst: { times: 10, error: new TransientLlmError('модель занята') },
    });

    await expect(
      extractUnits(deps(provider, prompts), { input: 'продукты' }),
    ).rejects.toBeInstanceOf(TransientLlmError);
  });
});

describe('учёт расхода', () => {
  it('вызов записан с этапом extractor и версией промпта', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [JSON.stringify({ units: [] })] });

    await extractUnits(deps(provider, prompts), { input: 'мысль' });

    const [call] = await testDb().select().from(aiCalls);
    expect(call?.stage).toBe('extractor');
    expect(call?.promptVersion).toBe('extractor@1');
  });
});
