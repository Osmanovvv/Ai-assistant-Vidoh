import { describe, expect, it } from 'vitest';

import type { Item } from '../../db/schema.js';
import { LIMIT_BY_ENERGY, effectiveEnergy, isShowable, selectForOutput } from './filter.js';

/**
 * Выдача — единственный шаг конвейера без спецификации в ТЗ, и при этом
 * именно она определяет, что человек увидит. Поэтому проверяется таблицей
 * случаев: один и тот же набор при одинаковом уровне сил обязан давать
 * одну и ту же выдачу всегда.
 */

const MOSCOW = 'Europe/Moscow';
/** Пятница, 4 сентября 2026, 12:00 по Москве. */
const NOW = new Date('2026-09-04T09:00:00.000Z');

let counter = 0;

/** Запись со всем нужным по умолчанию; переопределяется точечно. */
function item(overrides: Partial<Item> = {}): Item {
  counter++;

  return {
    id: `00000000-0000-0000-0000-${String(counter).padStart(12, '0')}`,
    userId: 'user',
    sourceBatchId: null,
    sourceOrder: null,
    text: `дело ${String(counter)}`,
    type: 'TASK',
    priority: 'SOON',
    topic: 'личное',
    status: 'new',
    isProject: false,
    assignee: null,
    deadlineAt: null,
    deadlineAccuracy: null,
    embedding: null,
    isDraft: false,
    draftReason: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** Дата в поясе Москвы как момент начала суток. */
const day = (iso: string) => new Date(`${iso}T00:00:00.000+03:00`);

const context = { energy: 'normal' as const, now: NOW, timeZone: MOSCOW };

describe('что вообще попадает в выдачу', () => {
  it('задача с приоритетом попадает', () => {
    expect(isShowable(item())).toBe(true);
  });

  const excluded: readonly [string, Partial<Item>][] = [
    ['желание', { type: 'DESIRE', priority: 'NONE' }],
    ['идея', { type: 'IDEA', priority: 'NONE' }],
    ['информация', { type: 'INFO', priority: 'NONE' }],
    ['эмоция', { type: 'EMOTION', priority: 'NONE' }],
    ['задача с приоритетом NONE', { priority: 'NONE' }],
    ['выполненное', { status: 'done' }],
    ['отменённое', { status: 'cancelled' }],
    ['отложенное', { status: 'snoozed' }],
    ['делегированное', { status: 'delegated' }],
    ['черновик', { isDraft: true, type: null, priority: null, topic: null }],
  ];

  for (const [what, overrides] of excluded) {
    it(`не попадает: ${what}`, () => {
      expect(isShowable(item(overrides))).toBe(false);
    });
  }

  it('желание не попадает даже с высоким приоритетом', () => {
    // Классификация приводит тип и приоритет в согласие, но выдача не
    // должна зависеть от того, что кто-то раньше всё сделал правильно.
    expect(isShowable(item({ type: 'DESIRE', priority: 'NOW' }))).toBe(false);
  });
});

describe('порядок', () => {
  it('просроченное идёт первым, даже если приоритет ниже', () => {
    const overdue = item({
      priority: 'LATER',
      deadlineAt: day('2026-09-01'),
      deadlineAccuracy: 'day',
    });
    const urgent = item({ priority: 'NOW' });

    const result = selectForOutput([urgent, overdue], context);

    expect(result.shown[0]?.id).toBe(overdue.id);
  });

  it('срок сегодня идёт раньше приоритета NOW без срока', () => {
    const today = item({
      priority: 'SOON',
      deadlineAt: day('2026-09-04'),
      deadlineAccuracy: 'day',
    });
    const urgent = item({ priority: 'NOW' });

    const result = selectForOutput([urgent, today], context);

    expect(result.shown[0]?.id).toBe(today.id);
  });

  it('NOW идёт раньше SOON', () => {
    const soon = item({ priority: 'SOON' });
    const urgent = item({ priority: 'NOW' });

    expect(selectForOutput([soon, urgent], context).shown[0]?.id).toBe(urgent.id);
  });

  it('среди SOON раньше тот, у кого срок ближе', () => {
    const later = item({
      priority: 'SOON',
      deadlineAt: day('2026-09-20'),
      deadlineAccuracy: 'day',
    });
    const sooner = item({
      priority: 'SOON',
      deadlineAt: day('2026-09-07'),
      deadlineAccuracy: 'day',
    });

    const result = selectForOutput([later, sooner], { ...context, energy: 'high' });

    expect(result.shown.map((row) => row.id)).toEqual([sooner.id, later.id]);
  });

  it('бессрочное идёт после срочного при равном приоритете', () => {
    const dated = item({
      priority: 'SOON',
      deadlineAt: day('2026-09-20'),
      deadlineAccuracy: 'day',
    });
    const undated = item({ priority: 'SOON' });

    const result = selectForOutput([undated, dated], context);

    expect(result.shown[0]?.id).toBe(dated.id);
  });

  it('LATER идёт последним', () => {
    const later = item({ priority: 'LATER' });
    const soon = item({ priority: 'SOON' });

    expect(selectForOutput([later, soon], context).shown[0]?.id).toBe(soon.id);
  });

  it('срок завтра — это не «сегодня»', () => {
    // Граница суток считается по поясу человека, а не по UTC.
    const tomorrow = item({
      priority: 'LATER',
      deadlineAt: day('2026-09-05'),
      deadlineAccuracy: 'day',
    });
    const urgent = item({ priority: 'NOW' });

    expect(selectForOutput([tomorrow, urgent], context).shown[0]?.id).toBe(urgent.id);
  });
});

describe('лимиты по уровню сил', () => {
  const many = () => [
    item({ priority: 'NOW' }),
    item({ priority: 'NOW' }),
    item({ priority: 'NOW' }),
    item({ priority: 'NOW' }),
    item({ priority: 'NOW' }),
  ];

  it('таблица лимитов соответствует плану', () => {
    expect(LIMIT_BY_ENERGY).toEqual({ high: 3, normal: 3, low: 2, empty: 1 });
  });

  for (const [energy, expected] of [
    ['high', 3],
    ['normal', 3],
    ['low', 2],
    ['empty', 1],
  ] as const) {
    it(`при «${energy}» показывает ${String(expected)}`, () => {
      const result = selectForOutput(many(), { ...context, energy });

      expect(result.shown).toHaveLength(expected);
      expect(result.hidden).toBe(5 - expected);
    });
  }

  it('когда дел меньше лимита, скрытых нет', () => {
    const result = selectForOutput([item(), item()], context);

    expect(result.shown).toHaveLength(2);
    expect(result.hidden).toBe(0);
  });

  it('пустой набор не ломает', () => {
    expect(selectForOutput([], context)).toEqual({ shown: [], hidden: 0 });
  });

  it('скрытыми считаются только годные к выдаче', () => {
    // Иначе бот скажет «остальное сохранила» про пять эмоций.
    const result = selectForOutput(
      [item({ priority: 'NOW' }), item({ type: 'EMOTION', priority: 'NONE' })],
      { ...context, energy: 'empty' },
    );

    expect(result.shown).toHaveLength(1);
    expect(result.hidden).toBe(0);
  });
});

describe('воспроизводимость', () => {
  it('один и тот же набор даёт одну и ту же выдачу', () => {
    // Условие готовности задачи 2.10 дословно.
    const items = [
      item({ priority: 'SOON', deadlineAt: day('2026-09-10'), deadlineAccuracy: 'day' }),
      item({ priority: 'NOW' }),
      item({ priority: 'LATER' }),
      item({ priority: 'SOON', deadlineAt: day('2026-09-10'), deadlineAccuracy: 'day' }),
    ];

    const first = selectForOutput(items, context);
    const second = selectForOutput([...items].reverse(), context);

    expect(first.shown.map((row) => row.id)).toEqual(second.shown.map((row) => row.id));
  });

  it('записи с одинаковым сроком не меняются местами', () => {
    // Без разрешения ничьих выдача плавала бы между запусками, и критерий
    // «одинаковая выдача» стал бы недостижим.
    const deadlineAt = day('2026-09-10');
    const createdAt = new Date('2026-09-01T00:00:00.000Z');

    const a = item({
      id: 'aaaa',
      priority: 'SOON',
      deadlineAt,
      deadlineAccuracy: 'day',
      createdAt,
    });
    const b = item({
      id: 'bbbb',
      priority: 'SOON',
      deadlineAt,
      deadlineAccuracy: 'day',
      createdAt,
    });

    expect(selectForOutput([b, a], context).shown.map((row) => row.id)).toEqual(['aaaa', 'bbbb']);
  });

  it('раньше созданное идёт первым при равном сроке', () => {
    const deadlineAt = day('2026-09-10');
    const older = item({
      priority: 'SOON',
      deadlineAt,
      deadlineAccuracy: 'day',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    const newer = item({
      priority: 'SOON',
      deadlineAt,
      deadlineAccuracy: 'day',
      createdAt: new Date('2026-09-03T00:00:00.000Z'),
    });

    expect(selectForOutput([newer, older], context).shown[0]?.id).toBe(older.id);
  });
});

describe('effectiveEnergy', () => {
  it('без состояния берёт значение из настроек', () => {
    expect(effectiveEnergy(undefined, 'normal', { now: NOW, timeZone: MOSCOW })).toBe('normal');
  });

  it('названный сегодня уровень действует', () => {
    const state = { energy: 'empty' as const, energyAt: new Date('2026-09-04T05:00:00.000Z') };

    expect(effectiveEnergy(state, 'normal', { now: NOW, timeZone: MOSCOW })).toBe('empty');
  });

  it('названный вчера — уже нет', () => {
    // «Я на нуле» сказанное утром не должно решать за человека неделю.
    const state = { energy: 'empty' as const, energyAt: new Date('2026-09-03T05:00:00.000Z') };

    expect(effectiveEnergy(state, 'normal', { now: NOW, timeZone: MOSCOW })).toBe('normal');
  });

  it('смена суток считается по поясу человека', () => {
    // 4 сентября 20:30 по Москве — это уже 5 сентября во Владивостоке,
    // значит для владивостокского человека уровень вчерашний.
    const state = { energy: 'low' as const, energyAt: new Date('2026-09-04T09:00:00.000Z') };
    const now = new Date('2026-09-04T17:30:00.000Z');

    expect(effectiveEnergy(state, 'normal', { now, timeZone: MOSCOW })).toBe('low');
    expect(effectiveEnergy(state, 'normal', { now, timeZone: 'Asia/Vladivostok' })).toBe('normal');
  });
});
