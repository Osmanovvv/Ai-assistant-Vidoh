import { describe, expect, it } from 'vitest';

import { orderByText, type Segment } from './router.service.js';

/**
 * Порядок сегментов не доверяется модели: он проверяется по исходному
 * тексту. Без этого фраза «записать к врачу в четверг… хотя нет, в
 * пятницу» может создать две записи вместо одной исправленной — правка
 * применится раньше того, что она правит.
 */

const seg = (intent: Segment['intent'], text: string): Segment => ({ intent, text });

describe('orderByText', () => {
  it('оставляет верный порядок как есть', () => {
    const input = 'Продукты купила, а ещё надо к врачу записаться, и что у меня на завтра?';
    const segments = [
      seg('COMPLETE', 'Продукты купила'),
      seg('DUMP', 'а ещё надо к врачу записаться'),
      seg('QUERY', 'и что у меня на завтра?'),
    ];

    const result = orderByText(input, segments);

    expect(result.reordered).toBe(false);
    expect(result.segments.map((item) => item.intent)).toEqual(['COMPLETE', 'DUMP', 'QUERY']);
  });

  it('исправляет порядок, если модель перепутала', () => {
    // Правка не может применяться раньше того, что она правит.
    const input = 'Записать сына к врачу в четверг, хотя нет, в пятницу.';
    const segments = [
      seg('PATCH', 'хотя нет, в пятницу'),
      seg('DUMP', 'Записать сына к врачу в четверг'),
    ];

    const result = orderByText(input, segments);

    expect(result.reordered).toBe(true);
    expect(result.segments.map((item) => item.intent)).toEqual(['DUMP', 'PATCH']);
  });

  it('не зависит от регистра и пунктуации', () => {
    const input = 'Продукты купила. А ещё — надо к врачу!';
    const segments = [seg('DUMP', 'надо к врачу'), seg('COMPLETE', 'ПРОДУКТЫ КУПИЛА')];

    const result = orderByText(input, segments);

    expect(result.segments.map((item) => item.intent)).toEqual(['COMPLETE', 'DUMP']);
  });

  it('оставляет порядок модели, если хотя бы один сегмент пересказан', () => {
    // Половинчатая перестановка хуже любой из двух: она перемешала бы
    // проверенное с непроверенным.
    const input = 'Продукты купила, надо к врачу.';
    const segments = [
      seg('DUMP', 'надо к врачу'),
      seg('COMPLETE', 'человек сходил в магазин за продуктами'),
    ];

    const result = orderByText(input, segments);

    expect(result.reordered).toBe(false);
    expect(result.segments.map((item) => item.intent)).toEqual(['DUMP', 'COMPLETE']);
  });

  it('один сегмент переставлять не нужно', () => {
    const result = orderByText('просто мысль', [seg('DUMP', 'просто мысль')]);

    expect(result.reordered).toBe(false);
    expect(result.segments).toHaveLength(1);
  });

  it('пустой список не ломает', () => {
    expect(orderByText('текст', []).segments).toEqual([]);
  });

  it('при одинаковом положении сохраняет порядок модели', () => {
    // Два сегмента с одинаковым началом: устойчивая сортировка не должна
    // менять их местами произвольно.
    const input = 'купить кофе купить кофе';
    const segments = [seg('DUMP', 'купить кофе'), seg('COMPLETE', 'купить кофе')];

    const result = orderByText(input, segments);

    expect(result.segments.map((item) => item.intent)).toEqual(['DUMP', 'COMPLETE']);
    expect(result.reordered).toBe(false);
  });

  it('расставляет три сегмента, перемешанных полностью', () => {
    const input = 'Первое дело, потом второе дело, и наконец третье дело.';
    const segments = [
      seg('QUERY', 'и наконец третье дело'),
      seg('COMPLETE', 'потом второе дело'),
      seg('DUMP', 'Первое дело'),
    ];

    const result = orderByText(input, segments);

    expect(result.reordered).toBe(true);
    expect(result.segments.map((item) => item.text)).toEqual([
      'Первое дело',
      'потом второе дело',
      'и наконец третье дело',
    ]);
  });
});
