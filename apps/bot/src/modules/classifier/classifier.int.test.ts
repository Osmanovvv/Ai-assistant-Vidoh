import pino from 'pino';
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

const params = (...texts: readonly string[]) => ({
  units: texts.map((text) => ({ text, isProject: false, isEmotion: false })),
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

  it('признак проекта у замысла снимается', async () => {
    /**
     * §5.1: проект — поле задачи. **С 05.09.2026 и желания** — решение
     * заказчика: «хочу начать делать сайт» это цель с шагами, и люди
     * говорят о таком именно через «хочу». Прежде здесь стоял `DESIRE`, и
     * тест охранял правило, которого больше нет.
     *
     * Замыслу признак по-прежнему не положен: «есть идея когда-нибудь
     * сделать канал, никаких действий по нему не ставь» — проект без
     * шагов не проект. Проверка сохранена на нём.
     */
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [answer([{ type: 'IDEA', isProject: true }])],
    });

    const result = await classifyUnits(deps(provider, prompts), params('есть идея сделать канал'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.isProject).toBe(false);
    expect(result.corrections.project).toBe(1);
  });

  it('«хочу за осень сделать ремонт» — дело с важностью «позже», не желание (блок B 17.09.2026)', async () => {
    /**
     * Решение Никиты 17.09.2026: «хочу за осень сделать ремонт в спальне:
     * обои, потолок, шторы» — дело-цель с сезонным сроком. Модель отдаёт
     * желание: и бой, и стенд на живом наборе 20.09.2026. Промпт не
     * трогаем — правило кодом, по трём приметам сразу (`dated-wish.ts`).
     * Признак цели от модели сохраняется, важность — «позже», раз своей
     * модель не дала.
     */
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'за осень хочу сделать ремонт в спальне: обои, потолок, шторы',
            type: 'DESIRE',
            priority: 'NONE',
            isProject: true,
          },
        ]),
      ],
    });

    const result = await classifyUnits(
      deps(provider, prompts),
      params('за осень хочу сделать ремонт в спальне: обои, потолок, шторы'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.type).toBe('TASK');
    expect(result.items[0]?.priority).toBe('LATER');
    expect(result.items[0]?.isProject).toBe(true);
    expect(result.corrections.type).toBe(1);
  });

  it('«на выходных» из вопроса «что у меня на выходных» не становится сроком соседнего дела (голос 10)', async () => {
    /**
     * Живой набор 20.09.2026, live-14: модель срока балкону не дала,
     * а запасной путь взял «на выходных» из вопроса в том же предложении
     * речи. Вопрос о дне — не срок; речь для правил дня идёт без него.
     */
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [answer([{ text: 'Надо разобрать балкон', type: 'TASK', priority: 'LATER' }])],
    });

    const result = await classifyUnits(deps(provider, prompts), {
      ...params('Надо разобрать балкон'),
      spoken: 'и еще и еще надо разобрать балкон.',
      speech:
        'Я так устала за эту неделю. Просто нет сил ни на что, кстати, что у меня на выходных и еще и еще надо разобрать балкон.',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.deadline).toBeUndefined();
  });

  it('желание без рамки срока остаётся желанием — правило узкое', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'хочу наконец съездить в отпуск на море хотя бы на недельку',
            type: 'DESIRE',
            priority: 'NONE',
          },
        ]),
      ],
    });

    const result = await classifyUnits(
      deps(provider, prompts),
      params('хочу наконец съездить в отпуск на море хотя бы на недельку'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.type).toBe('DESIRE');
    expect(result.corrections.type).toBe(0);
  });
});

describe('темы', () => {
  it('незнакомая тема заменяется темой по умолчанию, а названное моделью имя отдаётся отдельно', async () => {
    /**
     * Классификация тем не заводит — это запись в базу, а она чистая.
     * Но и не теряет названное: с правки заказчицы 14.09.2026 (п. 1.1)
     * сферу по содержанию создаёт конвейер, и ему нужно имя, которое
     * модель назвала. Запись до его решения лежит в теме по умолчанию.
     */
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [answer([{ topic: 'саморазвитие' }])],
    });

    const result = await classifyUnits(deps(provider, prompts), params('дело'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.topic).toBe('личное');
    expect(result.items[0]?.wantedTopic).toBe('саморазвитие');
    expect(result.corrections.topic).toBe(1);
  });

  it('другая форма своей сферы — это она: «покупка» при «покупки» (бой 26.09.2026, 02:03)', async () => {
    // Модель назвала сферу машины «покупка», у человека своя «покупки»:
    // точное сравнение имён завело вторую сферу с веткой в чате.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [answer([{ topic: 'покупка' }])],
    });

    const result = await classifyUnits(deps(provider, prompts), params('дело'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.topic).toBe('покупки');
    expect(result.items[0]?.wantedTopic).toBeUndefined();
    // Имя модели не совпало со списком — поправка, как и прежде.
    expect(result.corrections.topic).toBe(1);
  });

  it('две свои сферы с одним ключом — не угадываем, какая: имя уходит, как незнакомое', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [answer([{ topic: 'домах' }])],
    });

    const result = await classifyUnits(deps(provider, prompts), {
      ...params('дело'),
      topics: [...TOPICS, 'дом', 'дома'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.topic).toBe('личное');
    expect(result.items[0]?.wantedTopic).toBe('домах');
  });

  it('названное имя приводится к виду записи: без краёв и лишних пробелов, строчными', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [answer([{ topic: '  Само Развитие ' }])],
    });

    const result = await classifyUnits(deps(provider, prompts), params('дело'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.wantedTopic).toBe('само развитие');
  });

  it('пустое или мусорное имя темы не предлагается вовсе', async () => {
    // Символы вместо слова, длинная фраза — не название сферы. Запись в
    // теме по умолчанию, предложения нет.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          { topic: '   ' },
          { topic: '???' },
          { topic: 'дела которые надо сделать до конца месяца' },
        ]),
      ],
    });

    const result = await classifyUnits(
      deps(provider, prompts),
      params('дело', 'второе дело', 'третье дело'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const item of result.items) {
      expect(item.topic).toBe('личное');
      expect(item.wantedTopic).toBeUndefined();
    }
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

  it('якорь берётся из проверенного срока, а не из строки модели', async () => {
    /**
     * Ревизия этапов 1–2, регрессия высокой важности.
     *
     * Срок проходит проверку и пересчёт кодом: человек назвал четверг,
     * модель ответила средой — это измеренный промах (`dates.ts`), и код
     * исправляет дату на четверг. Правило же строилось из **строки
     * модели**, и якорь оставался средой.
     *
     * Дальше расхождение становится вечным: после первого «сделано»
     * `nextDeadlineAfterDone` считает следующее повторение от якоря и
     * отдаёт следующую среду. «Каждый четверг» навсегда превращается в
     * «каждую среду», а в карточке при этом стоят слова человека про
     * четверг — и объяснить это ему нечем.
     *
     * Обещание в шапке `recurrence.ts` — «правило не может разойтись со
     * сроком, они одно» — было правдой, когда правило вводили; поправки в
     * разборе дат его сняли, и покраснеть было нечему.
     */
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'записаться к стоматологу',
            // 2026-09-09 — среда. Человек сказал «в четверг».
            deadline: '2026-09-09',
            deadlineAccuracy: 'day',
            recurrenceKind: 'weekly',
            recurrenceInterval: 1,
            recurrenceText: 'каждый четверг',
            deadlineText: '',
          },
        ]),
      ],
    });

    const result = await classifyUnits(
      deps(provider, prompts),
      params('каждый четверг записываться к стоматологу'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [item] = result.items;

    // Срок исправлен кодом на четверг 10 сентября…
    expect(item?.deadline?.at.toISOString()).toBe('2026-09-09T21:00:00.000Z');
    expect(result.corrections.deadline).toBe(1);

    // …и якорь обязан быть тем же четвергом, а не средой модели.
    expect(item?.recurrence?.rule?.anchor, 'правило разошлось со сроком той же записи').toBe(
      '2026-09-10',
    );
  });

  it('без проверенного срока правило всё равно строится', async () => {
    /**
     * «По будням собирать обед» — законное `weekdays`, а срока человек не
     * называл, и разбор дат его законно отвергает.
     *
     * Правка якоря соблазняет выбросить правило вместе с отвергнутым
     * сроком. Здесь записано, почему так делать нельзя: цена — потеря
     * измеренного случая из контрольного набора, и без прогона набора
     * она не проверяется. Опора на строку модели остаётся, как и была.
     */
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'собирать сыну обед в школу',
            deadline: '2026-09-07',
            deadlineAccuracy: 'day',
            recurrenceKind: 'weekdays',
            recurrenceInterval: 1,
            recurrenceText: 'по будням',
            deadlineText: '',
          },
        ]),
      ],
    });

    const result = await classifyUnits(
      deps(provider, prompts),
      params('по будням собирать сыну обед в школу'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [item] = result.items;

    // Срок отвергнут: времени человек не называл.
    expect(item?.deadline).toBeUndefined();

    // А правило на месте.
    expect(item?.recurrence?.rule?.kind).toBe('weekdays');
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

  it('непонятая регулярность без правила держится только на словах человека', async () => {
    /**
     * Ручной прогон 15.09.2026 на бою: «Завтра опять надо отвести машину
     * на мойку, ещё надо» → вид `unclear`, фраза «опять ... ещё надо».
     * Правила нет, а фраза ушла в карточку строкой «Повторяется: опять
     * ... ещё надо» — человек своих слов в ней не узнает, потому что он
     * их так не говорил. Тот же приём, что у цитаты о сроке: без правила
     * фраза остаётся, только если она дословно есть в речи.
     */
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'отвести машину на мойку',
            deadline: '2026-09-04',
            deadlineAccuracy: 'day',
            recurrenceKind: 'unclear',
            recurrenceInterval: 1,
            recurrenceText: 'опять ... ещё надо',
          },
        ]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), {
      ...params('отвести машину на мойку'),
      speech: 'Завтра опять надо отвести машину на мойку, ещё надо.',
    });
    if (!result.ok) throw new Error('разбор должен был удаться');

    expect(result.items[0]?.recurrence).toBeUndefined();
    expect(result.corrections.recurrence).toBe(1);
  });

  it('непонятая регулярность, сказанная дословно, остаётся фразой и при речи', async () => {
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

    const result = await classifyUnits(deps(provider, prompts), {
      ...params('танцы'),
      speech: 'Танцы у дочки теперь каждый вторник и четверг, не забыть.',
    });
    if (!result.ok) throw new Error('разбор должен был удаться');

    expect(result.items[0]?.recurrence?.text).toBe('каждый вторник и четверг');
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

/**
 * Важность и срок обязаны быть согласны (задача 3.57).
 *
 * Найдено живым прогоном 04.09.2026. «Помыть машину в пятницу» получило
 * тип `TASK`, срок на сегодня — и важность `NONE`. В списке «на сегодня»
 * дела не было вовсе: выдача отсекает `NONE`, и отсекает правильно, §6.3
 * держит так желания и эмоции вне выдачи. Человек назвал день и не увидел
 * дела в этот день.
 */
describe('заголовок дела — чистое повеление (видео заказчицы 15.09.2026)', () => {
  /**
   * Извлечение обязано переписывать мысль в повеление, но на бою
   * 15.09.2026 из шести дел два пришли с мусором: «Хочу завтра съездить
   * в офис распечатать документы», «Надо отправить заявление на
   * продление декретного». Вечернее так и сказало: «Завтра срок: Хочу
   * завтра съездить…». Код срезает ведущее «надо/нужно/хочу» и слово о
   * дне, которое уже стало сроком, — только у дел: у желания «хочу» —
   * смысл, а не мусор.
   */
  it('срезает «хочу» и «завтра», когда завтра уже стало сроком', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'Хочу завтра съездить в офис распечатать документы',
            deadline: '2026-09-05',
            deadlineAccuracy: 'day',
            deadlineText: 'завтра',
          },
        ]),
      ],
    });

    const result = await classifyUnits(
      deps(provider, prompts),
      params('Хочу завтра съездить в офис распечатать документы'),
    );
    if (!result.ok) throw new Error('разбор должен был удаться');

    expect(result.items[0]?.text).toBe('Съездить в офис распечатать документы');
    expect(result.items[0]?.deadline?.accuracy).toBe('day');
  });

  it('срезает «надо» без срока, слово о дне без срока оставляет', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          { text: 'Надо отправить заявление на продление декретного' },
          { text: 'Завтра позвонить в банк' },
        ]),
      ],
    });

    const result = await classifyUnits(
      deps(provider, prompts),
      params('Надо отправить заявление на продление декретного', 'Завтра позвонить в банк'),
    );
    if (!result.ok) throw new Error('разбор должен был удаться');

    expect(result.items[0]?.text).toBe('Отправить заявление на продление декретного');
    // Срока модель не дала — «завтра» остаётся единственным следом дня.
    expect(result.items[1]?.text).toBe('Завтра позвонить в банк');
  });

  it('у желания «хочу» не трогает', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([{ text: 'Хочу научиться играть на гитаре', type: 'DESIRE', priority: 'NONE' }]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), params('давно хочу гитару'));
    if (!result.ok) throw new Error('разбор должен был удаться');

    expect(result.items[0]?.text).toBe('Хочу научиться играть на гитаре');
  });
});

describe('у дела со сроком важности «никакая» не бывает', () => {
  it('дело со сроком и важностью NONE поднимается до SOON', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'помыть машину в пятницу',
            type: 'TASK',
            priority: 'NONE',
            deadline: '2026-09-04',
            deadlineAccuracy: 'day',
            deadlineText: 'в пятницу',
          },
        ]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), params('помыть машину в пятницу'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items[0]?.priority).toBe('SOON');
    expect(result.items[0]?.deadline).not.toBeUndefined();
    expect(result.corrections.priority).toBe(1);
  });

  it('до NOW не поднимается: «прямо сейчас» решает человек', async () => {
    // Место в сегодняшнем списке даёт сам срок, а не важность. Ставить
    // NOW за человека значило бы двигать дело вперёд чужих.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            type: 'TASK',
            priority: 'NONE',
            deadline: '2026-09-04',
            deadlineAccuracy: 'day',
            deadlineText: 'в пятницу',
          },
        ]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), params('дело в пятницу'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.priority).toBe('SOON');
  });

  it('дело без срока с важностью NONE не трогается', async () => {
    /**
     * Правило следует из срока, а не из типа. У дела без срока «никакая»
     * важность — законный ответ модели: человек назвал дело, но ничем не
     * показал, что оно срочное.
     */
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [answer([{ type: 'TASK', priority: 'NONE' }])],
    });

    const result = await classifyUnits(
      deps(provider, prompts),
      params('когда-нибудь помыть машину'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.priority).toBe('NONE');
    expect(result.corrections.priority).toBe(0);
  });

  it('желание со сроком остаётся NONE: §6.3 сильнее', async () => {
    // Иначе правило вернуло бы в выдачу то, что §6.3 из неё убирает.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            type: 'DESIRE',
            priority: 'NONE',
            deadline: '2026-09-04',
            deadlineAccuracy: 'day',
            deadlineText: 'в пятницу',
          },
        ]),
      ],
    });

    const result = await classifyUnits(
      deps(provider, prompts),
      params('хочу помыть машину в пятницу'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.priority).toBe('NONE');
  });
});

/**
 * Большая цель бывает и желанием (решение заказчика 05.09.2026).
 *
 * Живой прогон проджекта 04.09.2026 показал, чем было плохо прежнее
 * правило: «хочу начать делать небольшой сайт для себя, пока ничего толком
 * не сделано» модель относит к желанию — и верно, он так и сказал. А
 * желание проектом быть не могло, признак снимался принудительно. Проектом
 * же становился его собственный шаг: роли перевернулись, шагов ноль, и на
 * вопрос «какой следующий шаг?» отвечать было нечем.
 */
describe('кому можно быть большой целью', () => {
  const asProject = (type: string) =>
    answer([{ text: 'сделать сайт', type, priority: 'NONE', isProject: true }]);

  it('желание может быть большой целью', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [asProject('DESIRE')] });

    const result = await classifyUnits(
      deps(provider, prompts),
      params('хочу начать делать небольшой сайт для себя'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items[0]?.type).toBe('DESIRE');
    expect(result.items[0]?.isProject).toBe(true);
    // Признак не правился — значит и в счёт правок он не попал.
    expect(result.corrections.project).toBe(0);
  });

  it('задача может, как и раньше', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [asProject('TASK')] });

    const result = await classifyUnits(deps(provider, prompts), params('делать сайт'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.isProject).toBe(true);
  });

  it('замысел, сведение и чувство большой целью быть не могут', async () => {
    /**
     * «Есть идея когда-нибудь сделать телеграм-канал, никаких действий и
     * сроков по нему не ставь» — человек прямо запретил шаги, а проект без
     * шагов не проект.
     */
    for (const type of ['IDEA', 'INFO', 'EMOTION']) {
      const prompts = await prepare();
      const provider = new MockLlmProvider({ responses: [asProject(type)] });

      const result = await classifyUnits(deps(provider, prompts), params('когда-нибудь канал'));

      expect(result.ok, type).toBe(true);
      if (!result.ok) return;

      expect(result.items[0]?.isProject, type).toBe(false);
      expect(result.corrections.project, type).toBe(1);
    }
  });
});

describe('срок соседа по чужой цитате (прогон 17.09.2026)', () => {
  it('цитата, которую содержат слова другой записи, срок не держит; своя — держит', async () => {
    /**
     * Стенд на живой расшифровке: извлечение потеряло «в октябре», и
     * модель отдала диспансеризации 21.09/неделя с цитатой «следующей
     * неделе» — словами стоматолога. Проверка дословности цитату
     * пропускала: в речи она есть. Запасной путь по своему предложению
     * затем находит свободное обозначение: неделя занята стоматологом,
     * месяц свободен и стоит в том же предложении — октябрь.
     */
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'записаться к стоматологу',
            deadline: '2026-09-21',
            deadlineAccuracy: 'week',
            deadlineText: 'следующей неделе',
          },
          {
            text: 'пройти диспансеризацию',
            deadline: '2026-09-21',
            deadlineAccuracy: 'week',
            deadlineText: 'следующей неделе',
          },
        ]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), {
      ...params('Следующей неделе записаться к стоматологу', 'пройти диспансеризацию'),
      now: new Date('2026-09-16T23:24:42.000Z'),
      speech:
        'Следующей неделе записаться к стоматологу давно уже откладываю в октябре пройти диспансеризацию.',
    });
    if (!result.ok) throw new Error('разбор должен был удаться');

    expect(result.items[0]?.deadline?.accuracy).toBe('week');
    expect(result.items[1]?.deadline?.accuracy).toBe('month');
    expect(result.items[1]?.deadline?.at.toISOString()).toBe('2026-09-30T21:00:00.000Z');
    // Снятие чужого срока и срок из своего предложения — две правки.
    expect(result.corrections.deadline).toBe(2);
  });
});

describe('слово о времени суток берёт день у слова о дне перед ним (голос 8, 18.09.2026)', () => {
  it('«вечером забрать заказ» после «завтра утром …» — завтра, а не сегодня, как сказала модель', async () => {
    /**
     * Бой: «Завтра утром позвонить в поликлинику, вечером забрать заказ
     * в пункте выдачи и в субботу днём поехать на дачу» — заказу модель
     * дала сегодня; «вечером» — слово о времени, страж пропустил. День
     * назван один раз на всю фразу — «завтра», перед «вечером».
     */
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'Завтра утром позвонить в поликлинику',
            deadline: '2026-09-19',
            deadlineAccuracy: 'day',
          },
          {
            text: 'Вечером забрать заказ в пункте выдачи',
            deadline: '2026-09-18',
            deadlineAccuracy: 'day',
          },
          {
            text: 'В субботу днем поехать на дачу',
            deadline: '2026-09-19',
            deadlineAccuracy: 'day',
          },
        ]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), {
      ...params(
        'Завтра утром позвонить в поликлинику',
        'Вечером забрать заказ в пункте выдачи',
        'В субботу днем поехать на дачу',
      ),
      now: new Date('2026-09-18T13:59:37.000Z'),
      speech:
        'Завтра утром позвонить в поликлинику, вечером забрать заказ в пункте выдачи и в субботу днем поехать на дачу.',
    });
    if (!result.ok) throw new Error('разбор должен был удаться');

    expect(result.items.map((item) => item.deadline?.at.toISOString())).toEqual([
      '2026-09-18T21:00:00.000Z',
      '2026-09-18T21:00:00.000Z',
      '2026-09-18T21:00:00.000Z',
    ]);
    expect(result.corrections.deadline).toBe(1);
  });
});

describe('названное время уже прошло — срок завтра (проджект, бой 21.09.2026)', () => {
  it('«в 9:00» в 15:01 без «сегодня» — завтра; «сегодня … в 13:00» — сегодня', async () => {
    /**
     * Выгрузка Никиты, 15:01 по Омску. Модель дала обоим делам сегодня:
     * который час, она не знает — в промпте только дата. Проджект:
     * «как он на 9:00 записал на сегодня, если уже это время прошло???».
     */
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'Сходить к стоматологу в 13:00',
            deadline: '2026-09-21',
            deadlineAccuracy: 'day',
            deadlineText: 'сегодня',
          },
          {
            text: 'Отнести компьютер на чистку, замена термопасты в 9:00',
            deadline: '2026-09-21',
            deadlineAccuracy: 'day',
            deadlineText: 'В 9 0 0',
          },
          { text: 'Погулять с собакой' },
        ]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), {
      ...params(
        'Сходить к стоматологу в 13:00',
        'Отнести компьютер на чистку, замена термопасты в 9:00',
        'Погулять с собакой',
      ),
      timeZone: 'Asia/Omsk',
      now: new Date('2026-09-21T09:01:00.000Z'),
      speech:
        'В общем, смотри, мне сегодня надо будет сходить к стоматологу в 13 0 0 вот также. В 9 0 0 мне надо отнести компьютер на чистку, замена термопасты. Потом надо будет погулять с собакой.',
    });
    if (!result.ok) throw new Error('разбор должен был удаться');

    expect(result.items.map((item) => item.deadline?.at.toISOString())).toEqual([
      '2026-09-20T18:00:00.000Z',
      '2026-09-21T18:00:00.000Z',
      undefined,
    ]);
    expect(result.corrections.deadline).toBe(1);
    /**
     * Час дела едет со сроком (ТЗ проджекта 17.09.2026, шаг 5): у
     * стоматолога 13:00, у компьютера 9:00 — из своих слов; у прогулки
     * часа нет. Это не правка срока, а его часть — в счёт поправок не идёт.
     */
    expect(result.items.map((item) => item.deadline?.time)).toEqual([13 * 60, 9 * 60, undefined]);
  });

  it('двусмысленное «в 9» часа не даёт, час без срока — тоже', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'Позвонить маме в 9',
            deadline: '2026-09-04',
            deadlineAccuracy: 'day',
            deadlineText: 'в 9',
          },
          { text: 'Созвон в 15:00', deadline: '', deadlineAccuracy: 'none' },
          {
            text: 'Сдать отчёт в 15:00',
            deadline: '2026-09-07',
            deadlineAccuracy: 'week',
            deadlineText: 'на неделе',
          },
        ]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), {
      ...params('Позвонить маме в 9', 'Созвон в 15:00', 'Сдать отчёт в 15:00'),
      speech: 'Сегодня позвонить маме в 9. Созвон в 15:00. На неделе сдать отчёт в 15:00.',
    });
    if (!result.ok) throw new Error('разбор должен был удаться');

    expect(result.items.map((item) => item.deadline?.time)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  /**
   * Вариант Б (решение Никиты 24.09.2026): «в 4 часа» — 16:00, а «в 9»
   * не угадывается, но и не теряется молча — классификатор отдаёт оба
   * чтения, чтобы конвейер спросил сразу при записи.
   */
  it('«в 4 часа» — 16:00; «в 9» — час пуст, оба чтения для вопроса; без срока — вопроса нет', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'Поехать за ребёнком в 4 часа',
            deadline: '2026-09-04',
            deadlineAccuracy: 'day',
            deadlineText: 'в 4 часа',
          },
          {
            text: 'Позвонить маме в 9',
            deadline: '2026-09-04',
            deadlineAccuracy: 'day',
            deadlineText: 'в 9',
          },
          { text: 'Созвон в 9', deadline: '', deadlineAccuracy: 'none' },
        ]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), {
      ...params('Поехать за ребёнком в 4 часа', 'Позвонить маме в 9', 'Созвон в 9'),
      speech: 'Поехать за ребёнком в 4 часа. Позвонить маме в 9. Созвон в 9.',
    });
    if (!result.ok) throw new Error('разбор должен был удаться');

    expect(result.items.map((item) => item.deadline?.time)).toEqual([
      16 * 60,
      undefined,
      undefined,
    ]);
    expect(result.items.map((item) => item.unclearTime)).toEqual([
      undefined,
      [9 * 60, 21 * 60],
      undefined,
    ]);
  });
});

describe('«через час» у нового дела — день и час от сейчас (23.09.2026)', () => {
  it('«Через полчаса позвонить маме» в 15:00 по Москве — сегодня, 15:30; без «через» — как было', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          // Модель не знает, который час: срока от неё нет или «сегодня».
          { text: 'Позвонить маме', deadline: '', deadlineAccuracy: 'none' },
          { text: 'Выключить духовку', deadline: '2026-09-23', deadlineAccuracy: 'day' },
          { text: 'Погулять с собакой' },
        ]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), {
      ...params('Позвонить маме', 'Выключить духовку', 'Погулять с собакой'),
      timeZone: 'Europe/Moscow',
      now: new Date('2026-09-23T12:00:00.000Z'),
      speech:
        'Через полчаса позвонить маме. Через 10 часов выключить духовку. Потом погулять с собакой.',
    });
    if (!result.ok) throw new Error('разбор должен был удаться');

    expect(result.items.map((item) => item.deadline?.at.toISOString())).toEqual([
      '2026-09-22T21:00:00.000Z',
      // 15:00 + 10 часов — уже завтра, в 01:00.
      '2026-09-23T21:00:00.000Z',
      undefined,
    ]);
    expect(result.items.map((item) => item.deadline?.time)).toEqual([15 * 60 + 30, 60, undefined]);
  });
});

describe('день без слова о дне уступает своему предложению речи (заказчица, бой 21.09.2026)', () => {
  it('«Так завтра. С 9 до 10 не забыть позвонить…» — завтра, а не среда соседа', async () => {
    /**
     * Стенд 21.09 на её расшифровке: звонку модель дала 23.09 с цитатой
     * «с 9 до 10» — часы, не день; среду она взяла у соседа «на Хайдру на
     * среду». Цифры пускали дату без слова о дне. Хайдре модель дала
     * «завтра» — код вернул её на среду по названному дню недели.
     */
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'записаться в Краснодаре на Хайдру на среду',
            deadline: '2026-09-22',
            deadlineAccuracy: 'day',
            deadlineText: 'завтра',
          },
          {
            text: 'с 9 до 10 не забыть позвонить Елене Михайловне в бухгалтерию',
            deadline: '2026-09-23',
            deadlineAccuracy: 'day',
            deadlineText: 'с 9 до 10',
          },
        ]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), {
      ...params(
        'записаться в Краснодаре на Хайдру на среду',
        'с 9 до 10 не забыть позвонить Елене Михайловне в бухгалтерию',
      ),
      now: new Date('2026-09-21T06:46:52.000Z'),
      speech:
        'Записаться в Краснодаре на Хайдру на среду, так? Так завтра. С 9 до 10 не забыть позвонить. Елене Михайловне в бухгалтерию. Вроде бы пока все из срочного.',
    });
    if (!result.ok) throw new Error('разбор должен был удаться');

    expect(result.items.map((item) => item.deadline?.at.toISOString())).toEqual([
      '2026-09-22T21:00:00.000Z',
      '2026-09-21T21:00:00.000Z',
    ]);
    expect(result.corrections.deadline).toBe(2);
  });

  it('без дня в своём предложении дата модели остаётся', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'позвонить в банк в 15:00',
            deadline: '2026-09-04',
            deadlineAccuracy: 'day',
            deadlineText: 'в 15:00',
          },
        ]),
      ],
    });

    const result = await classifyUnits(deps(provider, prompts), {
      ...params('позвонить в банк в 15:00'),
      speech: 'Надо позвонить в банк в 15:00 и купить хлеб.',
    });
    if (!result.ok) throw new Error('разбор должен был удаться');

    expect(result.items[0]?.deadline?.at.toISOString()).toBe('2026-09-03T21:00:00.000Z');
    expect(result.corrections.deadline).toBe(0);
  });
});

describe('«завтра» соседа не достаётся делу перед ним («с нуля» Никиты 25.09.2026, 17:04)', () => {
  it('«Купить хлеб и молоко, завтра забрать в 4 часа ребенка…» — у хлеба срока нет', async () => {
    /**
     * Бой: хлеб получил 26.09. Журнал показал два хода кода подряд: срок
     * модели у хлеба отвергнут — цитата «завтра» в словах ребёнка, — и
     * тут же запасной путь вернул его «из своего предложения»: правило
     * «срок сразу за словами дела» видит за «молоко» слово «завтра» и
     * соседей не спрашивает. Модель здесь отвечает так, как следует из
     * журнала боя: у стоматолога срока не было (ревизия переноса).
     */
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        answer([
          {
            text: 'Купить хлеб и молоко',
            topic: 'покупки',
            deadline: '2026-09-26',
            deadlineAccuracy: 'day',
            deadlineText: 'завтра',
          },
          {
            text: 'Забрать ребёнка из школы в 4 часа',
            topic: 'семья',
            deadline: '2026-09-26',
            deadlineAccuracy: 'day',
            deadlineText: 'завтра',
          },
          { text: 'Записаться к стоматологу', topic: 'здоровье' },
        ]),
      ],
    });
    const lines: string[] = [];
    const heard = pino(
      { level: 'info' },
      {
        write: (line: string) => {
          lines.push(line);
        },
      },
    );
    const speech =
      'Купить хлеб и молоко, завтра забрать в 4 часа ребенка из школы и записаться к стоматологу.';

    const result = await classifyUnits(
      { ...deps(provider, prompts), logger: heard },
      {
        ...params(
          'Купить хлеб и молоко',
          'Завтра забрать в 4 часа ребенка из школы',
          'Записаться к стоматологу',
        ),
        now: new Date('2026-09-25T14:05:06.000Z'),
        spoken: speech,
        speech,
      },
    );
    if (!result.ok) throw new Error('разбор должен был удаться');
    const said = lines.map((line) => (JSON.parse(line) as { msg: string }).msg);

    expect(result.items.map((item) => item.deadline?.at.toISOString())).toEqual([
      undefined,
      '2026-09-25T21:00:00.000Z',
      undefined,
    ]);
    // Ребёнок — завтра в 16:00, как и было на бою.
    expect(result.items[1]?.deadline?.time).toBe(16 * 60);
    // Отказ по чужой цитате остаётся, возврата «из своего предложения» нет.
    expect(said).toContain('Срок не прошёл проверку, запись сохраняется без срока');
    expect(said).not.toContain('Срок взят из своего предложения речи: модель его не дала');
    expect(result.corrections.deadline).toBe(1);
  });
});
