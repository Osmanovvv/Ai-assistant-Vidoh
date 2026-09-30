import { describe, expect, it } from 'vitest';

import { missingUnits } from './missing-units.js';

const unit = (text: string) => ({ text, isProject: false, isEmotion: false });

/**
 * Классификация вернула записей меньше, чем пришло единиц: какие единицы
 * не покрыты ни одной записью (заказчица 30.09.2026 — сказанное не должно
 * пропадать молча).
 */
describe('единицы, которых нет в ответе классификации', () => {
  it('одна выпала — она и находится', () => {
    const units = [
      unit('выкупать собаку'),
      unit('заказать шампунь'),
      unit('сходить на Вайлдберриз'),
    ];

    expect(missingUnits(units, ['Выкупать собаку', 'Заказать шампунь'])).toEqual([units[2]]);
  });

  it('модель слила две единицы в одну запись — не пропажа', () => {
    const units = [unit('купить молоко'), unit('молоко обязательно два литра')];

    expect(missingUnits(units, ['Купить молоко, два литра'])).toEqual([]);
  });

  it('записей столько же или больше — сверять нечего', () => {
    const units = [unit('купить молоко')];

    // Слов единицы в записях нет — и всё равно не пропажа: записей не меньше.
    expect(missingUnits(units, ['Позвонить маме'])).toEqual([]);
    expect(missingUnits(units, ['Позвонить маме', 'Забрать посылку'])).toEqual([]);
  });

  it('у единицы нет слов, по которым её узнать, — не угадываем', () => {
    const units = [unit('да'), unit('купить молоко')];

    expect(missingUnits(units, ['Купить молоко'])).toEqual([]);
  });
});
