import { beforeEach, describe, expect, it } from 'vitest';

import { aiCalls, promptVersions } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { PromptRegistry } from '../ai/prompts/registry.js';
import { activatePrompt, seedPrompt } from '../ai/prompts/seed.js';
import { MockLlmProvider } from '../ai/providers/mock.js';
import { TransientLlmError } from '../ai/providers/types.js';
import { ROUTER_SCHEMA_NAME } from '../ai/schemas/index.js';
import { routeIntents } from './router.service.js';

/**
 * Маршрутизатор на живой базе с подменённой моделью.
 *
 * Проверяется поведение, от которого зависит, не потеряется ли мысль:
 * порядок применения намерений, замена при неразборе, учёт расхода.
 */

const logger = createLogger({ level: 'silent' });

const THREE_INTENTS = 'Продукты купила, а ещё надо к врачу записаться, и что у меня на завтра?';

async function prepare(): Promise<PromptRegistry> {
  await seedPrompt(testDb(), {
    stage: 'router',
    version: 'router@1',
    prompt: 'Определи намерения.',
    schemaName: ROUTER_SCHEMA_NAME,
  });
  await activatePrompt(testDb(), 'router', 'router@1');

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

describe('разбор намерений', () => {
  it('фраза с тремя намерениями даёт три сегмента в правильном порядке', async () => {
    // Условие готовности задачи 2.4 дословно.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        JSON.stringify({
          crisis: false,
          segments: [
            { intent: 'COMPLETE', text: 'Продукты купила' },
            { intent: 'DUMP', text: 'а ещё надо к врачу записаться' },
            { intent: 'QUERY', text: 'и что у меня на завтра?' },
          ],
        }),
      ],
    });

    const result = await routeIntents(deps(provider, prompts), { input: THREE_INTENTS });

    expect(result.segments.map((item) => item.intent)).toEqual(['COMPLETE', 'DUMP', 'QUERY']);
    expect(result.fallback).toBe(false);
    expect(result.reordered).toBe(false);
    expect(result.promptVersion).toBe('router@1');
  });

  it('исправляет порядок, если модель вернула правку раньше исправляемого', async () => {
    const prompts = await prepare();
    const input = 'Записать сына к врачу в четверг, хотя нет, в пятницу.';
    const provider = new MockLlmProvider({
      responses: [
        JSON.stringify({
          crisis: false,
          segments: [
            { intent: 'PATCH', text: 'хотя нет, в пятницу' },
            { intent: 'DUMP', text: 'Записать сына к врачу в четверг' },
          ],
        }),
      ],
    });

    const result = await routeIntents(deps(provider, prompts), { input });

    expect(result.segments.map((item) => item.intent)).toEqual(['DUMP', 'PATCH']);
    expect(result.reordered).toBe(true);
  });

  it('открытый вопрос попадает в запрос к модели', async () => {
    // §7.1 плюс наше добавление: при открытом вопросе ANSWER проверяется
    // первым, иначе «в четверг» станет задачей без задачи.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        JSON.stringify({ crisis: false, segments: [{ intent: 'ANSWER', text: 'в четверг' }] }),
      ],
    });

    await routeIntents(deps(provider, prompts), {
      input: 'в четверг',
      openQuestion: 'На какой день записать к врачу?',
    });

    expect(provider.requests[0]?.input).toContain('На какой день записать');
    expect(provider.requests[0]?.input).toContain('в четверг');
  });

  it('без открытого вопроса лишнего в запрос не добавляет', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text: 'надо к врачу' }] }),
      ],
    });

    await routeIntents(deps(provider, prompts), { input: 'надо к врачу' });

    expect(provider.requests[0]?.input).toBe('надо к врачу');
  });
});

describe('когда намерения не разобрались', () => {
  it('считает всю выгрузку одной мыслью, а не теряет её', async () => {
    // DUMP — самое частое намерение, и такая замена ничего не теряет.
    // Отказ обрабатывать выгрузку оставил бы человека без ответа.
    const prompts = await prepare();
    const provider = new MockLlmProvider({ respond: () => 'мусор' });

    const result = await routeIntents(deps(provider, prompts), { input: THREE_INTENTS });

    expect(result.fallback).toBe(true);
    expect(result.segments).toEqual([{ intent: 'DUMP', text: THREE_INTENTS }]);
  });

  it('пустой список сегментов тоже становится одной мыслью', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [JSON.stringify({ crisis: false, segments: [] })],
    });

    const result = await routeIntents(deps(provider, prompts), { input: 'просто мысль' });

    expect(result.fallback).toBe(true);
    expect(result.segments[0]?.text).toBe('просто мысль');
  });

  it('недоступность модели пробрасывает наружу, а не подменяет заменой', async () => {
    // Здесь замена была бы вредна: выгрузку надо вернуть в очередь и
    // разобрать позже, а не решить за человека, что он просто болтал.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      failFirst: { times: 10, error: new TransientLlmError('модель занята') },
    });

    await expect(
      routeIntents(deps(provider, prompts), { input: THREE_INTENTS }),
    ).rejects.toBeInstanceOf(TransientLlmError);
  });
});

describe('учёт расхода', () => {
  it('вызов записан с этапом router и версией промпта', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text: 'мысль' }] })],
    });

    await routeIntents(deps(provider, prompts), { input: 'мысль' });

    const [call] = await testDb().select().from(aiCalls);
    expect(call?.stage).toBe('router');
    expect(call?.promptVersion).toBe('router@1');
    expect(call?.ok).toBe(true);
  });
});
