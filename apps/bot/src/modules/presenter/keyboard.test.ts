import { describe, expect, it } from 'vitest';

import { defaultTexts } from '../../texts/index.js';
import { fitKeyboard, packButtons, packRows, rowFits } from './keyboard.js';

/**
 * Раскладка кнопок по ширине (дефект найден на телефоне 01.09.2026).
 *
 * Проверяется не «сколько кнопок в строке», а **влезает ли подпись**:
 * дефект был именно в том, что число кнопок считали, а длину подписи —
 * нет. Поэтому в таблицах ниже стоят настоящие подписи продукта, а не
 * «кнопка 1» и «кнопка 2»: на выдуманных коротких словах эта ошибка и
 * прожила до боевого бота.
 */

const button = (label: string) => ({ label, action: `a:${label}` });
const labelsOf = (rows: readonly (readonly { readonly label: string }[])[]): string[][] =>
  rows.map((row) => row.map((one) => one.label));

const answer = defaultTexts.answer;

describe('строка из трёх кнопок §13.2', () => {
  const trio = [answer.buttonDoNow, answer.buttonShowAll, answer.buttonLater].map(button);

  it('«Оставить на потом» уезжает на свою строку', () => {
    // Ровно тот случай со скриншота: было «Остави…потом».
    expect(labelsOf(packButtons(trio))).toEqual([
      ['Сделать сейчас', 'Разобрать всё'],
      ['Оставить на потом'],
    ]);
  });

  it('порядок §13.2 сохраняется', () => {
    // Раскладка меняет строки, но не смысл: «Сделать сейчас» — первое.
    expect(
      packButtons(trio)
        .flat()
        .map((one) => one.label),
    ).toEqual([answer.buttonDoNow, answer.buttonShowAll, answer.buttonLater]);
  });

  it('ни одна кнопка не потерялась и не удвоилась', () => {
    expect(packButtons(trio).flat()).toHaveLength(trio.length);
  });
});

describe('пары кнопок продукта', () => {
  it.each([
    // Две короткие — остаются рядом, так удобнее.
    [[defaultTexts.reminders.buttonDone, defaultTexts.reminders.buttonPostpone], 1],
    [[defaultTexts.start.buttonVoice, defaultTexts.start.buttonText], 1],
    [[defaultTexts.resolver.buttonRemember, defaultTexts.resolver.buttonNoNeed], 1],
    [[defaultTexts.reminders.buttonProjectTake, defaultTexts.reminders.buttonProjectLater], 1],
    // Длинная — забирает строку себе.
    [[defaultTexts.resolver.buttonAttach, defaultTexts.resolver.buttonSeparate], 2],
    [[defaultTexts.resolver.buttonGoOn, defaultTexts.resolver.buttonEnough], 2],
    [[defaultTexts.returning.buttonContinue, defaultTexts.returning.buttonFresh], 2],
    [[defaultTexts.privacy.deleteFinalButton, defaultTexts.privacy.deleteCancelButton], 2],
  ])('%s → строк: %i', (labels, rows) => {
    expect(packButtons(labels.map(button))).toHaveLength(rows);
  });
});

describe('карточка записи', () => {
  it('четыре кнопки карточки остаются по две', () => {
    // Здесь всё было в порядке и до починки: подписи короткие. Тест
    // сторожит, чтобы раскладка не «улучшила» то, что и так работало.
    const card = defaultTexts.card;

    expect(
      labelsOf(
        packRows([
          [button(card.buttonDone), button(card.buttonSnooze)],
          [button(card.buttonEdit), button(card.buttonDelete)],
        ]),
      ),
    ).toEqual([
      ['Сделано', 'Отложить'],
      ['Изменить', 'Убрать'],
    ]);
  });
});

describe('заданные строки не сливаются', () => {
  it('две строки по одной кнопке так и остаются двумя', () => {
    /**
     * Важнее, чем кажется. Соблазн «уплотнить» раскладку сломал бы
     * онбординг: там время «07:00» и «Не надо вечером» стоят отдельными
     * строками намеренно — это разные по смыслу ответы.
     */
    const rows = [[button('07:00')], [button('Не надо вечером')]];

    expect(labelsOf(packRows(rows))).toEqual([['07:00'], ['Не надо вечером']]);
  });

  it('широкая строка разбивается, соседняя не трогается', () => {
    const rows = [
      [button('Да'), button('Нет')],
      [button(answer.buttonDoNow), button(answer.buttonLater)],
    ];

    expect(labelsOf(packRows(rows))).toEqual([
      ['Да', 'Нет'],
      ['Сделать сейчас'],
      ['Оставить на потом'],
    ]);
  });
});

describe('правило ширины', () => {
  it('одинокой кнопке достаётся вся ширина', () => {
    expect(rowFits([defaultTexts.privacy.deleteFinalButton])).toBe(true);
  });

  it('та же подпись в паре уже не влезает', () => {
    // Самая широкая подпись продукта — «Да, удалить безвозвратно», 178
    // точек при замере. В целую строку входит, в половину — нет.
    expect(rowFits([defaultTexts.privacy.deleteFinalButton, 'Отмена'])).toBe(false);
  });

  it('считается ширина знаков, а не их число', () => {
    /**
     * Суть исправления правила. Первая версия считала знаки — и это была
     * та же ошибка, что и в самом дефекте, только на новый лад: «щ» вдвое
     * шире «г». Двадцать узких знаков уже, чем четырнадцать широких.
     */
    const narrow = 'г'.repeat(20);
    const wide = 'щ'.repeat(14);

    expect(narrow.length).toBeGreaterThan(wide.length);
    expect(rowFits([narrow, narrow])).toBe(true);
    expect(rowFits([wide, wide])).toBe(false);
  });

  it('проверка ловит перебор, а не пропускает его', () => {
    // Страж, который врёт, хуже отсутствующего.
    expect(rowFits(['я'.repeat(31)])).toBe(false);
    expect(rowFits(['я'.repeat(15), 'я'.repeat(3)])).toBe(false);
    expect(rowFits(['я'.repeat(10), 'я'.repeat(3), 'я'.repeat(3)])).toBe(false);
  });

  it('пустая строка кнопок ничего не ломает', () => {
    // Сама grammY начинает клавиатуру с одной пустой строки, поэтому
    // проверяется то, что важно: кнопок нет ни одной.
    expect(packButtons([])).toEqual([]);
    expect(fitKeyboard([]).inline_keyboard.flat()).toEqual([]);
  });
});

describe('клавиатура собирается настоящая', () => {
  it('строки раскладки становятся строками Telegram', () => {
    const keyboard = fitKeyboard([
      [button(answer.buttonDoNow), button(answer.buttonShowAll), button(answer.buttonLater)],
    ]);

    expect(keyboard.inline_keyboard.map((row) => row.map((one) => one.text))).toEqual([
      ['Сделать сейчас', 'Разобрать всё'],
      ['Оставить на потом'],
    ]);
  });

  it('действия кнопок доезжают без изменений', () => {
    // Раскладка трогает строки, а не `callback_data`: перепутанное
    // действие — это нажатие не туда.
    const keyboard = fitKeyboard([[button(answer.buttonLater)]]);
    const [row] = keyboard.inline_keyboard;
    const [first] = row ?? [];

    expect(first && 'callback_data' in first ? first.callback_data : undefined).toBe(
      `a:${answer.buttonLater}`,
    );
  });
});
