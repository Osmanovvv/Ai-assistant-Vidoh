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
    recurrenceKind: string;
    recurrenceInterval: number;
    recurrenceText: string;
    deadlineText: string;
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
      // Задача 2.18а: три поля регулярности. По умолчанию дело разовое.
      recurrenceKind: 'none',
      recurrenceInterval: 0,
      recurrenceText: '',
      deadlineText: '',
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

    // Дата в тексте обязательна: с задачи 2.7 срок без слов о времени
    // считается выдуманным и отбрасывается, и «к врачу» его бы потеряло.
    const moscow = await classifyUnits(deps(provider, prompts), params('к врачу 10 сентября'));
    const vladivostok = await classifyUnits(deps(provider, prompts), {
      ...params('к врачу 10 сентября'),
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

describe('регулярность (задача 2.18а)', () => {
  it('«каждый вторник» даёт правило, а не разовую задачу', async () => {
    // Условие готовности задачи. Раньше регулярность просто исчезала:
    // запись создана, срок есть, тест зелёный — а бот через неделю
    // ничего не помнит.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'возить сына на плавание',
            deadline: '2026-09-08',
            deadlineAccuracy: 'day',
            recurrenceKind: 'weekly',
            recurrenceInterval: 1,
            recurrenceText: 'каждый вторник',
            deadlineText: '',
          },
        ]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), params('каждый вторник плавание'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [item] = result.items;
    expect(item?.recurrence?.rule).toEqual({
      kind: 'weekly',
      interval: 1,
      anchor: '2026-09-08',
    });
    expect(item?.recurrence?.text).toBe('каждый вторник');
    expect(item?.recurrence?.source).toBe('stated');
    expect(result.corrections.recurrence).toBe(0);
  });

  it('у регулярного дела срок дневной, даже если модель сказала «неделя»', async () => {
    /**
     * Задача 3.30. «Каждый вторник» модель помечала точностью `week`, и
     * планировщик такому делу напоминание накануне не ставил: `remindable`
     * пропускает только `day`. Человек заводил «каждый вторник» ровно
     * затем, чтобы ему напомнили, а напоминания не было.
     *
     * Спорить с моделью тут не о чем: правило вообще не строится без
     * конкретной даты, значит срок точный по построению.
     */
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'возить сына на плавание',
            deadline: '2026-09-08',
            deadlineAccuracy: 'week',
            recurrenceKind: 'weekly',
            recurrenceInterval: 1,
            recurrenceText: 'каждый вторник',
          },
        ]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), params('каждый вторник плавание'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [item] = result.items;
    expect(item?.deadline?.accuracy).toBe('day');
    expect(item?.recurrence?.rule).toBeDefined();
    // Несогласованность ответа модели считается поправкой, как и прочие.
    expect(result.corrections.deadline).toBe(1);
  });

  it('у разового дела «неделя» остаётся неделей', async () => {
    // Граница правила: без регулярности точность модели не трогаем —
    // «на следующей неделе» и правда не день, и напоминание накануне
    // сработало бы не в тот.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'разобрать шкаф',
            deadline: '2026-09-08',
            deadlineAccuracy: 'week',
            recurrenceKind: 'none',
            recurrenceInterval: 0,
            recurrenceText: '',
          },
        ]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), params('на следующей неделе шкаф'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items[0]?.deadline?.accuracy).toBe('week');
  });

  it('непонятая регулярность сохраняется фразой и считается поправкой', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'танцы',
            deadline: '2026-09-08',
            deadlineAccuracy: 'day',
            recurrenceKind: 'unclear',
            recurrenceInterval: 1,
            recurrenceText: 'каждый вторник и четверг',
          },
        ]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), params('танцы'));
    if (!result.ok) throw new Error('разбор должен был удаться');

    expect(result.items[0]?.recurrence?.rule).toBeUndefined();
    expect(result.items[0]?.recurrence?.text).toBe('каждый вторник и четверг');
    // Ненулевой счётчик — повод посмотреть промпт, а не тихая норма.
    expect(result.corrections.recurrence).toBe(1);
  });

  it('регулярность у не-задачи снимается в коде', async () => {
    // §5.1: регулярность — поле у TASK, как проект и делегируемость.
    // База это же запрещает ограничением, но полагаться на то, что до
    // базы дойдёт правильное, нельзя: отказ вставки уронил бы всю
    // выгрузку из-за одной записи.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'хочу бегать по утрам',
            type: 'DESIRE',
            priority: 'NONE',
            recurrenceKind: 'daily',
            recurrenceInterval: 1,
            recurrenceText: 'каждое утро',
          },
        ]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), params('хочу бегать'));
    if (!result.ok) throw new Error('разбор должен был удаться');

    expect(result.items[0]?.recurrence).toBeUndefined();
    expect(result.corrections.recurrence).toBe(1);
  });

  it('разовое дело регулярности не получает', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          { text: 'записать сына к врачу', deadline: '2026-09-03', deadlineAccuracy: 'day' },
        ]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), params('к врачу в четверг'));
    if (!result.ok) throw new Error('разбор должен был удаться');

    expect(result.items[0]?.recurrence).toBeUndefined();
    expect(result.corrections.recurrence).toBe(0);
  });

  it('регулярность без срока сохраняется фразой: правилу не на что опереться', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'оплатить садик',
            recurrenceKind: 'monthly',
            recurrenceInterval: 1,
            recurrenceText: 'раз в месяц',
          },
        ]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), params('садик раз в месяц'));
    if (!result.ok) throw new Error('разбор должен был удаться');

    expect(result.items[0]?.recurrence?.rule).toBeUndefined();
    expect(result.items[0]?.recurrence?.text).toBe('раз в месяц');
    expect(result.corrections.recurrence).toBe(1);
  });
});
