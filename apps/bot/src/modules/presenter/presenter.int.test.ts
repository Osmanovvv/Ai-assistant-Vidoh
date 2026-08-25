import { beforeEach, describe, expect, it } from 'vitest';

import { aiCalls, promptVersions } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { defaultTexts } from '../../texts/index.js';
import { PromptRegistry } from '../ai/prompts/registry.js';
import { activatePrompt, seedPrompt } from '../ai/prompts/seed.js';
import { MockLlmProvider } from '../ai/providers/mock.js';
import { PRESENTER_SCHEMA_NAME } from '../ai/schemas/index.js';
import { TransientLlmError } from '../ai/providers/types.js';
import { countQuestions, presentDump, type DumpComposition } from './presenter.service.js';

/**
 * Ответ на выгрузку целиком: обращение к модели, учёт расхода и сборка.
 *
 * Проверяется главное свойство: ответ человеку уходит при любом поведении
 * модели. Признание — украшение, список действий — суть, и отказ модели не
 * должен превращаться в молчание.
 */

const logger = createLogger({ level: 'silent' });

const composition: DumpComposition = {
  tasks: 3,
  desires: 1,
  ideas: 0,
  infos: 0,
  emotions: 0,
  hasProject: true,
};

const answer = (acknowledgement: string) => JSON.stringify({ acknowledgement });

async function prepare(): Promise<PromptRegistry> {
  await seedPrompt(testDb(), {
    stage: 'presenter',
    version: 'presenter@1',
    prompt: 'Назови состав выгрузки одной фразой.',
    schemaName: PRESENTER_SCHEMA_NAME,
  });
  await activatePrompt(testDb(), 'presenter', 'presenter@1');

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

const params = {
  composition,
  actions: ['Записать сына к врачу', 'Позвонить маме'],
  hidden: 4,
};

beforeEach(async () => {
  await testDb().delete(promptVersions);
  await testDb().delete(aiCalls);
});

describe('presentDump', () => {
  it('собирает ответ из признания модели и словаря', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [answer('Я тебя услышала. Три дела и одна большая цель.')],
    });

    const result = await presentDump(deps(provider, prompts), params);

    expect(result.replaced).toBe(false);
    expect(result.promptVersion).toBe('presenter@1');
    expect(result.reply.text).toContain('Я тебя услышала');
    expect(result.reply.text).toContain('— Записать сына к врачу');
    expect(result.reply.text).toContain(defaultTexts.answer.restSaved);
    expect(countQuestions(result.reply.text)).toBe(1);
    expect(result.reply.buttons).toHaveLength(3);
  });

  it('полных текстов модели не показывает — только состав и заголовки', async () => {
    // §7.2 ТЗ запрещает передавать модели полные тексты: это раздувает
    // расход, а признанию хватает состава.
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [answer('Услышала.')] });

    await presentDump(deps(provider, prompts), params);

    const sent = provider.requests[0]?.input ?? '';
    expect(sent).toContain('дел: 3');
    expect(sent).toContain('большая составная цель среди дел: есть');
    expect(sent).toContain('Записать сына к врачу');
  });

  it('отказ модели не отменяет ответ', async () => {
    // Худший случай: модель недоступна вовсе. Человек всё равно обязан
    // получить разбор — он для этого и наговаривал.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      failFirst: { times: 10, error: new TransientLlmError('недоступна') },
    });

    const result = await presentDump(deps(provider, prompts), params);

    expect(result.replaced).toBe(true);
    expect(result.reply.text.startsWith(defaultTexts.answer.acknowledgementFallback)).toBe(true);
    expect(result.reply.text).toContain('— Записать сына к врачу');
    expect(countQuestions(result.reply.text)).toBe(1);
  });

  it('запрещённое §13.7 признание заменяется, а расход всё равно учтён', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [answer('Поняла. Тебе бы отдохнуть и полежать.')],
    });

    const result = await presentDump(deps(provider, prompts), {
      ...params,
      composition: { ...composition, emotions: 1 },
    });

    expect(result.replaced).toBe(true);
    expect(result.reply.text.startsWith(defaultTexts.answer.acknowledgementTiredFallback)).toBe(
      true,
    );

    // §10.5: вызов был и оплачен, вне зависимости от того, подошёл ли ответ.
    const [call] = await testDb().select().from(aiCalls);
    expect(call?.stage).toBe('presenter');
    expect(call?.promptVersion).toBe('presenter@1');
    expect(call?.ok).toBe(true);
  });

  it('высказанное состояние сокращает ответ и закрывает разговор', async () => {
    // §13.7: признание одной строкой, одно действие, выход из разговора.
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [answer('Поняла. Сегодня тяжело.')] });

    const result = await presentDump(deps(provider, prompts), {
      composition: { ...composition, emotions: 2 },
      actions: ['Записать сына к врачу'],
      hidden: 7,
    });

    expect(result.reply.text).toContain(defaultTexts.answer.actionsLeadSingle);
    expect(result.reply.text).toContain(defaultTexts.answer.closingTired);
    expect(countQuestions(result.reply.text)).toBe(0);
    expect(result.reply.buttons).toHaveLength(2);
  });

  it('неизвестный профиль берёт словарь по умолчанию', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [answer('Услышала.')] });

    const result = await presentDump(deps(provider, prompts), {
      ...params,
      profile: 'тёплый-которого-нет',
    });

    expect(result.reply.text).toContain(defaultTexts.answer.question);
  });
});
