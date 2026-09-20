import { describe, expect, it } from 'vitest';

import type { Item } from '../../db/schema.js';
import { defaultTexts } from '../../texts/index.js';
import { picturesIn } from '../../texts/rules.js';
import { layoutMyTasks, pageOf, renderMyTasks } from './my-tasks.js';

/**
 * «Мои дела» — полный список актуальных незавершённых дел (ТЗ проджекта
 * 17.09.2026, 2.4). Маленький список — целиком, средний — по частям,
 * большой — постранично. Женщина должна почувствовать не масштаб
 * накопившегося, а порядок.
 */

const NOW = new Date('2026-09-20T09:00:00.000Z'); // воскресенье 20.09, полдень по Москве
const DAY = { now: NOW, timeZone: 'Europe/Moscow' };

let seq = 0;

function task(
  text: string,
  overrides: Partial<{
    topic: string | null;
    deadlineAt: Date | null;
    deadlineAccuracy: 'day' | 'week' | 'month' | null;
    deferredAt: Date | null;
    recurrenceText: string | null;
    type: Item['type'];
  }> = {},
): Item {
  seq += 1;
  return {
    id: `item-${String(seq)}`,
    text,
    type: 'TASK',
    topic: 'личное',
    deadlineAt: null,
    deadlineAccuracy: null,
    deferredAt: null,
    recurrenceRule: overrides.recurrenceText === undefined ? null : { kind: 'weekly' },
    recurrenceText: null,
    createdAt: new Date(NOW.getTime() - (1000 - seq) * 60_000),
    ...overrides,
  } as Item;
}

const many = (count: number, topic = 'работа'): Item[] =>
  Array.from({ length: count }, (_one, index) =>
    task(`${topic}: дело ${String(index + 1)}`, { topic }),
  );

describe('раскладка', () => {
  it('только дела: желания, идеи, сведения и чувства в список не идут', () => {
    const layout = layoutMyTasks(
      [
        task('Купить хлеб'),
        task('Съездить на море', { type: 'DESIRE' }),
        task('Общий календарь', { type: 'IDEA' }),
        task('У мамы день рождения', { type: 'INFO' }),
        task('Устала', { type: 'EMOTION' }),
      ],
      DAY,
    );

    expect(layout.total).toBe(1);
  });

  it('сферы только заполненные, где дел больше — выше; «Позже» — отдельным блоком в конце', () => {
    const layout = layoutMyTasks(
      [
        task('Заказать цветы', { topic: 'покупки' }),
        task('Съездить в офис', { topic: 'работа' }),
        task('Распечатать документы', { topic: 'работа' }),
        task('Разобрать шкаф', { topic: 'дом', deferredAt: NOW }),
      ],
      DAY,
    );

    expect(layout.groups.map((group) => [group.name, group.items.length])).toEqual([
      ['работа', 2],
      ['покупки', 1],
    ]);
    expect(layout.later.map((item) => item.text)).toEqual(['Разобрать шкаф']);
    expect(layout.total).toBe(4);
  });

  it('внутри сферы сначала с ближайшей датой, потом остальные', () => {
    const layout = layoutMyTasks(
      [
        task('Без срока', { topic: 'работа' }),
        task('Через неделю', {
          topic: 'работа',
          deadlineAt: new Date('2026-09-26T21:00:00.000Z'),
          deadlineAccuracy: 'day',
        }),
        task('Завтра', {
          topic: 'работа',
          deadlineAt: new Date('2026-09-20T21:00:00.000Z'),
          deadlineAccuracy: 'day',
        }),
      ],
      DAY,
    );

    expect(layout.groups[0]?.items.map((item) => item.text)).toEqual([
      'Завтра',
      'Через неделю',
      'Без срока',
    ]);
  });

  it('одно дело — один раз, даже если пришло дважды', () => {
    const one = task('Купить хлеб');
    const layout = layoutMyTasks([one, one], DAY);

    expect(layout.total).toBe(1);
  });
});

describe('до 15 дел — одно сообщение', () => {
  it('шапка с числом, сферы со счётчиками и иконками (при равном числе — по алфавиту), даты у датированных, «Позже», подпись', () => {
    const items = [
      task('Съездить в офис', { topic: 'работа' }),
      task('Распечатать документы', { topic: 'работа' }),
      task('Заказать цветы', { topic: 'покупки' }),
      task('Записаться к стоматологу в пятницу', {
        topic: 'личное',
        deadlineAt: new Date('2026-09-24T21:00:00.000Z'),
        deadlineAccuracy: 'day',
      }),
      task('Пить витамины', { topic: 'здоровье', recurrenceText: 'каждое утро' }),
      task('Разобрать шкаф', { topic: 'дом', deferredAt: NOW }),
    ];

    const view = renderMyTasks(layoutMyTasks(items, DAY), DAY, defaultTexts);

    expect(view.kind).toBe('single');
    expect(view.messages).toHaveLength(1);
    const text = view.messages[0] ?? '';
    expect(text.split('\n')).toEqual([
      'Вот что сейчас осталось — 6 дел.',
      '',
      '💼 Работа — 2',
      '— Съездить в офис',
      '— Распечатать документы',
      '',
      '💊 Здоровье — 1',
      '— Пить витамины · каждое утро',
      '',
      '🤍 Личное — 1',
      '— Записаться к стоматологу · 25.09',
      '',
      '🛒 Покупки — 1',
      '— Заказать цветы',
      '',
      '⏳ Позже — 1',
      '— Разобрать шкаф',
      '',
      'Всё актуальное сейчас здесь. Остальное я помню.',
    ]);
    expect(view.buttons.map((button) => button.label)).toEqual(['Выбрать главное', 'Добавить ещё']);
  });

  it('срок сегодня — словом, завтра — словом, неделя и месяц — словами карточки', () => {
    const items = [
      task('Сегодня', {
        deadlineAt: new Date('2026-09-19T21:00:00.000Z'),
        deadlineAccuracy: 'day',
      }),
      task('Завтра', { deadlineAt: new Date('2026-09-20T21:00:00.000Z'), deadlineAccuracy: 'day' }),
      task('Неделя', {
        deadlineAt: new Date('2026-09-20T21:00:00.000Z'),
        deadlineAccuracy: 'week',
      }),
    ];

    const text = renderMyTasks(layoutMyTasks(items, DAY), DAY, defaultTexts).messages[0] ?? '';

    expect(text).toContain('— Сегодня · сегодня');
    expect(text).toContain('— Завтра · завтра');
    expect(text).toContain('— Неделя · ' + defaultTexts.card.deadlineWeek('21.09'));
  });

  it('пустой список — «пусто», без сфер и без подписи', () => {
    const view = renderMyTasks(layoutMyTasks([], DAY), DAY, defaultTexts);

    expect(view.kind).toBe('empty');
    expect(view.messages).toEqual([defaultTexts.backlog.allEmpty]);
  });

  it('никаких «просрочено» и красных меток, никаких счётов дней', () => {
    const items = [
      task('Давно пора', {
        deadlineAt: new Date('2026-09-01T21:00:00.000Z'),
        deadlineAccuracy: 'day',
      }),
    ];
    const text = renderMyTasks(layoutMyTasks(items, DAY), DAY, defaultTexts).messages[0] ?? '';

    expect(text).not.toMatch(/просроч|❗|🔴|дней/iu);
    expect(text).toContain('— Давно пора · 02.09');
  });
});

describe('16–30 дел — по частям', () => {
  it('вступление про объём, потом 2–3 сообщения по сферам, сфера не рвётся', () => {
    const items = [
      ...many(8, 'работа'),
      ...many(5, 'покупки'),
      ...many(6, 'дом'),
      ...many(4, 'семья'),
    ];

    const view = renderMyTasks(layoutMyTasks(items, DAY), DAY, defaultTexts);

    expect(view.kind).toBe('parts');
    expect(view.messages[0]).toBe(
      'Я помню 23 незавершённых дела. Чтобы не заваливать тебя одной стеной текста, разложу всё по сферам и покажу в трёх коротких сообщениях — ничего не потеряю.',
    );
    const parts = view.messages.slice(1);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.length).toBeLessThanOrEqual(3);
    // Каждая сфера — целиком в одной части.
    for (const name of ['💼 Работа — 8', '🏠 Дом — 6', '🛒 Покупки — 5', '👨‍👩‍👧 Семья — 4']) {
      expect(parts.filter((part) => part.includes(name))).toHaveLength(1);
    }
    // Все дела на месте, без дублей.
    const lines = parts
      .join('\n')
      .split('\n')
      .filter((line) => line.startsWith('— '));
    expect(lines).toHaveLength(23);
    expect(new Set(lines).size).toBe(23);
    // Кнопки — только под последней частью.
    expect(view.buttons.map((button) => button.label)).toEqual(['Выбрать главное', 'Добавить ещё']);
  });

  it('очень большая сфера делится, остальные — нет', () => {
    const items = [...many(20, 'работа'), ...many(2, 'дом')];

    const view = renderMyTasks(layoutMyTasks(items, DAY), DAY, defaultTexts);

    const parts = view.messages.slice(1);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.filter((part) => part.includes('🏠 Дом — 2'))).toHaveLength(1);
    expect(
      parts
        .join('\n')
        .split('\n')
        .filter((line) => line.startsWith('— ')),
    ).toHaveLength(22);
  });
});

describe('больше 30 дел — сводка и страницы', () => {
  const items = [
    ...many(14, 'работа'),
    ...many(9, 'дом'),
    ...many(6, 'покупки'),
    ...many(5, 'личное'),
    ...many(4, 'семья').map((item) => ({ ...item, deferredAt: NOW })),
  ];

  it('сводка по сферам с числами, потом первая страница на 10–12 дел с «Показать ещё»', () => {
    const view = renderMyTasks(layoutMyTasks(items, DAY), DAY, defaultTexts);

    expect(view.kind).toBe('paged');
    expect(view.messages[0]?.split('\n')).toEqual([
      'Я помню 38 незавершённых дел.',
      '💼 Работа — 14',
      '🏠 Дом — 9',
      '🛒 Покупки — 6',
      '🤍 Личное — 5',
      '⏳ Позже — 4',
      '',
      'Покажу по частям, чтобы это можно было спокойно прочитать.',
    ]);
    const first = view.messages[1] ?? '';
    const shown = first.split('\n').filter((line) => line.startsWith('— '));
    expect(shown.length).toBeGreaterThanOrEqual(10);
    expect(shown.length).toBeLessThanOrEqual(12);
    expect(view.buttons.map((button) => button.label)).toEqual(['Показать ещё', 'Выбрать главное']);
  });

  it('страницы идут подряд без пропусков и дублей, у продолжения сферы — её шапка', () => {
    const layout = layoutMyTasks(items, DAY);
    const pages = [];
    for (let index = 0; ; index += 1) {
      const page = pageOf(layout, index, DAY, defaultTexts);
      if (page === undefined) break;
      pages.push(page);
    }

    const lines = pages.flatMap((page) =>
      page.text.split('\n').filter((line) => line.startsWith('— ')),
    );
    expect(lines).toHaveLength(38);
    expect(new Set(lines).size).toBe(38);
    // Вторая страница начинается с продолжения «Работы» — шапка повторена.
    expect(pages[1]?.text.split('\n')[0]).toBe('💼 Работа — 14');
    // Последняя страница: «Назад» есть, «Показать ещё» нет.
    const last = pages.at(-1);
    expect(last?.buttons.map((button) => button.label)).toEqual(['Назад', 'Выбрать главное']);
    // Средняя — обе.
    expect(pages[1]?.buttons.map((button) => button.label)).toEqual([
      'Показать ещё',
      'Назад',
      'Выбрать главное',
    ]);
  });

  it('страницы за пределом — нет', () => {
    expect(pageOf(layoutMyTasks(items, DAY), 99, DAY, defaultTexts)).toBeUndefined();
  });
});

describe('тон', () => {
  it('в сообщениях нет украшательских эмодзи, кроме иконок сфер', () => {
    const items = [...many(3, 'работа'), task('Разобрать шкаф', { topic: 'дом', deferredAt: NOW })];
    const view = renderMyTasks(layoutMyTasks(items, DAY), DAY, defaultTexts);
    const icons = new Set(['💼', '🏠', '⏳']);

    for (const symbol of picturesIn(view.messages.join('\n'))) {
      expect(icons.has(symbol), symbol).toBe(true);
    }
  });
});
