import { describe, expect, it } from 'vitest';

import { nudgeDue, PROJECT_NUDGE_COOLDOWN_DAYS, PROJECT_STALE_DAYS } from './projects.service.js';

/**
 * Напоминание о застрявшем проекте (§11 ТЗ, задача 3.13).
 *
 * «Если по проекту нет движения 7 дней, один вопрос про ближайший шаг,
 * не чаще раза в 5 дней.»
 *
 * Здесь важнее не «спросил ли», а **сколько раз промолчал**: продукт про
 * выдох, который раз в два дня спрашивает «ну что там с годовщиной»,
 * перестаёт быть продуктом про выдох.
 */

const NOW = new Date('2026-09-15T09:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY);

describe('когда спрашивать пора', () => {
  it('неделя без движения и ни разу не спрашивали', () => {
    expect(nudgeDue({ lastMovedAt: daysAgo(7), hasNext: true, now: NOW })).toBe(true);
  });

  it('спрашивали давно — можно снова', () => {
    expect(
      nudgeDue({ lastMovedAt: daysAgo(20), lastNudgeAt: daysAgo(6), hasNext: true, now: NOW }),
    ).toBe(true);
  });
});

describe('когда молчать', () => {
  it('движение было вчера', () => {
    expect(nudgeDue({ lastMovedAt: daysAgo(1), hasNext: true, now: NOW })).toBe(false);
  });

  it('шести дней мало: неделя — это семь', () => {
    expect(nudgeDue({ lastMovedAt: daysAgo(6), hasNext: true, now: NOW })).toBe(false);
  });

  it('спрашивали позавчера — рано', () => {
    // Продукт про выдох, который раз в два дня спрашивает «ну что там»,
    // перестаёт быть продуктом про выдох.
    expect(
      nudgeDue({ lastMovedAt: daysAgo(30), lastNudgeAt: daysAgo(2), hasNext: true, now: NOW }),
    ).toBe(false);
  });

  it('у законченного проекта спрашивать нечего', () => {
    expect(nudgeDue({ lastMovedAt: daysAgo(100), hasNext: false, now: NOW })).toBe(false);
  });
});

describe('числа названы там, где их видно', () => {
  it('семь дней тишины и пять между вопросами', () => {
    expect(PROJECT_STALE_DAYS).toBe(7);
    expect(PROJECT_NUDGE_COOLDOWN_DAYS).toBe(5);
  });
});
