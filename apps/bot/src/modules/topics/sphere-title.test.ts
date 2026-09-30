import { describe, expect, it } from 'vitest';

import { defaultTexts } from '../../texts/index.js';
import { sphereTitle } from './sphere-title.js';
import { buildSummary } from './summary.service.js';

/**
 * Сфера для человека — с заглавной (правка заказчицы 30.09.2026: «Мне
 * нравится, что это с большой буквы… Давайте везде так поменяем»).
 */
describe('sphereTitle', () => {
  it.each([
    ['личное', 'Личное'],
    ['дом', 'Дом'],
    ['покупки', 'Покупки'],
    ['учёба', 'Учёба'],
  ])('«%s» → «%s»', (name, title) => {
    expect(sphereTitle(name)).toBe(title);
  });

  it('заглавные внутри имени человека не трогает: «ВБ заказы», «Личное»', () => {
    expect(sphereTitle('ВБ заказы')).toBe('ВБ заказы');
    expect(sphereTitle('Личное')).toBe('Личное');
  });
});

describe('сводка ветки — заголовок с заглавной', () => {
  it('«личное» → первая строка «Личное»', () => {
    const text = buildSummary({
      topicName: 'личное',
      items: [],
      texts: defaultTexts,
      timeZone: 'Europe/Moscow',
    });

    expect(text.split('\n')[0]).toBe('Личное');
  });
});
