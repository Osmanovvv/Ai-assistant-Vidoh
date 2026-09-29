import { describe, expect, it } from 'vitest';

import type { AiClientDeps, StructuredRequest } from '../ai/client.js';
import type { ActivePrompt } from '../ai/prompts/registry.js';
import { SPLITTER_SCHEMA_NAME, splitterSchema } from '../ai/schemas/index.js';
import {
  askPurchaseTitles,
  checkedPositions,
  purchaseList,
  purchaseTitles,
  splitPurchases,
  type AskSplitter,
} from './purchase-split.js';

/**
 * Покупки позициями (правка заказчицы 29.09.2026): «Купить овощи, мясо и
 * специи» — «разбить на позиции: овощи, мясо, специи». Где отдельные
 * покупки, решает модель — «подарок маме, папе и бабушке» одна покупка, а
 * код видит только запятые; код проверяет каждый её ответ. Не сошлось —
 * одно дело, как раньше: хуже, чем было, стать не может.
 */
describe('purchaseList — кандидат: покупка со списком', () => {
  it.each<[string, string, string]>([
    ['Купить овощи, мясо и специи', 'Купить', 'овощи, мясо и специи'],
    ['Купить хлеб и молоко', 'Купить', 'хлеб и молоко'],
    ['Заказать такси и столик в ресторане', 'Заказать', 'такси и столик в ресторане'],
    ['Докупить батарейки, лампочки.', 'Докупить', 'батарейки, лампочки'],
    ['купить подарок маме, папе и бабушке', 'купить', 'подарок маме, папе и бабушке'],
  ])('«%s»', (text, verb, list) => {
    expect(purchaseList(text)).toEqual({ verb, list });
  });

  it.each([
    'Купить хлеб',
    'Купить продукты на неделю',
    'Позвонить маме и купить хлеб',
    // Второе действие — не покупка: делит другое правило или никто.
    'Купить хлеб и забрать посылку',
    'Сходить в магазин, купить молоко',
    'Не забыть купить молоко, хлеб',
    '',
  ])('«%s» — не кандидат', (text) => {
    expect(purchaseList(text)).toBeUndefined();
  });
});

describe('checkedPositions — ответ модели проверяет код', () => {
  const LIST = 'овощи, мясо и специи';

  it('дословные куски по порядку, между ними только «,» и «и» — позиции', () => {
    expect(checkedPositions(LIST, ['овощи', 'мясо', 'специи'])).toEqual([
      'овощи',
      'мясо',
      'специи',
    ]);
    expect(checkedPositions('2 кг картошки, 3 лимона', ['2 кг картошки', '3 лимона'])).toEqual([
      '2 кг картошки',
      '3 лимона',
    ]);
  });

  it('регистр и «ё» модели не мешают — берутся слова самого дела', () => {
    expect(checkedPositions('ёлочные игрушки, гирлянду', ['Елочные игрушки', 'гирлянду'])).toEqual([
      'ёлочные игрушки',
      'гирлянду',
    ]);
  });

  it.each<[string, readonly string[]]>([
    ['одна позиция — это не деление', ['овощи, мясо и специи']],
    ['пусто — одна покупка', []],
    ['выдумала позицию', ['овощи', 'мясо', 'специи', 'хлеб']],
    ['потеряла слово', ['овощи', 'специи']],
    ['поменяла порядок', ['мясо', 'овощи', 'специи']],
    ['изменила слово', ['овощи', 'мяса', 'специи']],
    ['пустая позиция', ['овощи', '', 'мясо и специи']],
    ['позиции перекрываются', ['овощи, мясо', 'мясо и специи']],
    ['список внутри позиции', ['овощи, мясо', 'специи']],
    ['потеряла последнюю', ['овощи', 'мясо']],
  ])('%s — нет (одно дело)', (_why, positions) => {
    expect(checkedPositions(LIST, positions)).toBeUndefined();
  });

  it('позиция — одно прилагательное без предмета: «масло сливочное и подсолнечное» — нет (замер 30.09.2026)', () => {
    expect(
      checkedPositions('масло сливочное и подсолнечное', ['масло сливочное', 'подсолнечное']),
    ).toBeUndefined();
    expect(checkedPositions('зелёный и чёрный чай', ['зелёный', 'чёрный чай'])).toBeUndefined();
    expect(checkedPositions('хлеб белый и чёрный', ['хлеб белый', 'чёрный'])).toBeUndefined();
  });

  it('между позициями пробел или слово-заполнитель — не разделитель: одно дело', () => {
    expect(checkedPositions('молоко хлеб и яйца', ['молоко', 'хлеб', 'яйца'])).toBeUndefined();
    expect(checkedPositions('молоко, хлеб, ну и сыр', ['молоко', 'хлеб', 'сыр'])).toBeUndefined();
  });

  it('общее уточнение в конце — не делить: «носки и трусы сыну» (замер полной модели 30.09.2026)', () => {
    expect(checkedPositions('носки и трусы сыну', ['носки', 'трусы сыну'])).toBeUndefined();
    expect(
      checkedPositions('подарок и открытку маме', ['подарок', 'открытку маме']),
    ).toBeUndefined();
    expect(
      checkedPositions('шарики и свечи на день рождения', ['шарики', 'свечи на день рождения']),
    ).toBeUndefined();
  });

  it('у последней — своё: прилагательное или количество впереди — делить', () => {
    expect(
      checkedPositions('клей, ножницы и цветную бумагу', ['клей', 'ножницы', 'цветную бумагу']),
    ).toEqual(['клей', 'ножницы', 'цветную бумагу']);
    expect(checkedPositions('хлеб и 2 бутылки воды', ['хлеб', '2 бутылки воды'])).toEqual([
      'хлеб',
      '2 бутылки воды',
    ]);
    expect(checkedPositions('хлеб и пакет молока', ['хлеб', 'пакет молока'])).toEqual([
      'хлеб',
      'пакет молока',
    ]);
    // У первых своё уточнение — у последней тоже своё.
    expect(
      checkedPositions('кроссовки сыну и куртку дочке', ['кроссовки сыну', 'куртку дочке']),
    ).toEqual(['кроссовки сыну', 'куртку дочке']);
  });

  it('слово, которое само называет вещь, — позиция: мороженое, пирожное, сладкое', () => {
    expect(checkedPositions('мороженое и сок', ['мороженое', 'сок'])).toEqual(['мороженое', 'сок']);
    expect(checkedPositions('сыр и сладкое', ['сыр', 'сладкое'])).toEqual(['сыр', 'сладкое']);
  });

  it('между позициями — не только разделители: «подарок и открытку маме» → «подарок» и «открытку» — нет', () => {
    expect(checkedPositions('подарок и открытку маме', ['подарок', 'открытку'])).toBeUndefined();
  });
});

describe('purchaseTitles — названия позиций', () => {
  it('глагол дела и позиция, с заглавной', () => {
    expect(purchaseTitles('Купить', ['овощи', 'мясо', 'специи'])).toEqual([
      'Купить овощи',
      'Купить мясо',
      'Купить специи',
    ]);
    expect(purchaseTitles('купить', ['хлеб', 'молоко'])).toEqual(['Купить хлеб', 'Купить молоко']);
  });
});

describe('askPurchaseTitles — модель называет позиции, код проверяет', () => {
  function deps(schemaName: string): AiClientDeps {
    return {
      prompts: {
        get: () =>
          Promise.resolve<ActivePrompt>({
            stage: 'splitter',
            version: 'splitter@1',
            prompt: 'ПОКУПКИ',
            schemaName,
            jsonSchema: {},
            schema: splitterSchema,
          }),
      },
      logger: { warn: () => undefined, info: () => undefined },
    } as unknown as AiClientDeps;
  }

  function asking(reply: { positions: string[] } | Error): {
    seen: StructuredRequest[];
    ask: AskSplitter;
  } {
    const seen: StructuredRequest[] = [];
    return {
      seen,
      ask: (_deps, request) => {
        seen.push(request);
        if (reply instanceof Error) return Promise.reject(reply);
        return Promise.resolve({
          ok: true,
          value: reply,
          promptVersion: 'splitter@1',
          attempts: 1,
        });
      },
    };
  }

  it('честное деление — названия позиций; этап splitter, вход — само дело', async () => {
    const model = asking({ positions: ['овощи', 'мясо', 'специи'] });

    const titles = await askPurchaseTitles(
      deps(SPLITTER_SCHEMA_NAME),
      { text: 'Купить овощи, мясо и специи' },
      model.ask,
    );

    expect(titles).toEqual(['Купить овощи', 'Купить мясо', 'Купить специи']);
    expect(model.seen[0]?.stage).toBe('splitter');
    expect(model.seen[0]?.input).toBe('Дело: Купить овощи, мясо и специи');
  });

  it('одна покупка, подлог, сбой, промпт не той схемы — ничего: одно дело', async () => {
    const text = 'Купить подарок маме, папе и бабушке';
    expect(
      await askPurchaseTitles(deps(SPLITTER_SCHEMA_NAME), { text }, asking({ positions: [] }).ask),
    ).toBeUndefined();
    expect(
      await askPurchaseTitles(
        deps(SPLITTER_SCHEMA_NAME),
        { text },
        asking({ positions: ['подарок маме', 'папе', 'бабушке', 'торт'] }).ask,
      ),
    ).toBeUndefined();
    expect(
      await askPurchaseTitles(deps(SPLITTER_SCHEMA_NAME), { text }, asking(new Error('сеть')).ask),
    ).toBeUndefined();
    // Промпт не той схемы — модель не спрашивается, даже когда ответ был бы честным.
    const wrongSchema = asking({ positions: ['хлеб', 'молоко'] });
    expect(
      await askPurchaseTitles(deps('talker.v1'), { text: 'Купить хлеб и молоко' }, wrongSchema.ask),
    ).toBeUndefined();
    expect(wrongSchema.seen).toHaveLength(0);
  });

  it('не покупка со списком — модель не зовётся', async () => {
    const model = asking({ positions: ['хлеб', 'молоко'] });
    expect(
      await askPurchaseTitles(deps(SPLITTER_SCHEMA_NAME), { text: 'Позвонить маме' }, model.ask),
    ).toBeUndefined();
    expect(model.seen).toHaveLength(0);
  });
});

describe('splitPurchases — записи после классификации', () => {
  const task = (text: string, extra: Record<string, unknown> = {}) => ({
    text,
    type: 'TASK' as const,
    isProject: false,
    topic: 'покупки',
    ...extra,
  });
  const titles = (text: string) =>
    Promise.resolve(
      text === 'Купить овощи, мясо и специи'
        ? ['Купить овощи', 'Купить мясо', 'Купить специи']
        : undefined,
    );

  it('покупка со списком — позиции с теми же полями и пометкой, из чего вышли', async () => {
    expect(
      await splitPurchases([task('Купить овощи, мясо и специи', { deadline: 'd' })], titles),
    ).toEqual([
      task('Купить овощи', { deadline: 'd', purchaseOf: 'Купить овощи, мясо и специи' }),
      task('Купить мясо', { deadline: 'd', purchaseOf: 'Купить овощи, мясо и специи' }),
      task('Купить специи', { deadline: 'd', purchaseOf: 'Купить овощи, мясо и специи' }),
    ]);
  });

  it('проект, не-дело, вопрос «утро или вечер», модель промолчала — как были, модель не зовётся зря', async () => {
    const asked: string[] = [];
    const counting = (text: string) => {
      asked.push(text);
      return titles(text);
    };
    const kept = [
      task('Купить овощи, мясо и специи', { isProject: true }),
      task('Купить овощи, мясо и специи', { type: 'IDEA' }),
      task('Купить овощи, мясо и специи', { unclearTime: [480, 1200] }),
      task('Купить подарок маме, папе и бабушке'),
      task('Позвонить маме'),
    ];
    expect(await splitPurchases(kept, counting)).toEqual(kept);
    expect(asked).toEqual(['Купить подарок маме, папе и бабушке']);
  });
});
