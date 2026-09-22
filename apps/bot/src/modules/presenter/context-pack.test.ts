import { describe, expect, it } from 'vitest';

import { defaultTexts } from '../../texts/index.js';
import { mentionedIn, packContext, renderContextPack, type ContextPack } from './context-pack.js';

/**
 * Контекст для живой строки (22.09.2026): что бот знает о женщине к
 * моменту ответа — собирается кодом из её же записей, модель ничего не
 * ищет сама. Проверяется отбор (что попадает, что нет, сколько) и
 * рендер в текст для промпта.
 */
const MOSCOW = 'Europe/Moscow';
// Вторник 22.09.2026, 19:30 МСК.
const now = new Date('2026-09-22T16:30:00.000Z');

const day = (offset: number): Date => new Date(Date.UTC(2026, 8, 22 + offset, -3, 0, 0));

let seq = 0;

function open(
  text: string,
  extra: Partial<{
    id: string;
    lineMentionedAt: Date | null;
    deadlineAt: Date | null;
    deadlineAccuracy: 'day' | 'week' | 'month' | null;
    deadlineTime: number | null;
    isProject: boolean;
    sourceBatchId: string | null;
    status: 'new' | 'done';
    completedAt: Date | null;
    createdAt: Date;
  }> = {},
) {
  seq += 1;
  return {
    id: extra.id ?? `item-${String(seq)}`,
    lineMentionedAt: extra.lineMentionedAt ?? null,
    text,
    deadlineAt: extra.deadlineAt ?? null,
    deadlineAccuracy: extra.deadlineAccuracy ?? null,
    deadlineTime: extra.deadlineTime ?? null,
    isProject: extra.isProject ?? false,
    sourceBatchId: extra.sourceBatchId ?? 'old-batch',
    status: extra.status ?? 'new',
    completedAt: extra.completedAt ?? null,
    createdAt: extra.createdAt ?? day(-10),
  };
}

const base = {
  now,
  timeZone: MOSCOW,
  texts: defaultTexts,
  batchId: 'this-batch',
  name: 'Оля',
  previousBatchAt: day(-3),
  units: [
    { text: 'записаться к стоматологу', type: 'TASK' as const, topic: 'здоровье' },
    {
      text: 'купить хлеб',
      type: 'TASK' as const,
      topic: 'покупки',
      deadline: { at: day(1), accuracy: 'day' },
    },
    { text: 'хочу научиться рисовать', type: 'DESIRE' as const, topic: 'личное' },
    { text: 'устала', type: 'EMOTION' as const, topic: 'личное' },
  ],
  known: ['записаться к стоматологу'],
  openItems: [],
  doneItems: [],
  mood: undefined,
};

describe('отбор контекста', () => {
  it('имя, время суток, дней с прошлой выгрузки', () => {
    const pack = packContext(base);

    expect(pack.name).toBe('Оля');
    expect(pack.partOfDay).toBe('вечер');
    expect(pack.daysSinceLast).toBe(3);
  });

  it('первая выгрузка — дней с прошлой нет', () => {
    expect(packContext({ ...base, previousBatchAt: undefined }).daysSinceLast).toBeUndefined();
  });

  it('записанное сейчас — дела и желания со сферой и сроком словами, без состояний', () => {
    const pack = packContext(base);

    expect(pack.recorded).toEqual([
      { title: 'записаться к стоматологу', topic: 'здоровье', due: undefined },
      { title: 'купить хлеб', topic: 'покупки', due: 'завтра' },
      { title: 'хочу научиться рисовать', topic: 'личное', due: undefined },
    ]);
  });

  it('уже известное — то из выгрузки, что совпало с прежней записью', () => {
    expect(packContext(base).alreadyKnown).toEqual(['записаться к стоматологу']);
  });

  it('просроченное — открытые дела с дневным сроком раньше сегодня, старые первыми, не больше трёх', () => {
    const pack = packContext({
      ...base,
      openItems: [
        open('позвонить в банк', { deadlineAt: day(-1), deadlineAccuracy: 'day' }),
        open('забрать справку', { deadlineAt: day(-6), deadlineAccuracy: 'day' }),
        open('оплатить интернет', { deadlineAt: day(-2), deadlineAccuracy: 'day' }),
        open('написать учительнице', { deadlineAt: day(-4), deadlineAccuracy: 'day' }),
        // Сегодня — не просрочено; неделя — не дневной срок.
        open('сдать отчёт', { deadlineAt: day(0), deadlineAccuracy: 'day' }),
        open('разобрать шкаф', { deadlineAt: day(-7), deadlineAccuracy: 'week' }),
      ],
    });

    expect(pack.overdue.map(({ title, daysLate }) => ({ title, daysLate }))).toEqual([
      { title: 'забрать справку', daysLate: 6 },
      { title: 'написать учительнице', daysLate: 4 },
      { title: 'оплатить интернет', daysLate: 2 },
    ]);
  });

  it('на сегодня — прежние дела с дневным сроком сегодня, с часом; из этой выгрузки — нет', () => {
    const pack = packContext({
      ...base,
      openItems: [
        open('сдать отчёт', { deadlineAt: day(0), deadlineAccuracy: 'day', deadlineTime: 21 * 60 }),
        open('купить хлеб', {
          deadlineAt: day(0),
          deadlineAccuracy: 'day',
          sourceBatchId: 'this-batch',
        }),
      ],
    });

    expect(pack.today.map(({ title, time }) => ({ title, time }))).toEqual([
      { title: 'сдать отчёт', time: '21:00' },
    ]);
  });

  it('большие цели — до двух; недавно закрытое — за три дня, до трёх', () => {
    const pack = packContext({
      ...base,
      openItems: [
        open('сделать ремонт в спальне', { isProject: true }),
        open('подготовить годовщину', { isProject: true }),
        open('выучить испанский', { isProject: true }),
      ],
      doneItems: [
        open('найти няню', { status: 'done', completedAt: day(-1) }),
        open('купить обои', { status: 'done', completedAt: day(-2) }),
        open('старое', { status: 'done', completedAt: day(-9) }),
      ],
    });

    expect(pack.projects).toEqual(['сделать ремонт в спальне', 'подготовить годовщину']);
    expect(pack.doneRecently).toEqual(['найти няню', 'купить обои']);
  });

  it('всего открытых — по списку, без записей этой выгрузки', () => {
    const pack = packContext({
      ...base,
      openItems: [open('а'), open('б'), open('в', { sourceBatchId: 'this-batch' })],
    });

    expect(pack.openTotal).toBe(2);
  });

  it('запись, о которой строка говорила меньше трёх дней назад, в поводы не идёт (хвост слоя A, 22.09.2026)', () => {
    // «Про отчёт помню» в каждой выгрузке подряд — снова шаблон. Три дня
    // после упоминания — другой повод или пусто.
    const pack = packContext({
      ...base,
      openItems: [
        open('сдать отчёт', {
          deadlineAt: day(-22),
          deadlineAccuracy: 'day',
          lineMentionedAt: day(-1),
        }),
        open('оплатить садик', {
          deadlineAt: day(-3),
          deadlineAccuracy: 'day',
          lineMentionedAt: day(-4),
        }),
        open('сдать отчёт по проекту', {
          deadlineAt: day(0),
          deadlineAccuracy: 'day',
          lineMentionedAt: day(0),
        }),
        open('ремонт', { isProject: true, lineMentionedAt: day(-2) }),
      ],
      doneItems: [
        open('найти няню', { status: 'done', completedAt: day(-1), lineMentionedAt: day(-1) }),
      ],
    });

    expect(pack.overdue.map((one) => one.title)).toEqual(['оплатить садик']);
    expect(pack.today).toEqual([]);
    expect(pack.projects).toEqual([]);
    expect(pack.doneRecently).toEqual([]);
  });

  it('у поводов есть идентификаторы записей — чтобы отметить, о ком сказала строка', () => {
    const pack = packContext({
      ...base,
      openItems: [
        open('сдать отчёт', { id: 'i-report', deadlineAt: day(-2), deadlineAccuracy: 'day' }),
      ],
    });

    expect(pack.overdue[0]?.id).toBe('i-report');
  });

  it('заголовки — без даты в хвосте и с обрезкой длинных', () => {
    const pack = packContext({
      ...base,
      units: [
        {
          text: 'позвонить в банк завтра',
          type: 'TASK',
          topic: 'быт',
          deadline: { at: day(1), accuracy: 'day' },
        },
        { text: 'о'.repeat(120), type: 'TASK', topic: 'быт' },
      ],
    });

    expect(pack.recorded[0]?.title).toBe('позвонить в банк');
    expect(pack.recorded[1]?.title.length).toBeLessThanOrEqual(81);
  });
});

describe('рендер контекста для промпта', () => {
  const pack: ContextPack = {
    name: 'Оля',
    partOfDay: 'вечер',
    daysSinceLast: 3,
    recorded: [
      { title: 'записаться к стоматологу', topic: 'здоровье', due: undefined },
      { title: 'купить хлеб', topic: 'покупки', due: 'завтра' },
    ],
    alreadyKnown: ['записаться к стоматологу'],
    overdue: [{ title: 'забрать справку', daysLate: 6 }],
    today: [{ title: 'сдать отчёт', time: '21:00' }],
    projects: ['сделать ремонт в спальне'],
    doneRecently: ['найти няню'],
    openTotal: 14,
    mood: 'tired',
  };

  it('строки по разделам, каждая — только когда есть что сказать', () => {
    const text = renderContextPack(pack);

    expect(text).toContain('Имя: Оля');
    expect(text).toContain('Сейчас: вечер');
    expect(text).toContain('Прошлая выгрузка: 3 дня назад');
    expect(text).toContain('— записаться к стоматологу (здоровье) — уже было записано раньше');
    expect(text).toContain('— купить хлеб (покупки), срок: завтра');
    expect(text).toContain('Срок прошёл: забрать справку — 6 дней назад');
    expect(text).toContain('Ещё на сегодня: сдать отчёт в 21:00');
    expect(text).toContain('Большие цели: сделать ремонт в спальне');
    expect(text).toContain('Недавно закрыла: найти няню');
    expect(text).toContain('Открытых дел всего: 14');
    expect(text).toContain('Состояние: устала');
  });

  it('пустые разделы не печатаются, первая выгрузка названа', () => {
    const text = renderContextPack({
      ...pack,
      name: undefined,
      daysSinceLast: undefined,
      alreadyKnown: [],
      overdue: [],
      today: [],
      projects: [],
      doneRecently: [],
      mood: undefined,
    });

    expect(text).not.toContain('Имя');
    expect(text).toContain('Первая выгрузка');
    expect(text).not.toContain('Срок прошёл');
    expect(text).not.toContain('Ещё на сегодня');
    expect(text).not.toContain('Большие цели');
    expect(text).not.toContain('Недавно закрыла');
    expect(text).not.toContain('Состояние');
  });

  it('дни склоняются: 1 день, 2 дня, 5 дней', () => {
    expect(renderContextPack({ ...pack, daysSinceLast: 1 })).toContain('1 день назад');
    expect(renderContextPack({ ...pack, daysSinceLast: 5 })).toContain('5 дней назад');
    expect(renderContextPack({ ...pack, overdue: [{ title: 'а', daysLate: 1 }] })).toContain(
      'а — 1 день',
    );
  });
});

describe('о ком сказала строка', () => {
  /**
   * Модель идентификаторов не возвращает — сопоставляется словами: общая
   * основа значимого слова (≥ 4 букв) между строкой и заголовком повода.
   */
  const candidates = [
    { id: 'a', title: 'сдать отчёт в конце месяца' },
    { id: 'b', title: 'забрать ребёнка пораньше' },
    { id: 'c', title: 'оплатить садик до 20' },
    { id: 'd', title: 'найти няню' },
    { id: 'e', title: 'сделать ремонт в спальне' },
  ];

  it('находит записи по общим словам', () => {
    expect(mentionedIn('Про отчёт помню — запись никуда не делась.', candidates)).toEqual(['a']);
    expect(mentionedIn('Про садик и про ребёнка помню.', candidates)).toEqual(['b', 'c']);
    expect(mentionedIn('Няню ты нашла — тот вопрос закрыт.', candidates)).toEqual(['d']);
    expect(mentionedIn('Обои и шторы — это к ремонту спальни.', candidates)).toEqual(['e']);
  });

  it('служебные слова строки не считаются: «запись», «помню», «дней»', () => {
    expect(mentionedIn('Пять дней тишины — теперь всё здесь.', candidates)).toEqual([]);
    expect(mentionedIn('Первый раз — дальше можно просто скидывать сюда.', candidates)).toEqual([]);
  });
});
