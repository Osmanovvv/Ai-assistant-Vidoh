import { describe, expect, it } from 'vitest';

import { BadOnlyError, parseOnly, pickCases } from './only.js';

const cases = [{ id: 'd01-passport' }, { id: 'd03-parcel' }, { id: 'd21-new' }, { id: 'd23-date' }];

describe('--only: какие случаи гнать (план docs/26, задача 1)', () => {
  it('без флага — все случаи, аргументы не тронуты', () => {
    const parsed = parseOnly(['../../docs/eval/resolver-dialog', '--budget', '20']);
    expect(parsed.only).toBeUndefined();
    expect(parsed.rest).toEqual(['../../docs/eval/resolver-dialog', '--budget', '20']);
    expect(pickCases(cases, parsed.only)).toEqual(cases);
  });

  it('префикс берёт все случаи, чей id с него начинается', () => {
    const parsed = parseOnly(['набор', '--only', 'd0']);
    expect(parsed.rest).toEqual(['набор']);
    expect(pickCases(cases, parsed.only).map((one) => one.id)).toEqual([
      'd01-passport',
      'd03-parcel',
    ]);
  });

  it('список через запятую и форма с «=»', () => {
    const parsed = parseOnly(['--only=d01,d23', 'набор']);
    expect(parsed.rest).toEqual(['набор']);
    expect(pickCases(cases, parsed.only).map((one) => one.id)).toEqual([
      'd01-passport',
      'd23-date',
    ]);
  });

  it('флаг без значения — ошибка, а не молча весь набор (живой прогон стоит денег)', () => {
    expect(() => parseOnly(['набор', '--only'])).toThrow(BadOnlyError);
    expect(() => parseOnly(['набор', '--only='])).toThrow(BadOnlyError);
  });

  it('следующий флаг не становится значением: иначе --budget пропал бы вместе с потолком', () => {
    expect(() => parseOnly(['набор', '--only', '--budget', '20'])).toThrow(BadOnlyError);
  });

  it('фильтр, не совпавший ни с одним случаем, — ошибка: пустой прогон не должен сойти за пройденный', () => {
    expect(() => pickCases(cases, ['x9'])).toThrow(BadOnlyError);
  });
});
