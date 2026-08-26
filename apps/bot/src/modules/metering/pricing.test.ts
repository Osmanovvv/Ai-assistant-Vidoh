import { describe, expect, it } from 'vitest';

import {
  callCost,
  formatCost,
  microsToUnits,
  modelsWithoutPrice,
  type ModelPricing,
} from './pricing.js';

const pricing: Readonly<Record<string, ModelPricing>> = {
  'main-model': { kind: 'tokens', currency: 'usd', inputPerMillion: 3, outputPerMillion: 15 },
  'light-model': { kind: 'tokens', currency: 'usd', inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'speech-model': { kind: 'audio', currency: 'usd', perMinute: 0.006 },
  'speech-blocks': { kind: 'audio', currency: 'rub', perMinute: 0.6, billingBlockSec: 15 },
  'rub-model': { kind: 'tokens', currency: 'rub', inputPerMillion: 200, outputPerMillion: 600 },
};

describe('callCost: токены', () => {
  it('считает стоимость входа и выхода', () => {
    // 1 000 000 входных по $3 плюс 1 000 000 выходных по $15 = $18.
    expect(callCost('main-model', { tokensIn: 1_000_000, tokensOut: 1_000_000 }, pricing)).toEqual({
      micros: 18_000_000,
      currency: 'usd',
    });
  });

  it('считает типичный вызов разбора', () => {
    // 4300 входных и 1150 выходных: $0.0129 + $0.01725 = $0.03015.
    const cost = callCost('main-model', { tokensIn: 4_300, tokensOut: 1_150 }, pricing);

    expect(cost?.micros).toBe(30_150);
    expect(microsToUnits(cost?.micros ?? 0)).toBeCloseTo(0.03015, 6);
  });

  it('лёгкая модель дешевле основной на тех же токенах', () => {
    const usage = { tokensIn: 1_800, tokensOut: 450 };

    const light = callCost('light-model', usage, pricing);
    const main = callCost('main-model', usage, pricing);

    expect(light?.micros).toBeLessThan(main?.micros ?? 0);
  });

  it('считает, даже если известен только вход', () => {
    expect(callCost('main-model', { tokensIn: 1_000_000 }, pricing)?.micros).toBe(3_000_000);
  });

  it('нулевой расход даёт нулевую стоимость, а не null', () => {
    expect(callCost('main-model', { tokensIn: 0, tokensOut: 0 }, pricing)?.micros).toBe(0);
  });

  it('без данных о расходе стоимость неизвестна', () => {
    expect(callCost('main-model', {}, pricing)).toBeNull();
  });
});

describe('callCost: аудио', () => {
  it('считает по минутам', () => {
    // Две минуты по $0.006 = $0.012.
    expect(callCost('speech-model', { audioSeconds: 120 }, pricing)?.micros).toBe(12_000);
  });

  it('считает неполную минуту пропорционально', () => {
    expect(callCost('speech-model', { audioSeconds: 30 }, pricing)?.micros).toBe(3_000);
  });

  it('без длительности стоимость неизвестна', () => {
    expect(callCost('speech-model', { tokensIn: 100 }, pricing)).toBeNull();
  });
});

describe('callCost: блочная тарификация', () => {
  it('округляет вверх до оплачиваемого блока', () => {
    // Три секунды тарифицируются как пятнадцать: 0,25 минуты по 0,6 ₽.
    // Без округления вышло бы 0,03 ₽ — впятеро меньше настоящей цены.
    expect(callCost('speech-blocks', { audioSeconds: 3 }, pricing)).toEqual({
      micros: 150_000,
      currency: 'rub',
    });
  });

  it('не округляет то, что уже кратно блоку', () => {
    expect(callCost('speech-blocks', { audioSeconds: 30 }, pricing)?.micros).toBe(300_000);
  });

  it('секунда сверх блока переводит в следующий блок', () => {
    expect(callCost('speech-blocks', { audioSeconds: 16 }, pricing)?.micros).toBe(300_000);
  });
});

describe('callCost: валюта', () => {
  it('возвращает валюту прайс-листа, а не приводит к одной', () => {
    // Курс на дату вызова задним числом не восстановить, поэтому валюта
    // хранится рядом с суммой.
    expect(callCost('rub-model', { tokensIn: 1_000_000 }, pricing)).toEqual({
      micros: 200_000_000,
      currency: 'rub',
    });
  });
});

describe('callCost: неизвестная модель', () => {
  it('возвращает null, а не ноль', () => {
    // Молчаливый ноль превратил бы «не знаем цену» в «бесплатно»
    // и занизил бы себестоимость пользователя.
    expect(callCost('модель-которой-нет', { tokensIn: 1_000_000 }, pricing)).toBeNull();
  });
});

describe('formatCost', () => {
  it('показывает доллары с точностью до микродоллара', () => {
    expect(formatCost({ micros: 30_150, currency: 'usd' })).toBe('$0.030150');
  });

  it('показывает рубли со знаком рубля', () => {
    expect(formatCost({ micros: 150_000, currency: 'rub' })).toBe('0.150000 ₽');
  });

  it('честно говорит, когда цена неизвестна', () => {
    expect(formatCost(null)).toBe('цена неизвестна');
  });

  it('показывает ноль как ноль', () => {
    expect(formatCost({ micros: 0, currency: 'usd' })).toBe('$0.000000');
  });
});

describe('modelsWithoutPrice', () => {
  it('перечисляет модели, для которых цена не задана', () => {
    expect(modelsWithoutPrice(['main-model', 'yandex:general'], pricing)).toEqual([
      'yandex:general',
    ]);
  });

  it('на полном прайс-листе возвращает пусто', () => {
    expect(modelsWithoutPrice(['main-model', 'speech-model'], pricing)).toEqual([]);
  });
});

describe('прайс-лист (задача 2.21)', () => {
  /**
   * Цена, которую никто не проверяет, однажды разойдётся со счётом.
   * Здесь закреплено то, что взято из официальных правил тарификации
   * Yandex от 27.08.2026 — с НДС, как их публикует Yandex.
   */

  it('распознавание считается блоками по пятнадцать секунд', () => {
    // Главная особенность расхода на живых записях: короткое голосовое
    // стоит столько же, сколько пятнадцатисекундное.
    expect(callCost('yandex:general', { audioSeconds: 3 })).toEqual({
      micros: 162_600,
      currency: 'rub',
    });

    expect(callCost('yandex:general', { audioSeconds: 16 })).toEqual({
      micros: 325_200,
      currency: 'rub',
    });
  });

  it('серия коротких голосовых дороже одной длинной записи той же длительности', () => {
    // Восемь записей по 12 секунд — это 96 секунд звука и восемь блоков.
    // Одна запись на 96 секунд — семь блоков. Разница и есть та
    // переплата, ради которой стоит склеивать голосовые до распознавания.
    const separate = 8 * (callCost('yandex:general', { audioSeconds: 12 })?.micros ?? 0);
    const together = callCost('yandex:general', { audioSeconds: 96 })?.micros ?? 0;

    expect(separate).toBeGreaterThan(together);
  });

  it('полная и лёгкая модели считаются по своим ценам', () => {
    // Тысяча входящих и тысяча исходящих: у полной 1,6 ₽, у лёгкой 0,4 ₽.
    expect(callCost('yandex:yandexgpt/latest', { tokensIn: 1000, tokensOut: 1000 })?.micros).toBe(
      1_600_000,
    );

    expect(
      callCost('yandex:yandexgpt-lite/latest', { tokensIn: 1000, tokensOut: 1000 })?.micros,
    ).toBe(400_000);
  });

  it('эмбеддинги считаются только по входящим токенам', () => {
    // Вектор в ответе токенами не тарифицируется.
    expect(callCost('yandex:text-search', { tokensIn: 1000, tokensOut: 256 })?.micros).toBe(10_100);
  });

  it('у всех моделей, которыми мы работаем, цена есть', () => {
    // Иначе расход уйдёт в «неизвестно», а мягкий лимит ослепнет.
    expect(
      modelsWithoutPrice([
        'yandex:general',
        'yandex:yandexgpt/latest',
        'yandex:yandexgpt-lite/latest',
        'yandex:text-search',
      ]),
    ).toEqual([]);
  });
});
