import { describe, expect, it } from 'vitest';

import type { Item } from '../../db/schema.js';
import { similarOpen } from './similar-open.js';

let seq = 0;
const open = (text: string, extra: Partial<Item> = {}): Item =>
  ({
    id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    text,
    type: 'TASK',
    status: 'new',
    isDraft: false,
    topic: 'дом',
    createdAt: new Date(Date.UTC(2026, 8, 30, 8, seq)),
    ...extra,
  }) as Item;
const task = (text: string, type: Item['type'] = 'TASK') => ({ text, type });

/**
 * Похожее открытое дело (заказчица, 30.09.2026): «Отнести пальто в
 * химчистку» было, потом «Нужна химчистка» и «Сдать пальто в химчистку»
 * легли ещё двумя делами. Похожее — общее предметное слово; имена, родня,
 * время суток и глаголы не в счёт.
 */
describe('похожее открытое дело', () => {
  const coat = open('Отнести пальто в химчистку');

  it('её случай: «Нужна химчистка» и «Сдать пальто в химчистку» — про «Отнести пальто в химчистку»', () => {
    expect(similarOpen(task('Нужна химчистка'), [coat])).toBe(coat);
    expect(similarOpen(task('Сдать пальто в химчистку'), [coat])).toBe(coat);
  });

  it.each([
    ['родня — не предмет', 'Позвонить маме', 'Купить маме подарок'],
    ['глагол — не предмет', 'Купить хлеб', 'Купить молоко'],
    ['имя — не предмет', 'Купить подарок Маше', 'Отвезти Машу на день рождения'],
    ['время суток — не предмет', 'Забрать туфли вечером', 'Забрать платье вечером'],
    ['день — не предмет', 'Купить хлеб в пятницу', 'Позвонить в банк в пятницу'],
  ])('не похоже: %s', (_, fresh, existing) => {
    expect(similarOpen(task(fresh), [open(existing)])).toBeUndefined();
  });

  it('из двух похожих — то, где общего больше', () => {
    const cleaning = open('Отнести куртку в химчистку');
    expect(similarOpen(task('Сдать пальто в химчистку'), [cleaning, coat])).toBe(coat);
  });

  it('закрытое, черновик, сведение и чувство — не в счёт', () => {
    expect(
      similarOpen(task('Нужна химчистка'), [
        open('Отнести пальто в химчистку', { status: 'done' }),
      ]),
    ).toBeUndefined();
    expect(
      similarOpen(task('Нужна химчистка'), [open('Отнести пальто в химчистку', { isDraft: true })]),
    ).toBeUndefined();
    expect(
      similarOpen(task('Нужна химчистка'), [
        open('Химчистка работает до восьми', { type: 'INFO' }),
      ]),
    ).toBeUndefined();
    expect(
      similarOpen(task('Нужна химчистка'), [open('Устала от химчистки', { type: 'EMOTION' })]),
    ).toBeUndefined();
  });

  it('новое — сведение или чувство — не спрашиваем', () => {
    expect(similarOpen(task('Химчистка работает до восьми', 'INFO'), [coat])).toBeUndefined();
    expect(similarOpen(task('Устала от химчистки', 'EMOTION'), [coat])).toBeUndefined();
  });
});
