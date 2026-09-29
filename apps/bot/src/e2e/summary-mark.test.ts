import { describe, expect, it } from 'vitest';

import { buildSummary } from '../modules/topics/summary.service.js';
import { defaultTexts } from '../texts/index.js';
import { isTopicSummary } from './summary-mark.js';

/**
 * Сводку ветки стенды отличают от ответа человеку: её правят по номеру
 * сообщения, и признака ветки у правки нет. С 29.09.2026 заголовок —
 * просто название темы (правка заказчицы), признак — названия веток.
 */
describe('isTopicSummary', () => {
  const summary = (topicName: string, items: readonly string[]): string =>
    buildSummary({
      topicName,
      items: items.map((text) => ({ text, deadlineAt: null }) as never),
      texts: defaultTexts,
      timeZone: 'Europe/Moscow',
    });

  it('сводка своей ветки — да, и пустая тоже', () => {
    expect(isTopicSummary(summary('семья', ['Написать мужу список продуктов']), ['семья'])).toBe(
      true,
    );
    expect(isTopicSummary(summary('дом', []), ['семья', 'дом'])).toBe(true);
  });

  it('ответ человеку — нет, даже если начинается с названия ветки', () => {
    const names = ['семья', 'дом'];
    expect(isTopicSummary('Всё, забрала. Записала 2 дела и разложила по местам.', names)).toBe(
      false,
    );
    expect(isTopicSummary('семья и дом — это главное', names)).toBe(false);
    expect(isTopicSummary('Записала в «семья»: Купить хлеб.', names)).toBe(false);
  });

  it('ветки не названы — не сводка', () => {
    expect(isTopicSummary(summary('семья', ['Купить хлеб']), [])).toBe(false);
  });
});
