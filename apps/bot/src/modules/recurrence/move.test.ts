import { describe, expect, it } from 'vitest';

import type { Item } from '../../db/schema.js';
import { nextDeadlineAfterDone } from './recurrence.service.js';

/**
 * Куда переезжает срок регулярного дела после отметки выполнения
 * (задача 3.8а, дефект найден ручным прогоном 31.08.2026).
 *
 * Три случая, и они разные по смыслу: человек мог сделать дело вовремя,
 * позже срока или **раньше** срока. Третий проверял никто, и он не
 * работал: отсчёт шёл только от сегодня, следующее повторение совпадало с
 * нынешним сроком, изменение выходило пустым. Запись оставалась на месте,
 * а человек получал «не разобрала», хотя всё сделал.
 *
 * Часы управляемые: `now` приходит аргументом.
 */

const MOSCOW = 'Europe/Moscow';

/** Понедельник. */
const MONDAY = new Date('2026-08-31T09:00:00.000Z');

/** Дело по вторникам, якорь — вторник 1 сентября. */
function weekly(deadline: string | null): Pick<Item, 'recurrenceRule' | 'deadlineAt'> {
  return {
    recurrenceRule: { kind: 'weekly', interval: 1, anchor: '2026-09-01' },
    deadlineAt: deadline === null ? null : new Date(deadline),
  };
}

/** Местная дата результата: «2026-09-08». */
function dayOf(at: Date | undefined): string {
  if (at === undefined) return 'нет';

  return new Intl.DateTimeFormat('sv-SE', { timeZone: MOSCOW }).format(at);
}

describe('сделал раньше срока', () => {
  /**
   * Регрессия. Отсчёт только от сегодня давал ту же дату, что уже стоит,
   * и перенос выходил пустым.
   */
  it('срок уезжает на следующее повторение, а не остаётся на месте', () => {
    const item = weekly('2026-09-01T00:00:00.000Z');

    const moved = nextDeadlineAfterDone(item, { now: MONDAY, timeZone: MOSCOW });

    expect(dayOf(moved)).toBe('2026-09-08');
  });

  it('и это точно другая дата, а не прежняя', () => {
    const item = weekly('2026-09-01T00:00:00.000Z');

    const moved = nextDeadlineAfterDone(item, { now: MONDAY, timeZone: MOSCOW });

    expect(moved?.getTime()).not.toBe(item.deadlineAt?.getTime());
  });

  it('за неделю до срока — тоже вперёд от срока, а не от сегодня', () => {
    // Иначе «сделал сильно заранее» вернуло бы ближайший вторник, то есть
    // назад относительно того, что уже стоит.
    const item = weekly('2026-09-15T00:00:00.000Z');

    expect(dayOf(nextDeadlineAfterDone(item, { now: MONDAY, timeZone: MOSCOW }))).toBe(
      '2026-09-22',
    );
  });
});

describe('сделал в срок', () => {
  it('срок уезжает на неделю вперёд', () => {
    const tuesday = new Date('2026-09-01T09:00:00.000Z');
    const item = weekly('2026-09-01T00:00:00.000Z');

    expect(dayOf(nextDeadlineAfterDone(item, { now: tuesday, timeZone: MOSCOW }))).toBe(
      '2026-09-08',
    );
  });
});

describe('пропустил', () => {
  /**
   * То, ради чего отсчёт от сегодня и появился: §13.6 запрещает подавать
   * пропуск как провал, а три шага по одному дали бы догоняющую очередь.
   */
  it('две пропущенные недели дают один ближайший вторник', () => {
    const item = weekly('2026-08-18T00:00:00.000Z');

    expect(dayOf(nextDeadlineAfterDone(item, { now: MONDAY, timeZone: MOSCOW }))).toBe(
      '2026-09-01',
    );
  });

  it('месяц пропуска — тоже один, а не четыре', () => {
    const item = weekly('2026-08-04T00:00:00.000Z');

    expect(dayOf(nextDeadlineAfterDone(item, { now: MONDAY, timeZone: MOSCOW }))).toBe(
      '2026-09-01',
    );
  });
});

describe('края', () => {
  it('без срока считаем от сегодня', () => {
    expect(dayOf(nextDeadlineAfterDone(weekly(null), { now: MONDAY, timeZone: MOSCOW }))).toBe(
      '2026-09-01',
    );
  });

  it('дело не регулярное — переносить нечего', () => {
    const plain = { recurrenceRule: null, deadlineAt: new Date('2026-09-01T00:00:00.000Z') };

    expect(nextDeadlineAfterDone(plain, { now: MONDAY, timeZone: MOSCOW })).toBeUndefined();
  });
});
