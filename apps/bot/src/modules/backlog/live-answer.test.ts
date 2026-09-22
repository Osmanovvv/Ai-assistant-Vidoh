import { describe, expect, it } from 'vitest';

import type { AiClientDeps, StructuredRequest } from '../ai/client.js';
import type { ActivePrompt } from '../ai/prompts/registry.js';
import {
  ANSWERER_SCHEMA_NAME,
  answererSchema,
  PRESENTER_V2_SCHEMA_NAME,
  presenterV2Schema,
} from '../ai/schemas/index.js';
import { defaultTexts } from '../../texts/index.js';
import type { Item } from '../../db/schema.js';
import { askLiveAnswer, checkLiveAnswer, questionFacts, type AskAnswer } from './live-answer.js';

/**
 * Живой ответ на вопрос о своих делах (слой B, 22.09.2026). §13.4 ТЗ:
 * «Напомни, что я хотела сделать с альбомом» → «Ты хотела сделать
 * семейный альбом. Последний шаг, на котором мы остановились: выбрать
 * первые фотографии.» — прозой. Записи находит код, модель говорит о
 * найденном; страж — тот же, что у живой строки, с пределами ответа.
 */
const MOSCOW = 'Europe/Moscow';
const now = new Date('2026-09-22T09:00:00.000Z'); // 12:00 МСК, вторник
const day = (offset: number): Date => new Date(Date.UTC(2026, 8, 22 + offset, -3, 0, 0));

let seq = 0;
function item(text: string, extra: Partial<Item> = {}): Item {
  seq += 1;
  return {
    id: `i-${String(seq)}`,
    userId: 'u1',
    sourceBatchId: null,
    sourceOrder: null,
    text,
    body: null,
    type: 'TASK',
    priority: 'SOON',
    topicId: null,
    topic: 'дом',
    status: 'new',
    completedAt: null,
    isProject: false,
    backgroundedAt: null,
    deferredAt: null,
    offeredAt: null,
    reviewedAt: null,
    assignee: null,
    deadlineAt: null,
    deadlineAccuracy: null,
    deadlineTime: null,
    lineMentionedAt: null,
    embedding: null,
    recurrenceRule: null,
    recurrenceText: null,
    recurrenceSource: null,
    isDraft: false,
    draftReason: null,
    createdAt: day(-3),
    updatedAt: day(-3),
    ...extra,
  };
}

describe('факты для ответа', () => {
  it('найденное по вопросу — записи со сферой, сроком и состоянием', () => {
    const facts = questionFacts({
      question: 'что важнее — ковёр или цветы',
      now,
      timeZone: MOSCOW,
      texts: defaultTexts,
      answer: {
        kind: 'about',
        items: [
          item('Заказать цветы', { topic: 'дом', deadlineAt: day(1), deadlineAccuracy: 'day' }),
          item('Купить ковёр в гостиную', { topic: 'дом' }),
        ],
      },
    });

    expect(facts).toContain('Вопрос: что важнее — ковёр или цветы');
    expect(facts).toContain('Сейчас: день');
    expect(facts).toContain('Найдено по вопросу:');
    expect(facts).toContain('— Заказать цветы (дом), срок: завтра');
    expect(facts).toContain('— Купить ковёр в гостиную (дом), без срока');
  });

  it('прошедший срок у найденного — так и назван: иначе модель читает дату как будущую (стенд 22.09.2026)', () => {
    // «По структуре сайта определишься 10 сентября» — про срок, который
    // прошёл двенадцать дней назад.
    const facts = questionFacts({
      question: 'что горит по работе',
      now,
      timeZone: MOSCOW,
      texts: defaultTexts,
      answer: {
        kind: 'about',
        items: [
          item('Определиться со структурой сайта', {
            topic: 'работа',
            deadlineAt: day(-12),
            deadlineAccuracy: 'day',
          }),
        ],
      },
    });

    expect(facts).toContain(
      '— Определиться со структурой сайта (работа), срок прошёл: 10.09, 12 дней назад',
    );
  });

  it('состояние в факты не идёт: «устала за неделю» — не дело, и цитировать его нельзя (бой 22.09.2026)', () => {
    /**
     * На бою «Как мне всё успеть?» получило ответ «Помню, что ты устала
     * за эту неделю — береги силы»: запись-состояние попала в найденное,
     * модель её процитировала и дала совет. §13.7: бот не анализирует
     * состояние и не советует.
     */
    const facts = questionFacts({
      question: 'как мне всё успеть',
      now,
      timeZone: MOSCOW,
      texts: defaultTexts,
      answer: {
        kind: 'about',
        items: [
          item('Устала за эту неделю, нет сил ни на что', { type: 'EMOTION', topic: 'личное' }),
          item('Купить хлеб', { topic: 'покупки', deadlineAt: day(1), deadlineAccuracy: 'day' }),
        ],
      },
    });

    expect(facts).not.toContain('Устала');
    expect(facts).toContain('— Купить хлеб');
  });

  it('состояние не идёт и в обзор', () => {
    const facts = questionFacts({
      question: 'что горит',
      now,
      timeZone: MOSCOW,
      texts: defaultTexts,
      answer: { kind: 'nothing' },
      overview: [
        item('Я на нуле совсем', { type: 'EMOTION' }),
        item('Сдать отчёт', { deadlineAt: day(0), deadlineAccuracy: 'day' }),
      ],
    });

    expect(facts).not.toContain('нуле');
    expect(facts).toContain('Сдать отчёт');
    expect(facts).toContain('Открытых дел всего: 1');
  });

  it('закрытое — с состоянием: сделано или отменено', () => {
    const facts = questionFacts({
      question: 'что там с няней',
      now,
      timeZone: MOSCOW,
      texts: defaultTexts,
      answer: {
        kind: 'aboutClosed',
        items: [
          item('Найти няню', { status: 'done', completedAt: day(-2) }),
          item('Позвонить в агентство', { status: 'cancelled' }),
        ],
      },
    });

    expect(facts).toContain('— Найти няню (дом) — сделано');
    expect(facts).toContain('— Позвонить в агентство (дом) — отменено');
  });

  it('большая цель — что сделано, что дальше, что осталось', () => {
    const facts = questionFacts({
      question: 'что там с днём рождения',
      now,
      timeZone: MOSCOW,
      texts: defaultTexts,
      answer: {
        kind: 'project',
        item: item('Спланировать день рождения мамы', { isProject: true }),
      },
      project: {
        steps: [],
        done: [{ id: 's1', text: 'Выбрать ресторан' } as never],
        remaining: [
          { id: 's2', text: 'Разослать приглашения' } as never,
          { id: 's3', text: 'Заказать торт' } as never,
        ],
        next: { id: 's2', text: 'Разослать приглашения' } as never,
      },
    });

    expect(facts).toContain('Большая цель: Спланировать день рождения мамы');
    expect(facts).toContain('Сделано: Выбрать ресторан');
    expect(facts).toContain('Следующий шаг: Разослать приглашения');
    expect(facts).toContain('Осталось ещё: Заказать торт');
  });

  it('ничего не нашлось — обзор: сегодня, срок прошёл, ближайшие дни, цели', () => {
    const facts = questionFacts({
      question: 'как всё успеть',
      now,
      timeZone: MOSCOW,
      texts: defaultTexts,
      answer: { kind: 'nothing' },
      overview: [
        item('Сдать отчёт', { deadlineAt: day(0), deadlineAccuracy: 'day', deadlineTime: 21 * 60 }),
        item('Забрать справку', { deadlineAt: day(-6), deadlineAccuracy: 'day' }),
        item('Позвонить маме', { deadlineAt: day(2), deadlineAccuracy: 'day' }),
        item('Сделать ремонт в спальне', { isProject: true }),
        item('Когда-нибудь выучить испанский'),
      ],
    });

    expect(facts).toContain('По вопросу ничего не найдено');
    expect(facts).toContain('На сегодня: Сдать отчёт в 21:00');
    expect(facts).toContain('Срок прошёл: Забрать справку — 6 дней назад');
    expect(facts).toContain('Ближайшие дни: Позвонить маме — 24.09');
    expect(facts).toContain('Большие цели: Сделать ремонт в спальне');
    expect(facts).toContain('Открытых дел всего: 5');
    expect(facts).not.toContain('испанский');
  });
});

describe('страж ответа', () => {
  const facts = [
    'Вопрос: что важнее — ковёр или цветы',
    'Найдено по вопросу:',
    '— Заказать цветы (дом), срок: завтра',
    '— Купить ковёр в гостиную (дом), без срока',
  ].join('\n');

  it('три фразы и один вопрос — можно; больше — нет', () => {
    expect(
      checkLiveAnswer('Цветы — у них срок завтра. Ковёр без срока. Начать с цветов?', facts),
    ).toEqual({
      ok: true,
      line: 'Цветы — у них срок завтра. Ковёр без срока. Начать с цветов?',
    });
    expect(checkLiveAnswer('Раз. Два. Три. Четыре.', facts)).toMatchObject({
      ok: false,
      why: 'больше трёх предложений',
    });
    expect(checkLiveAnswer('Цветы? Или ковёр?', facts)).toMatchObject({
      ok: false,
      why: 'два вопроса',
    });
  });

  it('в ответе на вопрос «надо/нужно» о деле — не понукание, а ответ; «попробуй», «пора», «не забудь» — по-прежнему совет', () => {
    // Стенд 22.09.2026: «Сегодня надо купить молоко» на «мне сегодня надо
    // что-то купить?» — прямой ответ её же словами, не коучинг.
    expect(checkLiveAnswer('Сегодня надо купить молоко. Обои подождут.', facts)).toMatchObject({
      ok: true,
    });
    expect(checkLiveAnswer('Попробуй начать с цветов.', facts)).toMatchObject({
      ok: false,
      why: 'совет',
    });
    expect(checkLiveAnswer('Пора заняться ковром.', facts)).toMatchObject({
      ok: false,
      why: 'совет',
    });
  });

  it('те же правила голоса: без оценок, «вы» и чисел не из фактов', () => {
    expect(checkLiveAnswer('Ты молодец, что спросила.', facts)).toMatchObject({ ok: false });
    expect(checkLiveAnswer('У вас цветы на завтра.', facts)).toMatchObject({
      ok: false,
      why: 'на вы',
    });
    expect(checkLiveAnswer('Цветы через 3 дня.', facts)).toMatchObject({
      ok: false,
      why: 'число не из фактов: 3',
    });
  });

  it('слова открытия разбора здесь не запрещены: ответ может начинаться с «Записала»? — нет, но «Поняла» — да', () => {
    // У ответа на вопрос своего открытия нет — правило повтора не действует.
    expect(checkLiveAnswer('Поняла, цветы у тебя на завтра.', facts)).toMatchObject({ ok: true });
  });
});

describe('обращение к модели за ответом', () => {
  function prompts(schemaName: string): { get: () => Promise<ActivePrompt> } {
    return {
      get: () =>
        Promise.resolve({
          stage: 'answerer',
          version: schemaName === ANSWERER_SCHEMA_NAME ? 'answerer@1' : 'presenter@9',
          prompt: 'ОТВЕТ',
          schemaName,
          jsonSchema: {},
          schema: schemaName === ANSWERER_SCHEMA_NAME ? answererSchema : presenterV2Schema,
        }),
    };
  }

  const logger = { warn: () => undefined, info: () => undefined };

  function asking(answer: { answer: string } | Error): {
    seen: StructuredRequest[];
    ask: AskAnswer;
  } {
    const seen: StructuredRequest[] = [];
    return {
      seen,
      ask: (_deps, request) => {
        seen.push(request);
        if (answer instanceof Error) return Promise.reject(answer);
        return Promise.resolve({
          ok: true,
          value: answer,
          promptVersion: 'answerer@1',
          attempts: 1,
        });
      },
    };
  }

  const deps = (schemaName: string): AiClientDeps =>
    ({ prompts: prompts(schemaName), logger }) as unknown as AiClientDeps;

  it('факты уходят входом на этап answerer, ответ возвращается проверенным', async () => {
    const model = asking({ answer: 'Цветы — у них срок завтра, ковёр без срока.' });

    const outcome = await askLiveAnswer(
      deps(ANSWERER_SCHEMA_NAME),
      { facts: 'Вопрос: что важнее\n— Заказать цветы, срок: завтра', userId: 'u1', batchId: 'b1' },
      model.ask,
    );

    expect(outcome).toEqual({ line: 'Цветы — у них срок завтра, ковёр без срока.' });
    expect(model.seen[0]?.stage).toBe('answerer');
    expect(model.seen[0]?.input).toContain('Вопрос: что важнее');
  });

  it('ответ не прошёл стража или пуст — ответа нет, ошибок нет', async () => {
    const bad = await askLiveAnswer(
      deps(ANSWERER_SCHEMA_NAME),
      { facts: 'Вопрос: что важнее' },
      asking({ answer: 'Не переживай, всё будет хорошо.' }).ask,
    );
    expect(bad.line).toBeUndefined();
    expect(bad.why).toContain('запрет');

    const empty = await askLiveAnswer(
      deps(ANSWERER_SCHEMA_NAME),
      { facts: 'Вопрос: что важнее' },
      asking({ answer: '' }).ask,
    );
    expect(empty).toEqual({ why: 'пусто' });

    const failed = await askLiveAnswer(
      deps(ANSWERER_SCHEMA_NAME),
      { facts: 'Вопрос: что важнее' },
      asking(new Error('сеть')).ask,
    );
    expect(failed.line).toBeUndefined();
  });

  it('промпт не той схемы — модель не зовётся', async () => {
    const model = asking({ answer: 'что-то' });

    const outcome = await askLiveAnswer(deps(PRESENTER_V2_SCHEMA_NAME), { facts: 'x' }, model.ask);

    expect(outcome.why).toContain('не той схемы');
    expect(model.seen).toHaveLength(0);
  });
});
