import { describe, expect, it } from 'vitest';

import { validateFinalItems, type FinalGuardItem } from './final-guard.js';

const TOPICS = ['семья', 'здоровье', 'работа', 'покупки', 'дом', 'личное'];
const NOW = new Date('2026-09-27T12:00:00.000Z');
const SATURDAY = { at: new Date('2026-10-03T21:00:00.000Z'), accuracy: 'day' as const };
const TOMORROW = { at: new Date('2026-09-28T21:00:00.000Z'), accuracy: 'day' as const };

const unit = (text: string) => ({ text, isProject: false, isEmotion: false });
const item = (text: string, topic: string, deadline?: FinalGuardItem['deadline']) => ({
  text,
  topic,
  ...(deadline === undefined ? {} : { deadline }),
});

describe('финальная проверка классификации', () => {
  it('принимает раздельные задачи с независимыми сроками', () => {
    expect(
      validateFinalItems({
        units: [unit('Записать сына к врачу в субботу'), unit('Забрать тестовую посылку')],
        items: [
          item('Записать сына к врачу', 'здоровье', SATURDAY),
          item('Забрать тестовую посылку', 'покупки'),
        ],
        topics: TOPICS,
        now: NOW,
        timeZone: 'Europe/Moscow',
      }),
    ).toEqual([]);
  });

  it('отклоняет запись, в которую попали две единицы', () => {
    const issues = validateFinalItems({
      units: [unit('Записать сына к врачу в субботу'), unit('Забрать тестовую посылку')],
      items: [
        item('Записать сына к врачу в субботу, ещё забрать тестовую посылку', 'здоровье', SATURDAY),
        item('Забрать тестовую посылку', 'покупки'),
      ],
      topics: TOPICS,
      now: NOW,
      timeZone: 'Europe/Moscow',
    });

    expect(issues.some((issue) => issue.kind === 'merged')).toBe(true);
  });

  it('отклоняет срок, пришедший от соседней единицы', () => {
    const issues = validateFinalItems({
      units: [unit('Записать сына к врачу в субботу'), unit('Забрать тестовую посылку')],
      items: [
        item('Записать сына к врачу', 'здоровье', SATURDAY),
        item('Забрать тестовую посылку', 'покупки', SATURDAY),
      ],
      topics: TOPICS,
      now: NOW,
      timeZone: 'Europe/Moscow',
    });

    expect(issues.some((issue) => issue.kind === 'deadline')).toBe(true);
  });

  it('разрешает общий срок в конце общей рабочей фразы', () => {
    expect(
      validateFinalItems({
        units: [unit('Созвониться с Ириной'), unit('Проверить документы завтра')],
        items: [
          item('Созвониться с Ириной', 'работа', TOMORROW),
          item('Проверить документы', 'работа', TOMORROW),
        ],
        topics: TOPICS,
        spoken: 'Созвониться с Ириной, проверить документы завтра',
        now: NOW,
        timeZone: 'Europe/Moscow',
      }),
    ).toEqual([]);
  });

  it('отклоняет сильную рабочую запись в личной сфере', () => {
    const issues = validateFinalItems({
      units: [unit('Проверить документы завтра')],
      items: [item('Проверить документы', 'личное')],
      topics: TOPICS,
      now: NOW,
      timeZone: 'Europe/Moscow',
    });

    expect(issues.some((issue) => issue.kind === 'topic')).toBe(true);
  });
});
