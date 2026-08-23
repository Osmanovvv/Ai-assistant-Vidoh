import { describe, expect, it } from 'vitest';

import { costMicros, formatUsd, microsToUsd, type ModelPricing } from './pricing.js';

const pricing: Readonly<Record<string, ModelPricing>> = {
  'main-model': { kind: 'tokens', inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  'light-model': { kind: 'tokens', inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  'speech-model': { kind: 'audio', perMinuteUsd: 0.006 },
};

describe('costMicros: токены', () => {
  it('считает стоимость входа и выхода', () => {
    // 1 000 000 входных по $3 плюс 1 000 000 выходных по $15 = $18.
    expect(costMicros('main-model', { tokensIn: 1_000_000, tokensOut: 1_000_000 }, pricing)).toBe(
      18_000_000,
    );
  });

  it('считает типичный вызов разбора', () => {
    // 4300 входных и 1150 выходных: $0.0129 + $0.01725 = $0.03015.
    const micros = costMicros('main-model', { tokensIn: 4_300, tokensOut: 1_150 }, pricing);

    expect(micros).toBe(30_150);
    expect(microsToUsd(micros!)).toBeCloseTo(0.03015, 6);
  });

  it('лёгкая модель дешевле основной на тех же токенах', () => {
    const usage = { tokensIn: 1_800, tokensOut: 450 };

    const light = costMicros('light-model', usage, pricing);
    const main = costMicros('main-model', usage, pricing);

    expect(light).toBeLessThan(main!);
  });

  it('считает, даже если известен только вход', () => {
    expect(costMicros('main-model', { tokensIn: 1_000_000 }, pricing)).toBe(3_000_000);
  });

  it('нулевой расход даёт нулевую стоимость, а не null', () => {
    expect(costMicros('main-model', { tokensIn: 0, tokensOut: 0 }, pricing)).toBe(0);
  });

  it('без данных о расходе стоимость неизвестна', () => {
    expect(costMicros('main-model', {}, pricing)).toBeNull();
  });
});

describe('costMicros: аудио', () => {
  it('считает по минутам', () => {
    // Две минуты по $0.006 = $0.012.
    expect(costMicros('speech-model', { audioSeconds: 120 }, pricing)).toBe(12_000);
  });

  it('считает неполную минуту пропорционально', () => {
    expect(costMicros('speech-model', { audioSeconds: 30 }, pricing)).toBe(3_000);
  });

  it('без длительности стоимость неизвестна', () => {
    expect(costMicros('speech-model', { tokensIn: 100 }, pricing)).toBeNull();
  });
});

describe('costMicros: неизвестная модель', () => {
  it('возвращает null, а не ноль', () => {
    // Молчаливый ноль превратил бы «не знаем цену» в «бесплатно»
    // и занизил бы себестоимость пользователя.
    expect(costMicros('модель-которой-нет', { tokensIn: 1_000_000 }, pricing)).toBeNull();
  });
});

describe('formatUsd', () => {
  it('показывает сумму с точностью до микродоллара', () => {
    expect(formatUsd(30_150)).toBe('$0.030150');
  });

  it('честно говорит, когда цена неизвестна', () => {
    expect(formatUsd(null)).toBe('цена неизвестна');
  });

  it('показывает ноль как ноль', () => {
    expect(formatUsd(0)).toBe('$0.000000');
  });
});
