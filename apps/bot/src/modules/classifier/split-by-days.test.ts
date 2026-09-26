import { describe, expect, it } from 'vitest';

import type { ClassifiedItems } from '../ai/schemas/classifier.js';
import { rejoinSplitByDays } from './split-by-days.js';

type RawItem = ClassifiedItems['items'][number];

const raw = (
  text: string,
  day?: { readonly deadline: string; readonly deadlineText: string },
  type: RawItem['type'] = 'TASK',
): RawItem => ({
  text,
  type,
  priority: type === 'TASK' ? 'SOON' : 'NONE',
  topic: 'личное',
  isProject: false,
  deadline: day?.deadline ?? '',
  deadlineAccuracy: day === undefined ? 'none' : 'day',
  deadlineText: day?.deadlineText ?? '',
  recurrenceKind: 'none',
  recurrenceInterval: 0,
  recurrenceText: '',
});

const texts = (items: readonly RawItem[]): readonly string[] => items.map((item) => item.text);
const byText = (items: readonly RawItem[], text: string): RawItem | undefined =>
  items.find((item) => item.text === text);

/**
 * Живой прогон 27.09.2026, шаг 3: расшифровка знак в знак и ответ
 * классификатора из записи стенда (`docs/eval-live-27-09`). Точки
 * распознавания стоят не там, где паузы, — и из одного «отчёт по продажам
 * сдать» модель сделала три дела, по одному на каждое слово дня.
 */
const SPEECH =
  'Так короче, пока не забыла сегодня в 2 часа дня отвезти маме лекарство. Завтра в 12 Машу отвести на день рождения к подружке. Надо еще подарки ей купить, в понедельник записать Мишу к Ортодонту оплатить кружок. По рисованию до среды на работе, кстати, отчет по продажам сдать во вторник до обеда в субботу. У свекрови день рождения купить ей подарок. И вообще хочу наконец бегать, начать по утрам голова кругом, если честно.';

const RECORDED: readonly RawItem[] = [
  raw('Сегодня в 2 часа дня отвезти маме лекарство', {
    deadline: '2026-09-27',
    deadlineText: 'сегодня',
  }),
  raw('Завтра в 12 отвести Машу на день рождения к подружке', {
    deadline: '2026-09-28',
    deadlineText: 'завтра',
  }),
  raw('Купить подарки Маше'),
  raw('В понедельник записать Мишу к ортодонту', {
    deadline: '2026-10-05',
    deadlineText: 'в понедельник',
  }),
  raw('Оплатить кружок'),
  raw('Сдать отчёт по рисованию на работе до среды', {
    deadline: '2026-09-30',
    deadlineText: 'до среды',
  }),
  raw('Сдать отчёт по продажам во вторник до обеда', {
    deadline: '2026-09-29',
    deadlineText: 'во вторник',
  }),
  raw('В субботу сдать отчёт по продажам', { deadline: '2026-10-03', deadlineText: 'в субботу' }),
  raw('Купить подарок свекрови на день рождения'),
  raw('Голова кругом, если честно', undefined, 'EMOTION'),
  raw('Хочу начать бегать по утрам', undefined, 'DESIRE'),
];

describe('дело, разрезанное моделью по дням, — снова одно (живой прогон 27.09.2026)', () => {
  it('три «отчёта» из одного сказанного — один, и дни уходят соседям без срока', () => {
    const result = rejoinSplitByDays(RECORDED, texts(RECORDED), SPEECH);

    expect(texts(result.items)).toEqual([
      'Сегодня в 2 часа дня отвезти маме лекарство',
      'Завтра в 12 отвести Машу на день рождения к подружке',
      'Купить подарки Маше',
      'В понедельник записать Мишу к ортодонту',
      'Оплатить кружок',
      'Сдать отчёт по продажам во вторник до обеда',
      'Купить подарок свекрови на день рождения',
      'Голова кругом, если честно',
      'Хочу начать бегать по утрам',
    ]);
    expect(result.said).toEqual(texts(result.items));

    // «оплатить кружок. По рисованию до среды» — день кружку.
    const club = byText(result.items, 'Оплатить кружок');
    expect(club?.deadlineText).toBe('до среды');
    expect(club?.deadline).toBe('2026-09-30');
    expect(club?.deadlineAccuracy).toBe('day');

    // «до обеда в субботу. У свекрови день рождения» — день подарку.
    const gift = byText(result.items, 'Купить подарок свекрови на день рождения');
    expect(gift?.deadlineText).toBe('в субботу');
    expect(gift?.deadline).toBe('2026-10-03');

    // Оставшийся отчёт — со своим вторником.
    expect(byText(result.items, 'Сдать отчёт по продажам во вторник до обеда')?.deadlineText).toBe(
      'во вторник',
    );
    // Подарок подружке — далеко от обоих дней, срока не получает.
    expect(byText(result.items, 'Купить подарки Маше')?.deadlineText).toBe('');

    expect(result.merged).toBe(2);
    expect(result.moved).toBe(2);
  });
});

describe('где правило молчит', () => {
  it('разные глаголы при общем имени: «Отвести Машу» и «Купить подарки Маше»', () => {
    const items = [
      raw('Отвести Машу на день рождения', { deadline: '2026-09-28', deadlineText: 'завтра' }),
      raw('Купить подарки Маше', { deadline: '2026-10-03', deadlineText: 'в субботу' }),
    ];

    const result = rejoinSplitByDays(
      items,
      texts(items),
      'Завтра Машу отвести на день рождения, надо еще подарки ей купить в субботу.',
    );

    expect(result.items).toEqual(items);
    expect(result.merged).toBe(0);
  });

  it('один глагол, разные предметы: «купить хлеб сегодня и молоко завтра»', () => {
    const items = [
      raw('Купить хлеб', { deadline: '2026-09-27', deadlineText: 'сегодня' }),
      raw('Купить молоко', { deadline: '2026-09-28', deadlineText: 'завтра' }),
    ];

    const result = rejoinSplitByDays(items, texts(items), 'Купить хлеб сегодня и молоко завтра.');

    expect(result.items).toEqual(items);
  });

  it('законный список без дней: «сдать анализы крови и мочи» — два дела остаются', () => {
    const items = [raw('Сдать анализы крови'), raw('Сдать анализы мочи')];

    const result = rejoinSplitByDays(items, texts(items), 'Сдать анализы крови и мочи.');

    expect(result.items).toEqual(items);
  });

  it('список с одним днём на всех — тоже не дубль', () => {
    const day = { deadline: '2026-09-29', deadlineText: 'во вторник' };
    const items = [raw('Сдать анализы крови', day), raw('Сдать анализы мочи', day)];

    const result = rejoinSplitByDays(items, texts(items), 'Во вторник сдать анализы крови и мочи.');

    expect(result.items).toEqual(items);
  });

  it('предмет сказан дважды — два дела законны', () => {
    const items = [
      raw('Сдать отчёт по продажам', { deadline: '2026-09-29', deadlineText: 'во вторник' }),
      raw('Сдать отчёт по складу', { deadline: '2026-10-03', deadlineText: 'в субботу' }),
    ];

    const result = rejoinSplitByDays(
      items,
      texts(items),
      'Во вторник сдать отчет по продажам, а в субботу сдать отчет по складу.',
    );

    expect(result.items).toEqual(items);
  });

  it('дню некому отдаться рядом — он пропадает вместе с куском, а не уходит далёкому делу', () => {
    const items = [
      raw('Купить хлеб'),
      raw('Сдать отчёт по продажам во вторник до обеда', {
        deadline: '2026-09-29',
        deadlineText: 'во вторник',
      }),
      raw('В субботу сдать отчёт по продажам', {
        deadline: '2026-10-03',
        deadlineText: 'в субботу',
      }),
      raw('Разобрать шкаф'),
    ];

    const result = rejoinSplitByDays(
      items,
      texts(items),
      'Купить хлеб. Отчет по продажам сдать во вторник до обеда в субботу. Потом как-нибудь разобрать шкаф.',
    );

    expect(texts(result.items)).toEqual([
      'Купить хлеб',
      'Сдать отчёт по продажам во вторник до обеда',
      'Разобрать шкаф',
    ]);
    expect(byText(result.items, 'Разобрать шкаф')?.deadlineText).toBe('');
    expect(byText(result.items, 'Купить хлеб')?.deadlineText).toBe('');
    expect(result.merged).toBe(1);
    expect(result.moved).toBe(0);
  });

  it('рядом с днём два дела без срока — кому он, не угадываем', () => {
    const items = [
      raw('Купить хлеб'),
      raw('Позвонить маме'),
      raw('Сдать отчёт по продажам во вторник', {
        deadline: '2026-09-29',
        deadlineText: 'во вторник',
      }),
      raw('В субботу сдать отчёт по продажам', {
        deadline: '2026-10-03',
        deadlineText: 'в субботу',
      }),
    ];

    const result = rejoinSplitByDays(
      items,
      texts(items),
      'Купить хлеб в субботу позвонить маме. Отчет по продажам сдать во вторник.',
    );

    expect(texts(result.items)).toEqual([
      'Купить хлеб',
      'Позвонить маме',
      'Сдать отчёт по продажам во вторник',
    ]);
    expect(byText(result.items, 'Купить хлеб')?.deadlineText).toBe('');
    expect(byText(result.items, 'Позвонить маме')?.deadlineText).toBe('');
    expect(result.moved).toBe(0);
  });

  it('день не перепрыгивает через чужое дело: «купить хлеб, позвонить маме в субботу»', () => {
    const items = [
      raw('Купить хлеб'),
      raw('Позвонить маме', { deadline: '2026-10-03', deadlineText: 'в субботу' }),
      raw('Сдать отчёт по продажам во вторник', {
        deadline: '2026-09-29',
        deadlineText: 'во вторник',
      }),
      raw('В субботу сдать отчёт по продажам', {
        deadline: '2026-10-03',
        deadlineText: 'в субботу',
      }),
    ];

    const result = rejoinSplitByDays(
      items,
      texts(items),
      'Купить хлеб, позвонить маме в субботу. Отчет по продажам сдать во вторник.',
    );

    expect(texts(result.items)).toEqual([
      'Купить хлеб',
      'Позвонить маме',
      'Сдать отчёт по продажам во вторник',
    ]);
    expect(byText(result.items, 'Купить хлеб')?.deadlineText).toBe('');
    expect(result.moved).toBe(0);
  });

  it('речи нет — проверять нечем, ничего не трогает', () => {
    const result = rejoinSplitByDays(RECORDED, texts(RECORDED), undefined);

    expect(result.items).toEqual(RECORDED);
    expect(result.merged).toBe(0);
  });

  it('слова извлечения не сошлись по числу — дальше их не отдаёт: сопоставлять не с чем', () => {
    const result = rejoinSplitByDays(RECORDED, texts(RECORDED).slice(1), SPEECH);

    expect(result.said).toBeUndefined();
  });
});
