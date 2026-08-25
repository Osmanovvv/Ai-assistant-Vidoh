import { beforeEach, describe, expect, it } from 'vitest';

import { aiCalls, promptVersions } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { PromptRegistry } from '../ai/prompts/registry.js';
import { activatePrompt, seedPrompt } from '../ai/prompts/seed.js';
import { MockLlmProvider } from '../ai/providers/mock.js';
import { CLASSIFIER_SCHEMA_NAME } from '../ai/schemas/index.js';
import { classifyUnits } from './classifier.service.js';

/**
 * Классификация на живой базе с подменённой моделью.
 *
 * Главное здесь — правила, которые проверяются в коде, а не только в
 * промпте. Промпт — это просьба, а не гарантия, и §6.2 прямо говорит,
 * какое правило модели нарушают чаще всего.
 */

const logger = createLogger({ level: 'silent' });

const TOPICS = ['семья', 'здоровье', 'работа', 'покупки', 'личное'];
const NOW = new Date('2026-09-04T09:00:00.000Z');
const MOSCOW = 'Europe/Moscow';

/** Ответ модели: столько записей, сколько пришло единиц. */
const answer = (
  items: readonly Partial<{
    text: string;
    type: string;
    priority: string;
    topic: string;
    isProject: boolean;
    deadline: string;
    deadlineAccuracy: string;
  }>[],
) =>
  JSON.stringify({
    items: items.map((item) => ({
      text: 'дело',
      type: 'TASK',
      priority: 'SOON',
      topic: 'личное',
      isProject: false,
      deadline: '',
      deadlineAccuracy: 'none',
      ...item,
    })),
  });

async function prepare(): Promise<PromptRegistry> {
  await seedPrompt(testDb(), {
    stage: 'classifier',
    version: 'classifier@1',
    prompt: 'Определи тип, важность, тему и срок.',
    schemaName: CLASSIFIER_SCHEMA_NAME,
  });
  await activatePrompt(testDb(), 'classifier', 'classifier@1');

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

const params = (text: string) => ({
  units: [{ text, isProject: false, isEmotion: false }],
  topics: TOPICS,
  defaultTopic: 'личное',
  timeZone: MOSCOW,
  now: NOW,
});

beforeEach(async () => {
  await testDb().delete(promptVersions);
  await testDb().delete(aiCalls);
});

describe('желание не становится задачей', () => {
  it('«давно хочу заняться спортом» даёт DESIRE с приоритетом NONE', async () => {
    // Условие готовности задачи 2.6 дословно. Модель здесь намеренно
    // отвечает неверно — ставит важность желанию, — и код обязан это
    // исправить: §6.2 называет это правилом, которое нарушают чаще всего.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([{ text: 'заняться спортом', type: 'DESIRE', priority: 'NOW', topic: 'здоровье' }]),
      ],
    });

    const result = await classifyUnits(
      deps(provider, prompts),
      params('давно хочу заняться спортом'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items[0]?.type).toBe('DESIRE');
    expect(result.items[0]?.priority).toBe('NONE');
    expect(result.corrections.priority).toBe(1);
  });

  it('то же правило действует для идеи, информации и эмоции', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          { type: 'IDEA', priority: 'SOON' },
          { type: 'INFO', priority: 'LATER' },
          { type: 'EMOTION', priority: 'NOW' },
        ]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), {
      ...params('мысль'),
      units: [
        { text: 'а если фотоальбом', isProject: false, isEmotion: false },
        { text: 'день рождения в сентябре', isProject: false, isEmotion: false },
        { text: 'ничего не успеваю', isProject: false, isEmotion: true },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items.map((item) => item.priority)).toEqual(['NONE', 'NONE', 'NONE']);
    expect(result.corrections.priority).toBe(3);
  });

  it('задаче важность оставляет как есть', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [answer([{ type: 'TASK', priority: 'NOW' }])],
    });

    const result = await classifyUnits(deps(provider, prompts), params('записать к врачу'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.priority).toBe('NOW');
    expect(result.corrections.priority).toBe(0);
  });

  it('признак проекта у не-задачи снимается', async () => {
    // §5.1 ТЗ: проект — поле у TASK, у остальных типов оно не значит ничего.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [answer([{ type: 'DESIRE', isProject: true }])],
    });

    const result = await classifyUnits(deps(provider, prompts), params('хочу на море'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.isProject).toBe(false);
    expect(result.corrections.project).toBe(1);
  });
});

describe('темы', () => {
  it('незнакомая тема заменяется темой по умолчанию', async () => {
    // §6.4 ТЗ запрещает создавать темы без спроса.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [answer([{ topic: 'саморазвитие' }])],
    });

    const result = await classifyUnits(deps(provider, prompts), params('дело'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.topic).toBe('личное');
    expect(result.corrections.topic).toBe(1);
  });

  it('тема узнаётся независимо от регистра и «ё»', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [answer([{ topic: 'ЗДОРОВЬЕ' }])] });

    const result = await classifyUnits(deps(provider, prompts), params('дело'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // В базу ложится название из списка человека, а не то, как его
    // написала модель: он видит именно свой список.
    expect(result.items[0]?.topic).toBe('здоровье');
    expect(result.corrections.topic).toBe(0);
  });

  it('список тем и сегодняшняя дата уходят в запрос', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [answer([{}])] });

    await classifyUnits(deps(provider, prompts), params('дело'));

    const sent = provider.requests[0]?.input ?? '';
    expect(sent).toContain('здоровье');
    // Без дня недели модель не разрешит «в четверг».
    expect(sent).toContain('пятница');
    expect(sent).toContain('4 сентября 2026');
  });
});

describe('сроки', () => {
  it('привязывает срок к поясу человека', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [answer([{ deadline: '2026-09-10', deadlineAccuracy: 'day' }])],
    });

    const result = await classifyUnits(deps(provider, prompts), params('к врачу в четверг'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.deadline?.at.toISOString()).toBe('2026-09-09T21:00:00.000Z');
    expect(result.items[0]?.deadline?.accuracy).toBe('day');
  });

  it('тот же срок в другом поясе даёт другой момент', async () => {
    // Условие готовности задачи 2.7.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      respond: () => answer([{ deadline: '2026-09-10', deadlineAccuracy: 'day' }]),
    });

    const moscow = await classifyUnits(deps(provider, prompts), params('к врачу'));
    const vladivostok = await classifyUnits(deps(provider, prompts), {
      ...params('к врачу'),
      timeZone: 'Asia/Vladivostok',
    });

    if (!moscow.ok || !vladivostok.ok) throw new Error('ожидались успешные разборы');

    expect(moscow.items[0]?.deadline?.at.getTime()).not.toBe(
      vladivostok.items[0]?.deadline?.at.getTime(),
    );
  });

  it('срок в прошлом отбрасывается, запись остаётся', async () => {
    // Напоминание не вовремя хуже не пришедшего.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [answer([{ deadline: '2026-09-01', deadlineAccuracy: 'day' }])],
    });

    const result = await classifyUnits(deps(provider, prompts), params('к врачу в четверг'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.deadline).toBeUndefined();
    expect(result.items[0]?.text).toBeTruthy();
    expect(result.corrections.deadline).toBe(1);
  });

  it('отсутствие срока — обычное дело, а не поправка', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [answer([{}])] });

    const result = await classifyUnits(deps(provider, prompts), params('дело'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.deadline).toBeUndefined();
    expect(result.corrections.deadline).toBe(0);
  });
});

describe('когда классификация не удалась', () => {
  it('возвращает отказ с сырым ответом', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ respond: () => 'не json' });

    const result = await classifyUnits(deps(provider, prompts), params('дело'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.raw).toBe('не json');
  });
});

describe('учёт расхода', () => {
  it('вызов записан с этапом classifier и версией промпта', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [answer([{}])] });

    await classifyUnits(deps(provider, prompts), params('дело'));

    const [call] = await testDb().select().from(aiCalls);
    expect(call?.stage).toBe('classifier');
    expect(call?.promptVersion).toBe('classifier@1');
  });
});
