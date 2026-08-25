import { describe, expect, it } from 'vitest';

import { collapseRepeats, type ExtractedUnit } from './extractor.service.js';

/**
 * §6.1 ТЗ требует схлопывать повторы, и это заложено в промпт. Но
 * полагаться только на промпт нельзя: человек в живой речи повторяет
 * одно и то же по три раза, и модель иногда возвращает две одинаковые
 * единицы. Две записи об одном деле человек воспримет как ошибку бота.
 */

const unit = (text: string, extra: Partial<ExtractedUnit> = {}): ExtractedUnit => ({
  text,
  isProject: false,
  isEmotion: false,
  ...extra,
});

describe('collapseRepeats', () => {
  it('оставляет разные единицы как есть', () => {
    const result = collapseRepeats([unit('купить кофе'), unit('записаться к врачу')]);

    expect(result.units).toHaveLength(2);
    expect(result.collapsed).toBe(0);
  });

  it('схлопывает дословные повторы', () => {
    const result = collapseRepeats([unit('купить кофе'), unit('купить кофе')]);

    expect(result.units).toHaveLength(1);
    expect(result.collapsed).toBe(1);
  });

  it('не различает по регистру и пунктуации', () => {
    // «Купить кофе» и «купить кофе.» — одно и то же дело.
    const result = collapseRepeats([unit('Купить кофе.'), unit('купить кофе')]);

    expect(result.units).toHaveLength(1);
  });

  it('оставляет первую единицу, а не последнюю', () => {
    // У первой больше шансов быть ближе к тому, что человек сказал.
    const result = collapseRepeats([
      unit('конспектировать марафон', { isProject: true }),
      unit('конспектировать марафон'),
    ]);

    expect(result.units[0]?.isProject).toBe(true);
  });

  it('выбрасывает единицы из одной пунктуации', () => {
    // Такое приходит, когда модель принимает «так так так» за дело.
    const result = collapseRepeats([unit('...'), unit('купить кофе')]);

    expect(result.units.map((item) => item.text)).toEqual(['купить кофе']);
    expect(result.collapsed).toBe(1);
  });

  it('схлопывает три повтора в один', () => {
    // Ровно как в живой записи: «успеть все законспектировать марафон,
    // успеть все».
    const result = collapseRepeats([unit('успеть всё'), unit('успеть все'), unit('Успеть всё!')]);

    expect(result.units).toHaveLength(1);
    expect(result.collapsed).toBe(2);
  });

  it('не путает похожие, но разные дела', () => {
    const result = collapseRepeats([unit('купить кофе'), unit('купить кофе в зёрнах')]);

    expect(result.units).toHaveLength(2);
  });

  it('пустой список не ломает', () => {
    expect(collapseRepeats([])).toEqual({ units: [], collapsed: 0 });
  });
});
