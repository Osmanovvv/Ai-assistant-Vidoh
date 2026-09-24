import { describe, expect, it } from 'vitest';

import {
  DIALOG_HEADING,
  DIALOG_TURN_MAX_CHARS,
  describeDialog,
  recentDialog,
  recordNamedByLastBot,
  type DialogTurn,
} from './dialog.js';

/**
 * Хвост разговора для резолвера (план docs/26, задача 4).
 *
 * Замер «как сейчас» 24.09.2026: без разговора модель в трёх случаях из
 * семи молча поправила не то дело — выбирала свежее или совпавшее слово,
 * не зная, о чём бот говорил секунду назад.
 */

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Видимые знаки строки — так, как их видит человек. */
const visible = (text: string): string[] =>
  Array.from(GRAPHEMES.segment(text), (piece) => piece.segment);

const NOW = new Date('2026-09-23T13:20:00.000Z');
const at = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);
const bot = (text: string, minutes: number, messageId?: number): DialogTurn => ({
  role: 'bot',
  text,
  at: at(minutes),
  ...(messageId === undefined ? {} : { messageId }),
});
const person = (text: string, minutes: number): DialogTurn => ({
  role: 'person',
  text,
  at: at(minutes),
});

describe('какие реплики идут в хвост', () => {
  it('старше 15 минут — не в счёт', () => {
    expect(recentDialog([bot('старое', 16), bot('свежее', 2)], NOW).map((t) => t.text)).toEqual([
      'свежее',
    ]);
  });

  it('ровно 15 минут — ещё в счёт', () => {
    expect(recentDialog([bot('на границе', 15)], NOW)).toHaveLength(1);
  });

  it('из будущего — не в счёт: часы разошлись, а не разговор', () => {
    expect(recentDialog([bot('завтрашнее', -1)], NOW)).toEqual([]);
  });

  it('не больше четырёх последних, по порядку времени', () => {
    const turns = [person('5', 5), bot('2', 8), person('1', 9), bot('4', 6), person('3', 7)];
    expect(recentDialog(turns, NOW).map((t) => t.text)).toEqual(['2', '3', '4', '5']);
  });

  it('правка того же сообщения заменяет его, а не добавляет («Слушаю…» → итог)', () => {
    const turns = [bot('Слушаю…', 3, 77), bot('Записала 1 дело: Купить хлеб', 2, 77)];
    expect(recentDialog(turns, NOW).map((t) => t.text)).toEqual(['Записала 1 дело: Купить хлеб']);
  });

  it('разные сообщения с номерами не склеиваются', () => {
    expect(recentDialog([bot('первое', 3, 1), bot('второе', 2, 2)], NOW)).toHaveLength(2);
  });
});

describe('текст блока для модели', () => {
  it('пустой хвост — пустая строка, блока нет', () => {
    expect(describeDialog([], NOW)).toBe('');
    expect(describeDialog([bot('давно', 40)], NOW)).toBe('');
  });

  it('заголовок, кто и сколько минут назад', () => {
    const text = describeDialog([bot('Через 30 минут: Забрать посылку', 3), person('ок', 0)], NOW);
    expect(text.split('\n')).toEqual([
      DIALOG_HEADING,
      'Бот (3 мин назад): Через 30 минут: Забрать посылку',
      'Человек (только что): ок',
    ]);
  });

  it('заголовок запрещает брать из разговора новые дела и сроки', () => {
    expect(DIALOG_HEADING).toContain('о какой записи речь');
    expect(DIALOG_HEADING).toContain('Новых дел и сроков из него не бери');
  });

  it('заголовок ставит реплику бота выше похожего слова и свежести (проба 24.09)', () => {
    // Проба шага 3: «посылку давай на субботу» сразу после «Через 30 минут:
    // Забрать посылки с Вайлдберриз» ушло в «Забрать посылку» — слово
    // совпало дословно, запись менялась 6 минут назад, а промпт велит
    // смотреть на время изменения. Заголовок говорит, что сильнее.
    expect(DIALOG_HEADING).toContain('отвечает на последнюю реплику бота');
    expect(DIALOG_HEADING).toContain('даже если другая запись похожа по словам или менялась позже');
    expect(DIALOG_HEADING).toContain('Новое дело остаётся новым делом');
  });
});

describe('о какой записи была реплика бота (проба 24.09)', () => {
  const PARCELS = ['Забрать посылку', 'Забрать посылки с Вайлдберриз'];

  it('в реплике ровно одно дело из списка — код называет его номер', () => {
    const lines = describeDialog(
      [bot('Через 30 минут: Забрать посылки с Вайлдберриз', 1)],
      NOW,
      PARCELS,
    ).split('\n');

    expect(lines[1]).toBe(
      'Бот (1 мин назад, о записи 2): Через 30 минут: Забрать посылки с Вайлдберриз',
    );
  });

  it('регистр, «ё» и кавычки не мешают', () => {
    const lines = describeDialog(
      [bot('Напомню про «забрать посылку» 24.09 в 17:45', 2), bot('Позвонить Алене?', 1)],
      NOW,
      ['Забрать посылку', 'Позвонить Алёне'],
    ).split('\n');

    expect(lines[1]).toBe(
      'Бот (2 мин назад, о записи 1): Напомню про «забрать посылку» 24.09 в 17:45',
    );
    expect(lines[2]).toBe('Бот (1 мин назад, о записи 2): Позвонить Алене?');
  });

  it('несколько дел в реплике — номера нет: список не указывает на одно дело', () => {
    const lines = describeDialog(
      [bot('Записала 3 дела: Купить хлеб, Позвонить маме, Полить цветы', 2)],
      NOW,
      ['Купить хлеб', 'Позвонить маме', 'Полить цветы'],
    ).split('\n');

    expect(lines[1]).toBe(
      'Бот (2 мин назад): Записала 3 дела: Купить хлеб, Позвонить маме, Полить цветы',
    );
  });

  it('название ищется целыми словами: «Купить хлеб» — не «Купить хлебцы»', () => {
    const lines = describeDialog([bot('Записала 1 дело: Купить хлебцы', 1)], NOW, [
      'Купить хлеб',
      'Купить хлебцы',
    ]).split('\n');

    expect(lines[1]).toBe('Бот (1 мин назад, о записи 2): Записала 1 дело: Купить хлебцы');
  });

  it('одно название внутри другого — не гадаем', () => {
    const lines = describeDialog([bot('Записала 1 дело: Купить хлеб завтра', 1)], NOW, [
      'Купить хлеб',
      'Купить хлеб завтра',
    ]).split('\n');

    expect(lines[1]).toBe('Бот (1 мин назад): Записала 1 дело: Купить хлеб завтра');
  });

  it('реплика человека номера не получает; без названий записей — как раньше', () => {
    expect(describeDialog([person('Забрать посылку', 1)], NOW, PARCELS).split('\n')[1]).toBe(
      'Человек (1 мин назад): Забрать посылку',
    );
    expect(describeDialog([bot('Через 30 минут: Забрать посылку', 1)], NOW).split('\n')[1]).toBe(
      'Бот (1 мин назад): Через 30 минут: Забрать посылку',
    );
  });

  it('дело ищется во всей реплике, а не только в обрезанной части', () => {
    const long = `${'Слово '.repeat(60)}— и ещё про «Забрать посылки с Вайлдберриз»`;
    const line = describeDialog([bot(long, 1)], NOW, PARCELS).split('\n')[1] ?? '';

    expect(line.startsWith('Бот (1 мин назад, о записи 2): ')).toBe(true);
  });

  it('длинное обрезается с многоточием, переводы строк схлопываются', () => {
    const long = `Твои дела:\n${'1. Купить хлеб\n'.repeat(40)}`;
    const line = describeDialog([bot(long, 2)], NOW).split('\n')[1] ?? '';
    const said = line.slice('Бот (2 мин назад): '.length);

    expect(line.startsWith('Бот (2 мин назад): Твои дела: 1. Купить хлеб')).toBe(true);
    expect(said.endsWith('…')).toBe(true);
    expect(visible(said)).toHaveLength(DIALOG_TURN_MAX_CHARS);
    expect(line).not.toContain('\n');
  });

  it('режется по видимым знакам: фирменное 😮‍💨 не разламывается пополам', () => {
    // В ответах бота бывают составные эмодзи (texts/rules.ts). Резка по
    // кодовым точкам оставила бы в конце обломок «😮» без «💨».
    const line = describeDialog([bot('😮‍💨'.repeat(250), 1)], NOW).split('\n')[1] ?? '';
    const pieces = visible(line.slice('Бот (1 мин назад): '.length));

    expect(pieces).toHaveLength(DIALOG_TURN_MAX_CHARS);
    expect(pieces.at(-1)).toBe('…');
    expect(pieces.slice(0, -1).every((piece) => piece === '😮‍💨')).toBe(true);
  });

  it('короткое не трогается', () => {
    expect(describeDialog([bot('Какое дело?', 1)], NOW).split('\n')[1]).toBe(
      'Бот (1 мин назад): Какое дело?',
    );
  });
});

describe('о какой записи была последняя реплика бота (страж, проба 24.09.2026)', () => {
  const PARCELS = ['Забрать посылку', 'Забрать посылки с Вайлдберриз'];

  it('берётся последняя реплика бота, реплики человека не в счёт', () => {
    const turns = [
      bot('Через 30 минут: Забрать посылку', 5),
      bot('Через 30 минут: Забрать посылки с Вайлдберриз', 2),
      person('ок', 1),
    ];
    expect(recordNamedByLastBot(turns, NOW, PARCELS)).toBe(2);
  });

  it('последняя реплика бота без одного названия — номера нет, даже если раньше был', () => {
    const turns = [
      bot('Через 30 минут: Забрать посылку', 5),
      bot('Твои дела: 1. Забрать посылку 2. Забрать посылки с Вайлдберриз', 1),
    ];
    expect(recordNamedByLastBot(turns, NOW, PARCELS)).toBeUndefined();
  });

  it('давняя реплика и пустой хвост — номера нет', () => {
    expect(recordNamedByLastBot([bot('Через 30 минут: Забрать посылку', 40)], NOW, PARCELS)).toBe(
      undefined,
    );
    expect(recordNamedByLastBot([], NOW, PARCELS)).toBeUndefined();
  });
});
