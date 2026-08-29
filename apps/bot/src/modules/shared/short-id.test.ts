import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { callbackDataSize, fromShortId, toShortId } from './short-id.js';

/**
 * Короткие идентификаторы (задача 2.18).
 *
 * Проверяется главное: преобразование обратимо на любых UUID, а не на
 * подобранных, и мусор из нажатия не превращается во «почти правильный»
 * идентификатор.
 */

describe('туда и обратно', () => {
  it('любой UUID возвращается собой', () => {
    // Тысяча случайных: подобранный пример проверил бы, что код работает
    // на этом примере, а не что он работает.
    for (let index = 0; index < 1000; index++) {
      const uuid = randomUUID();
      expect(fromShortId(toShortId(uuid))).toBe(uuid);
    }
  });

  it('код короче UUID и укладывается в предел', () => {
    const code = toShortId('0198f4c2-8a1b-7c3d-9e4f-5a6b7c8d9e0f');

    expect(code).toHaveLength(22);
    expect(callbackDataSize(code)).toBe(22);
  });

  it('регистр UUID не влияет на результат', () => {
    const lower = '0198f4c2-8a1b-7c3d-9e4f-5a6b7c8d9e0f';
    expect(toShortId(lower.toUpperCase())).toBe(toShortId(lower));
  });

  it('в коде только знаки, безопасные для callback_data', () => {
    // base64url: ни плюса, ни слэша, ни знака равенства — иначе они
    // столкнулись бы с разделителями в самом идентификаторе действия.
    for (let index = 0; index < 200; index++) {
      expect(toShortId(randomUUID())).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    }
  });
});

describe('мусор из нажатия', () => {
  it.each([
    ['пусто', ''],
    ['слишком коротко', 'abc'],
    ['слишком длинно', 'a'.repeat(23)],
    ['запрещённые знаки', 'AAAAAAAAAAAAAAAAAAAA+/'],
    ['UUID как есть', '0198f4c2-8a1b-7c3d-9e4f-5a6b7c8d9e0f'],
    ['кириллица', 'ААААААААААААААААААААААА'],
  ])('не превращается в идентификатор: %s', (_name, code) => {
    // Возвращаем undefined, а не бросаем: странный код в нажатии —
    // ожидаемое событие, а не поломка.
    expect(fromShortId(code)).toBeUndefined();
  });

  it('не-UUID на входе — это уже наша ошибка, и она громкая', () => {
    // Сюда значение приходит из базы, а не снаружи. Тихо превращать его
    // в мусор нельзя: код нажатия станет неразбираемым, и искать причину
    // придётся в клавиатуре, а не здесь.
    expect(() => toShortId('не-uuid')).toThrow(/UUID/u);
    expect(() => toShortId('')).toThrow(/UUID/u);
  });
});

describe('размер в байтах, а не в знаках', () => {
  it('кириллица считается по байтам', () => {
    // Предел Telegram задан в байтах, а «Отложить» в UTF-8 — не восемь
    // байт. Проверка длины по знакам однажды пропустила бы перебор.
    expect(callbackDataSize('отмена')).toBe(12);
    expect(callbackDataSize('cancel')).toBe(6);
  });
});
