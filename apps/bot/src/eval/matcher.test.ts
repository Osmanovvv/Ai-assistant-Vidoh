import { describe, expect, it } from 'vitest';

import type { ClassifiedItem } from '../modules/classifier/classifier.service.js';
import type { ExpectedUnit } from './dataset.js';
import { match } from './matcher.js';

/**
 * Двоякое дробление в наборе (задача 3.53).
 *
 * В речи есть места, где одна мысль законно становится и одной записью, и
 * двумя. Набор наказывал такие места дважды: склеил — потеря, разделил —
 * лишняя запись. Ни то ни другое дефектом не было, а числа портились, и
 * на них принимались решения о промптах.
 */

function unit(keywords: readonly string[], overrides: Partial<ExpectedUnit> = {}): ExpectedUnit {
  return {
    keywords: [...keywords],
    type: 'TASK',
    priority: '*',
    topic: '*',
    recurrence: 'none',
    deadline: 'none',
    optional: false,
    why: '',
    ...overrides,
  };
}

function item(text: string): ClassifiedItem {
  return { text, type: 'TASK', priority: 'SOON', topic: 'личное', isProject: false };
}

describe('необязательное ожидание', () => {
  it('непокрытое необязательное не идёт в потери', () => {
    const result = match(
      [unit(['номер'], { optional: true }), unit(['поездк'])],
      [item('Запланировать поездку на 5–7 сентября')],
    );

    expect(result.missed).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.matched).toHaveLength(1);
  });

  it('обязательное разбирается первым, даже если стоит в списке позже', () => {
    /**
     * Иначе метка не работает: необязательное «номер» забрало бы
     * единственную запись себе, и обязательное «поездк» ушло бы в потери
     * вместе со своей проверкой срока.
     */
    const merged = item('Взять номер телефона домика и запланировать поездку');

    const result = match([unit(['номер'], { optional: true }), unit(['поездк'])], [merged]);

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]?.expected.keywords).toEqual(['поездк']);
    expect(result.missed).toEqual([]);
  });

  it('разделил на две — покрыты оба, лишних нет', () => {
    const result = match(
      [unit(['стеллаж'], { optional: true }), unit(['пуфик'], { optional: true })],
      [item('Купить стеллаж на балкон'), item('Купить пуфики на балкон')],
    );

    expect(result.matched).toHaveLength(2);
    expect(result.missed).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it('склеил в одну — одно ожидание покрыто, второе молчит', () => {
    const result = match(
      [unit(['стеллаж'], { optional: true }), unit(['пуфик'], { optional: true })],
      [item('Может быть, купить стеллаж и пуфики на балкон')],
    );

    expect(result.matched).toHaveLength(1);
    expect(result.missed).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it('обязательное непокрытое по-прежнему потеря', () => {
    // Метка не должна стать способом прятать дефекты.
    const result = match([unit(['ноутбук'])], [item('Купить хлеб')]);

    expect(result.missed).toHaveLength(1);
    expect(result.extra).toHaveLength(1);
  });

  it('запись без ожидания по-прежнему лишняя', () => {
    const result = match([unit(['хлеб'])], [item('Купить хлеб'), item('Записала пари матч')]);

    expect(result.matched).toHaveLength(1);
    expect(result.extra).toHaveLength(1);
    expect(result.extra[0]?.text).toContain('пари матч');
  });
});
