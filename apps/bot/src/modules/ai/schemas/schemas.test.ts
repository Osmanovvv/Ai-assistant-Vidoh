import { describe, expect, it } from 'vitest';

import {
  EXTRACTOR_SCHEMA_NAME,
  INTENTS,
  ROUTER_SCHEMA_NAME,
  SCHEMAS,
  SCHEMA_BY_STAGE,
  UnknownSchemaError,
  canonicalJson,
  extractorSchema,
  findSchema,
  routerSchema,
  toJsonSchema,
} from './index.js';

/**
 * Инвариант 5: ответ модели, не соответствующий схеме, отвергается до
 * попадания в бизнес-логику. Здесь проверяется, что схема действительно
 * отвергает — по каждому полю отдельно, а не «в целом работает».
 */

const valid = {
  units: [
    { text: 'записаться к врачу', isProject: false, isEmotion: false },
    { text: 'день рождения сына', isProject: true, isEmotion: false },
    { text: 'я вообще ничего не успеваю', isProject: false, isEmotion: true },
  ],
};

describe('схема извлечения', () => {
  it('пропускает корректный ответ', () => {
    expect(extractorSchema.safeParse(valid).success).toBe(true);
  });

  it('пустой список единиц допустим: человек мог не сказать ни одного дела', () => {
    expect(extractorSchema.safeParse({ units: [] }).success).toBe(true);
  });

  const broken: readonly [string, unknown][] = [
    ['нет поля units', {}],
    ['units не массив', { units: 'записаться к врачу' }],
    ['единица без текста', { units: [{ isProject: false, isEmotion: false }] }],
    ['пустой текст', { units: [{ text: '', isProject: false, isEmotion: false }] }],
    ['текст не строка', { units: [{ text: 42, isProject: false, isEmotion: false }] }],
    ['нет признака проекта', { units: [{ text: 'дело', isEmotion: false }] }],
    ['признак проекта строкой', { units: [{ text: 'дело', isProject: 'да', isEmotion: false }] }],
    ['нет признака эмоции', { units: [{ text: 'дело', isProject: false }] }],
  ];

  for (const [what, payload] of broken) {
    it(`отвергает: ${what}`, () => {
      expect(extractorSchema.safeParse(payload).success).toBe(false);
    });
  }

  it('отвергает неправдоподобно длинный список', () => {
    // Шестьдесят дел за одну выгрузку не бывает: это модель сорвалась
    // в перечисление, и такое лучше не пускать в базу.
    const units = Array.from({ length: 61 }, () => ({
      text: 'дело',
      isProject: false,
      isEmotion: false,
    }));

    expect(extractorSchema.safeParse({ units }).success).toBe(false);
  });

  it('отвергает неправдоподобно длинный текст единицы', () => {
    const units = [{ text: 'а'.repeat(501), isProject: false, isEmotion: false }];

    expect(extractorSchema.safeParse({ units }).success).toBe(false);
  });
});

describe('каталог схем', () => {
  it('находит схему по имени', () => {
    expect(findSchema(EXTRACTOR_SCHEMA_NAME)).toBe(extractorSchema);
  });

  it('на незнакомое имя падает внятно и перечисляет известные', () => {
    // Незнакомое имя означает выкладку, которая не знает про свою же
    // версию промпта.
    expect(() => findSchema('нет-такой')).toThrow(UnknownSchemaError);
    expect(() => findSchema('нет-такой')).toThrow(/extractor\.v1/u);
  });

  it('имена схем содержат версию', () => {
    // Промпт можно откатить, и без версии в имени схему с ним не сверить.
    for (const name of Object.keys(SCHEMAS)) {
      expect(name).toMatch(/\.v\d+$/u);
    }
  });
});

describe('JSON Schema для модели', () => {
  it('порождается из того же Zod-описания', () => {
    const json = toJsonSchema(extractorSchema);

    expect(json).toMatchObject({ type: 'object' });
    expect(Object.keys(json['properties'] as object)).toEqual(['units']);
  });

  it('не содержит служебного поля $schema', () => {
    // Лишний ключ в корне — лишний повод получить отказ модели.
    expect(toJsonSchema(extractorSchema)).not.toHaveProperty('$schema');
  });
});

describe('canonicalJson', () => {
  it('не зависит от порядка ключей', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('различает разное по смыслу', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ b: 1 }));
  });

  it('сохраняет порядок в массивах: там он значим', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('справляется с вложенностью и пустотой', () => {
    expect(canonicalJson({ x: { y: [1, { z: null }] } })).toBe(
      canonicalJson({ x: { y: [1, { z: null }] } }),
    );
    expect(canonicalJson(null)).toBe('null');
  });
});

describe('схема маршрутизатора', () => {
  const valid = {
    crisis: false,
    segments: [
      { intent: 'COMPLETE', text: 'Продукты купила' },
      { intent: 'DUMP', text: 'надо к врачу' },
      { intent: 'QUERY', text: 'что у меня на завтра' },
    ],
  };

  it('пропускает корректный ответ', () => {
    expect(routerSchema.safeParse(valid).success).toBe(true);
  });

  it('знает семь намерений, включая ANSWER', () => {
    // ANSWER в ТЗ нет: он нужен, чтобы ответ на уточняющий вопрос не
    // уходил в DUMP и не создавал задачу вроде «в четверг».
    expect(INTENTS).toHaveLength(7);
    expect(INTENTS).toContain('ANSWER');
  });

  it('каждое намерение из списка проходит', () => {
    for (const intent of INTENTS) {
      expect(
        routerSchema.safeParse({ crisis: false, segments: [{ intent, text: 'текст' }] }).success,
      ).toBe(true);
    }
  });

  const broken: readonly [string, unknown][] = [
    ['нет поля segments', { crisis: false }],
    ['segments не массив', { crisis: false, segments: 'DUMP' }],
    ['выдуманное намерение', { crisis: false, segments: [{ intent: 'РАЗБОР', text: 'текст' }] }],
    [
      'намерение в нижнем регистре',
      { crisis: false, segments: [{ intent: 'dump', text: 'текст' }] },
    ],
    ['нет текста', { crisis: false, segments: [{ intent: 'DUMP' }] }],
    ['пустой текст', { crisis: false, segments: [{ intent: 'DUMP', text: '' }] }],
    // Признак кризиса обязателен: без него ответ модели не проходит, и
    // второй контур §13.7 не может тихо исчезнуть из-за правки промпта.
    ['нет признака кризиса', { segments: [{ intent: 'DUMP', text: 'текст' }] }],
  ];

  for (const [what, payload] of broken) {
    it(`отвергает: ${what}`, () => {
      expect(routerSchema.safeParse(payload).success).toBe(false);
    });
  }

  it('пустой список сегментов допустим: разбирать может быть нечего', () => {
    expect(routerSchema.safeParse({ crisis: false, segments: [] }).success).toBe(true);
  });

  it('отвергает неправдоподобное дробление', () => {
    // Двадцать намерений в одной выгрузке означают, что модель сорвалась,
    // а не что человек столько наговорил.
    const segments = Array.from({ length: 21 }, () => ({ intent: 'DUMP', text: 'дело' }));

    expect(routerSchema.safeParse({ segments }).success).toBe(false);
  });
});

describe('справочник схем по этапам', () => {
  it('покрывает этапы, для которых есть промпты', () => {
    expect(SCHEMA_BY_STAGE.router).toBe(ROUTER_SCHEMA_NAME);
    expect(SCHEMA_BY_STAGE.extractor).toBe(EXTRACTOR_SCHEMA_NAME);
  });

  it('ссылается только на схемы, которые есть в каталоге', () => {
    // Иначе заливка промпта пройдёт, а загрузка упадёт уже в бою.
    const names = Object.values(SCHEMA_BY_STAGE);

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(SCHEMAS[name]).toBeDefined();
    }
  });
});
