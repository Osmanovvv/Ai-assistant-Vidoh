import { describe, expect, it } from 'vitest';

import type { AiClientDeps, StructuredRequest } from '../ai/client.js';
import type { ActivePrompt } from '../ai/prompts/registry.js';
import {
  ANSWERER_SCHEMA_NAME,
  answererSchema,
  TALKER_SCHEMA_NAME,
  talkerSchema,
} from '../ai/schemas/index.js';
import type { Item } from '../../db/schema.js';
import { defaultTexts } from '../../texts/index.js';

import { addressesBot, askTalk, checkTalk, onlyAck, talkFacts, type AskTalk } from './talk.js';

/**
 * Живой ответ там, где у бота нет своего (план docs/29, 28.09.2026):
 * болтовня, вопрос про бота, просьба, чувства без дел, обрывок. Модель
 * говорит своими словами, факты даёт код, код проверяет каждый ответ; не
 * прошло — ответ словарный, как раньше.
 */
const MOSCOW = 'Europe/Moscow';
const now = new Date('2026-09-28T16:00:00.000Z'); // 19:00 МСК, понедельник
const day = (offset: number): Date => new Date(Date.UTC(2026, 8, 28 + offset, -3, 0, 0));

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
    createdAt: day(-2),
    updatedAt: day(-2),
    ...extra,
  };
}

const parcel = item('Забрать посылку', {
  deadlineAt: day(0),
  deadlineAccuracy: 'day',
  deadlineTime: 20 * 60,
});
const mom = item('Позвонить маме', { deadlineAt: day(1), deadlineAccuracy: 'day' });

function factsFor(said: string, extra: Partial<Parameters<typeof talkFacts>[0]> = {}): string {
  return talkFacts({
    said,
    now,
    timeZone: MOSCOW,
    texts: defaultTexts,
    overview: [parcel, mom],
    ...extra,
  });
}

describe('«ок» — смайлик, без модели (решение Никиты 28.09.2026)', () => {
  it.each([
    'ок',
    'Ок.',
    'окей',
    'ok',
    'Понятно',
    'ясно',
    'ага',
    'угу',
    'Хорошо',
    'ладно',
    '👍',
    '👌',
  ])('«%s» — да', (said) => {
    expect(onlyAck(said)).toBe(true);
  });

  it.each([
    'Ладно, пока',
    'ок, завтра к врачу',
    'Хорошего дня',
    'понятно, а что на завтра?',
    'не понятно',
    'хорошо бы выспаться',
  ])('«%s» — нет: там есть что сказать', (said) => {
    expect(onlyAck(said)).toBe(false);
  });
});

describe('вопрос к самому боту (бой 28.09.2026, 20:14)', () => {
  it.each([
    'Ты вообще меня понимаешь?',
    'ты меня слушаешь вообще',
    'А тебе не скучно?',
    'Ты умная?',
  ])('«%s» — к боту', (said) => {
    expect(addressesBot(said)).toBe(true);
  });

  it.each(['Что там с котом?', 'Когда у меня отчёт?', 'Что я хотела купить?'])(
    '«%s» — про её дела',
    (said) => {
      expect(addressesBot(said)).toBe(false);
    },
  );
});

describe('факты для живого ответа', () => {
  it('реплика, время суток и её ближайшие дела', () => {
    const facts = factsFor('Ты меня понимаешь?');

    expect(facts).toContain('Реплика: Ты меня понимаешь?');
    expect(facts).toContain('Сейчас: вечер');
    expect(facts).toContain('На сегодня: Забрать посылку в 20:00');
    expect(facts).toContain('Позвонить маме');
  });

  it('чувство по её словам — строкой, чтобы тон шёл от силы', () => {
    expect(factsFor('Я в панике', { mood: 'heavy' })).toContain('Чувство: сильное');
    expect(factsFor('Устала', { mood: 'tired' })).toContain('Чувство: усталость');
    expect(factsFor('Бесит', { mood: 'annoyed' })).toContain('Чувство: досада');
    expect(factsFor('Привет')).not.toContain('Чувство');
  });

  it('вопрос уже открыт — сказано, что своего не задавать', () => {
    expect(factsFor('Второе', { questionOpen: true })).toContain('Свой вопрос не задавай');
    expect(factsFor('Второе')).not.toContain('Свой вопрос не задавай');
  });

  it('последние реплики разговора — чтобы «Второе» было понятно', () => {
    const facts = factsFor('Второе', {
      dialog: [
        {
          role: 'bot',
          text: 'Какое дело: 1. Туфли 2. Посылка?',
          at: new Date(now.getTime() - 60_000),
        },
      ],
    });

    expect(facts).toContain('Бот: Какое дело: 1. Туфли 2. Посылка?');
  });
});

describe('страж живого ответа', () => {
  const facts = factsFor('Что приготовить на ужин?');

  it.each([
    'Привет 🙂 Если что-то крутится в голове — скидывай сюда.',
    'Можно запечь курицу с картошкой или сделать пасту с овощами.',
    'Заказать пиццу сама не могу, но могу записать это делом.',
    'Могу напомнить, если скажешь когда.',
    'Вот три идеи: омлет, гречка с котлетой или паста.',
    'Про посылку помню — сегодня в 20:00.',
    'Поздравляю 🙌 Теперь полна сил.',
    'Рада за тебя 🙂',
  ])('пропускает: «%s»', (reply) => {
    expect(checkTalk(reply, facts, {})).toEqual({ ok: true, line: reply });
  });

  it('15% от 3000 — посчитать можно: голые числа не сроки', () => {
    const calc = factsFor('Посчитай 15 процентов от 3000');
    expect(checkTalk('15% от 3000 — это 450.', calc, {}).ok).toBe(true);
  });

  it.each([
    ['Посылку заберёшь в 18:30.', 'число не из фактов'],
    ['Посылка сегодня 18:30, помню.', 'число не из фактов'],
    ['Маме звонить 30.09.', 'число не из фактов'],
    ['Маме позвонишь в среду.', 'день недели не из фактов'],
    ['Записала: купить хлеб.', 'сделано не было'],
    ['Удалила, больше не напомню.', 'сделано не было'],
    ['Напомню тебе завтра утром.', 'обещание напомнить'],
    ['Всё будет хорошо.', 'запрет'],
    ['Не переживай, я рядом.', 'запрет'],
    ['Как вы?', 'на вы'],
    ['Понял тебя.', 'мужской род'],
    ['У тебя пять дел на сегодня.', 'число не из фактов'],
    ['Как дела? Что на ужин?', 'два вопроса'],
    ['Раз. Два. Три. Четыре.', 'больше трёх предложений'],
    // Замер talker@3 28.09.2026: о ней — мужским родом, и язык помощника-ИИ.
    ['Поздравляю 🙌 Теперь полон сил и энергии.', 'мужской род'],
    ['Рад за тебя 🙂', 'мужской род'],
    ['Привет! Чем могу помочь?', 'язык ИИ'],
    ['Обращайся, если что 🙂', 'язык ИИ'],
  ])('отвергает «%s» — %s', (reply, why) => {
    const checked = checkTalk(reply, facts, {});
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.why).toContain(why);
  });

  /**
   * Лишний смайлик — убрать, а не выкидывать ответ (проба talker@4
   * 28.09.2026: «Привет! 👋 Если что-то крутится…» падал в заготовку).
   */
  it.each([
    [
      'Привет! 👋 Если что-то крутится в голове — скидывай сюда.',
      {},
      'Привет! Если что-то крутится в голове — скидывай сюда.',
    ],
    ['Ха 😂', {}, 'Ха'],
    ['Привет 🙂🙌', {}, 'Привет 🙂'],
    ['Я здесь 😌 Давай по одному.', { mood: 'heavy' as const }, 'Я здесь. Давай по одному.'],
    ['Поздравляю 🎉', {}, 'Поздравляю'],
  ])('лишний смайлик убран: «%s»', (reply, options, line) => {
    expect(checkTalk(reply, facts, options)).toEqual({ ok: true, line });
  });

  it('один смайлик — и только смайлик: пусто, а не «»', () => {
    expect(checkTalk('🎉', facts, {})).toEqual({ ok: false, why: 'пусто' });
  });

  it('лёгкая усталость — её эмодзи можно', () => {
    const tired = factsFor('Устала', { mood: 'tired' });
    expect(checkTalk('Да, денёк был длинный 😮‍💨', tired, { mood: 'tired' }).ok).toBe(true);
  });

  it('вопрос уже открыт — своего нельзя', () => {
    const open = factsFor('Второе', { questionOpen: true });
    const checked = checkTalk('Второе — это про что?', open, { questionOpen: true });
    expect(checked.ok).toBe(false);
  });
});

describe('обращение к модели', () => {
  function deps(schemaName: string): AiClientDeps {
    return {
      prompts: {
        get: () =>
          Promise.resolve<ActivePrompt>({
            stage: 'talker',
            version: schemaName === TALKER_SCHEMA_NAME ? 'talker@1' : 'answerer@3',
            prompt: 'РАЗГОВОР',
            schemaName,
            jsonSchema: {},
            schema: schemaName === TALKER_SCHEMA_NAME ? talkerSchema : answererSchema,
          }),
      },
      logger: { warn: () => undefined, info: () => undefined },
    } as unknown as AiClientDeps;
  }

  function asking(reply: { reply: string } | Error): { seen: StructuredRequest[]; ask: AskTalk } {
    const seen: StructuredRequest[] = [];
    return {
      seen,
      ask: (_deps, request) => {
        seen.push(request);
        if (reply instanceof Error) return Promise.reject(reply);
        return Promise.resolve({ ok: true, value: reply, promptVersion: 'talker@1', attempts: 1 });
      },
    };
  }

  const facts = factsFor('Ты меня понимаешь?');

  it('ответ прошёл стража — он и уходит; этап — talker, вход — факты', async () => {
    const model = asking({ reply: 'Понимаю 🙂 Про посылку помню — сегодня в 20:00.' });

    const outcome = await askTalk(deps(TALKER_SCHEMA_NAME), { facts, batchId: 'b1' }, model.ask);

    expect(outcome).toEqual({ line: 'Понимаю 🙂 Про посылку помню — сегодня в 20:00.' });
    expect(model.seen[0]?.stage).toBe('talker');
    expect(model.seen[0]?.input).toBe(facts);
  });

  it('не прошёл, пусто, модель упала, промпт не той схемы — ответа нет, ошибок нет', async () => {
    const bad = await askTalk(
      deps(TALKER_SCHEMA_NAME),
      { facts },
      asking({ reply: 'Всё будет хорошо.' }).ask,
    );
    expect(bad.line).toBeUndefined();
    expect(bad.why).toContain('запрет');

    expect(await askTalk(deps(TALKER_SCHEMA_NAME), { facts }, asking({ reply: '' }).ask)).toEqual({
      why: 'пусто',
    });

    const failed = await askTalk(
      deps(TALKER_SCHEMA_NAME),
      { facts },
      asking(new Error('сеть')).ask,
    );
    expect(failed.line).toBeUndefined();

    const wrong = await askTalk(
      deps(ANSWERER_SCHEMA_NAME),
      { facts },
      asking({ reply: 'Привет' }).ask,
    );
    expect(wrong.line).toBeUndefined();
  });

  it('страж знает о силе чувства: при сильном смайлик убран', async () => {
    const heavy = factsFor('Я в панике', { mood: 'heavy' });
    const outcome = await askTalk(
      deps(TALKER_SCHEMA_NAME),
      { facts: heavy, mood: 'heavy' },
      asking({ reply: 'Я здесь 😌' }).ask,
    );
    expect(outcome.line).toBe('Я здесь');
  });
});
