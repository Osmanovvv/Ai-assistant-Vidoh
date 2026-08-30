import { describe, expect, it } from 'vitest';

import { frequencyFor, intervalDays, morningDue, SLOW_AFTER, WEEKLY_AFTER } from './frequency.js';

/**
 * Снижение частоты (задача 3.17).
 *
 * Условие готовности: «десять проигнорированных напоминаний переводят
 * пользователя на недельную частоту автоматически». Проверяется здесь
 * прямым счётом, а не наблюдением за поднятым планировщиком.
 */

describe('пороги', () => {
  it('до пяти — каждый день', () => {
    expect(frequencyFor(0)).toBe('daily');
    expect(frequencyFor(4)).toBe('daily');
  });

  it('на пятом — через день', () => {
    expect(frequencyFor(SLOW_AFTER)).toBe('everyOther');
    expect(frequencyFor(9)).toBe('everyOther');
  });

  it('на десятом — раз в неделю', () => {
    expect(frequencyFor(WEEKLY_AFTER)).toBe('weekly');
  });

  it('дальше не редеет: раз в неделю — дно', () => {
    // Бесконечное разрежение означало бы, что вернуться в разговор нечем.
    expect(frequencyFor(100)).toBe('weekly');
    expect(intervalDays(frequencyFor(100))).toBe(7);
  });
});

describe('пора ли утреннее', () => {
  const day = 20_000; // произвольный местный день числом

  it('ни разу не отправляли — пора', () => {
    expect(morningDue({ today: day, ignoredStreak: 0 })).toBe(true);
  });

  it('вчера отправляли, серии нет — пора', () => {
    expect(morningDue({ today: day, lastMorningDay: day - 1, ignoredStreak: 0 })).toBe(true);
  });

  it('сегодня уже отправляли — не пора', () => {
    expect(morningDue({ today: day, lastMorningDay: day, ignoredStreak: 0 })).toBe(false);
  });

  it('пять молчаний: вчерашнее не даёт отправить сегодня', () => {
    expect(morningDue({ today: day, lastMorningDay: day - 1, ignoredStreak: 5 })).toBe(false);
  });

  it('пять молчаний: позавчерашнее даёт', () => {
    expect(morningDue({ today: day, lastMorningDay: day - 2, ignoredStreak: 5 })).toBe(true);
  });

  it('десять молчаний: шесть дней мало, семь достаточно', () => {
    expect(morningDue({ today: day, lastMorningDay: day - 6, ignoredStreak: 10 })).toBe(false);
    expect(morningDue({ today: day, lastMorningDay: day - 7, ignoredStreak: 10 })).toBe(true);
  });
});

describe('счётчик сбрасывается сам', () => {
  /**
   * Серия — это производная от истории, а не хранимое число: человек,
   * ответивший один раз, немедленно возвращается на ежедневную частоту,
   * и обнулять для этого ничего не нужно.
   */
  it('серия оборвалась — снова каждый день', () => {
    const day = 20_000;

    expect(morningDue({ today: day, lastMorningDay: day - 1, ignoredStreak: 11 })).toBe(false);
    expect(morningDue({ today: day, lastMorningDay: day - 1, ignoredStreak: 0 })).toBe(true);
  });
});
