import { describe, expect, it } from 'vitest';

import { saysThanks } from './thanks.js';

/**
 * «Спасибо» узнаётся по закрытому списку слов, целыми словами (заказчица,
 * 16.09.2026: «женщина поблагодарила бота» — одна из немногих ситуаций для
 * фирменного 🤍). Это правило, а не догадка: слово либо есть, либо нет.
 */
describe('saysThanks', () => {
  it('узнаёт благодарность целым словом, в любом регистре и с знаками', () => {
    expect(saysThanks('спасибо')).toBe(true);
    expect(saysThanks('Спасибо большое!')).toBe(true);
    expect(saysThanks('благодарю тебя')).toBe(true);
    expect(saysThanks('ой, спасибо, ты очень помогла')).toBe(true);
  });

  it('не узнаёт по обрывку и в чужих словах', () => {
    expect(saysThanks('привет')).toBe(false);
    expect(saysThanks('спасибочки')).toBe(false);
    expect(saysThanks('надо купить хлеб')).toBe(false);
    expect(saysThanks('')).toBe(false);
  });
});
