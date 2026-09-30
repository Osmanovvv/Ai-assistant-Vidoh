import { describe, expect, it } from 'vitest';

import type { ClassifiedItems } from '../ai/schemas/classifier.js';
import { attachListTails } from './list-tail.js';

type RawItem = ClassifiedItems['items'][number];

const raw = (
  text: string,
  options: {
    readonly type?: RawItem['type'];
    readonly topic?: string;
    readonly isProject?: boolean;
    readonly deadlineText?: string;
  } = {},
): RawItem => {
  const type = options.type ?? 'TASK';
  const dated = options.deadlineText !== undefined;
  return {
    text,
    type,
    priority: type === 'TASK' ? 'SOON' : 'NONE',
    topic: options.topic ?? 'семья',
    isProject: options.isProject ?? false,
    deadline: dated ? '2026-10-01' : '',
    deadlineAccuracy: dated ? 'day' : 'none',
    deadlineText: options.deadlineText ?? '',
    recurrenceKind: 'none',
    recurrenceInterval: 0,
    recurrenceText: '',
  };
};

const goal = (text: string): RawItem => raw(text, { isProject: true });
const texts = (items: readonly RawItem[]): readonly string[] => items.map((item) => item.text);

/**
 * Её голосовое 30.09.2026 знак в знак, как его распознал SpeechKit: «Так
 * мне надо разобраться с днем рождения ребенка, место гости торт.
 * Украшения ведущей?» Точку и вопрос поставило распознавание, и хвост
 * перечисления стал отдельной идеей.
 */
describe('хвост перечисления — к большой цели', () => {
  it('её случай: «Украшения ведущей» — часть цели, а не отдельная идея', () => {
    const result = attachListTails(
      [
        goal('Разобраться с днём рождения ребёнка, место, гости, торт'),
        raw('Украшения ведущей', { type: 'IDEA' }),
      ],
      ['разобраться с днем рождения ребенка, место гости торт', 'Украшения ведущей?'],
    );

    expect(texts(result.items)).toEqual([
      'Разобраться с днём рождения ребёнка, место, гости, торт, украшения ведущей',
    ]);
    expect(result.items[0]?.isProject).toBe(true);
    expect(result.said).toEqual([
      'разобраться с днем рождения ребенка, место гости торт Украшения ведущей?',
    ]);
    expect(result.attached).toBe(1);
  });

  it('цель без частей, а следом само перечисление — тоже её части', () => {
    const result = attachListTails(
      [goal('Разобраться с днём рождения ребёнка'), raw('Место, гости, торт', { type: 'INFO' })],
      undefined,
    );

    expect(texts(result.items)).toEqual([
      'Разобраться с днём рождения ребёнка, место, гости, торт',
    ]);
  });

  it('два хвоста подряд — оба к цели', () => {
    const result = attachListTails(
      [
        goal('Разобраться с днём рождения ребёнка, место, гости'),
        raw('Торт', { type: 'IDEA' }),
        raw('Украшения', { type: 'IDEA' }),
      ],
      undefined,
    );

    expect(texts(result.items)).toEqual([
      'Разобраться с днём рождения ребёнка, место, гости, торт, украшения',
    ]);
    expect(result.attached).toBe(2);
  });

  it.each([
    [
      'одно слово после цели без перечисления',
      goal('Разобраться с днём рождения ребёнка'),
      raw('Торт', { type: 'IDEA' }),
    ],
    [
      'дело с глаголом',
      goal('Разобраться с днём рождения ребёнка, место, гости'),
      raw('Купить хлеб'),
    ],
    [
      'со сроком',
      goal('Разобраться с днём рождения ребёнка, место, гости'),
      raw('Врач', { type: 'INFO', deadlineText: 'завтра' }),
    ],
    [
      'чувство',
      goal('Разобраться с днём рождения ребёнка, место, гости'),
      raw('Устала', { type: 'EMOTION' }),
    ],
    [
      'другая сфера',
      goal('Спланировать отпуск, билеты, отель'),
      raw('Хлеб, молоко', { type: 'INFO', topic: 'покупки' }),
    ],
    [
      'перед ним не большая цель',
      raw('Позвонить маме, папе, бабушке'),
      raw('Торт, шарики', { type: 'IDEA' }),
    ],
    [
      'слова предложения, а не перечисления',
      goal('Разобраться с днём рождения ребёнка, место, гости'),
      raw('Мне страшно', { type: 'INFO' }),
    ],
    [
      'длинный хвост',
      goal('Разобраться с днём рождения ребёнка, место, гости'),
      raw('Торт шарики свечи колпаки конфеты сок вода', { type: 'IDEA' }),
    ],
    [
      'с числом',
      goal('Разобраться с днём рождения ребёнка, место, гости'),
      raw('Гостей 15 человек', { type: 'INFO' }),
    ],
    [
      'сам большая цель',
      goal('Разобраться с днём рождения ребёнка, место, гости'),
      goal('Ремонт на даче'),
    ],
    [
      'с повтором',
      goal('Разобраться с днём рождения ребёнка, место, гости'),
      { ...raw('Бассейн', { type: 'INFO' }), recurrenceKind: 'weekly' as const },
    ],
    [
      'часть длиннее трёх слов',
      goal('Разобраться с днём рождения ребёнка, место, гости'),
      raw('Большой шоколадный торт с кремом', { type: 'IDEA' }),
    ],
    [
      'частей больше шести слов',
      goal('Разобраться с днём рождения ребёнка'),
      raw('Торт, шарики, свечи, колпаки, конфеты, сок, вода', { type: 'IDEA' }),
    ],
    [
      'цель — не дело и не желание',
      { ...goal('Идея праздника, место, гости'), type: 'IDEA' as const },
      raw('Торт', { type: 'IDEA' }),
    ],
  ])('не приклеивается: %s', (_, first, second) => {
    const result = attachListTails([first, second], ['первое', 'второе']);

    expect(result.items).toEqual([first, second]);
    expect(result.said).toEqual(['первое', 'второе']);
    expect(result.attached).toBe(0);
  });

  it('слова человека разошлись с ответом по числу — склейка есть, слов нет', () => {
    const result = attachListTails(
      [goal('Разобраться с днём рождения ребёнка, место, гости'), raw('Торт', { type: 'IDEA' })],
      ['одно'],
    );

    expect(result.attached).toBe(1);
    expect(result.said).toBeUndefined();
  });
});
