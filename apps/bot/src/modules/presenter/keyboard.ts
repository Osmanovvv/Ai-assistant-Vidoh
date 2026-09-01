import { InlineKeyboard } from 'grammy';

import type { StatusButton } from './status.service.js';

/**
 * Раскладка кнопок по строкам (найдено ручным прогоном 01.09.2026).
 *
 * **Кнопки §13.2 стояли одной строкой, и в коде было записано допущение:
 * «подписи короткие».** На телефоне они не короткие. Три кнопки делят
 * ширину экрана на три, и «Оставить на потом» превращалось в
 * «Остави…потом» — человек читал огрызок и не понимал, что нажимает.
 * На компьютере всё выглядело прилично, поэтому и не замечали.
 *
 * Обрезались бы так же «Добавить к прошлой», «На сегодня хватит» и
 * «Начать с чистого листа» — то есть половина кнопок продукта.
 *
 * **Считаем длину подписи, а не число кнопок.** Telegram делит ширину
 * строки на кнопки поровну, значит запас у каждой зависит от того,
 * сколько их в строке. Две короткие рядом — это удобно и надо оставить;
 * длинную приходится ставить одну.
 */

/**
 * Сколько знаков помещается в кнопку, если их в строке столько.
 *
 * Числа взяты под узкий телефон в 360 точек, а не под наш монитор:
 * ошибиться в сторону запаса дешевле, чем ещё раз показать огрызок.
 */
const ROOM = [0, 30, 14, 9, 7] as const;

function room(count: number): number {
  return ROOM[count] ?? 6;
}

/**
 * Уместится ли строка из таких подписей.
 *
 * Наружу — чтобы страж в `keyboards.test.ts` проверял этим же правилом
 * все клавиатуры продукта, а не пересказывал его своими числами.
 */
export function rowFits(labels: readonly string[]): boolean {
  const longest = labels.reduce((max, label) => Math.max(max, label.length), 0);

  return longest <= room(labels.length);
}

/**
 * Раскладывает кнопки по строкам, не меняя их порядка.
 *
 * Кнопки только **разъезжаются** по строкам, но никогда не съезжаются:
 * порядок — это смысл, и «Сделать сейчас» обязано стоять первым.
 */
export function packButtons(buttons: readonly StatusButton[]): StatusButton[][] {
  const rows: StatusButton[][] = [];
  let current: StatusButton[] = [];

  for (const button of buttons) {
    const candidate = [...current, button];

    if (current.length > 0 && !rowFits(candidate.map((one) => one.label))) {
      rows.push(current);
      current = [button];
      continue;
    }

    current = candidate;
  }

  if (current.length > 0) rows.push(current);

  return rows;
}

/**
 * Пересобирает готовые строки, разбивая слишком широкие.
 *
 * Строки, которые вызывающий код задал сам, — это его решение о смысле:
 * их можно разбить, но нельзя слить. Поэтому каждая раскладывается
 * отдельно.
 */
export function packRows(rows: readonly (readonly StatusButton[])[]): StatusButton[][] {
  return rows.flatMap((row) => packButtons(row));
}

/**
 * Клавиатура Telegram из строк кнопок, с раскладкой по ширине.
 *
 * **Единственная сборка клавиатуры в продукте, и это главное.** До
 * починки каждый обработчик собирал свою через `new InlineKeyboard()`, и
 * правило «подписи короткие» жило в комментарии одного из них. Пока сборка
 * одна, следующая длинная подпись раскладывается сама.
 */
export function fitKeyboard(rows: readonly (readonly StatusButton[])[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  /**
   * Перенос строки — **между** строками, а не после каждой.
   *
   * Прежняя сборка вопросов звала `row()` в конце каждой строки и
   * оставляла пустую в хвосте. Telegram такое терпит молча, поэтому
   * прожило долго. Поймал тест на составе клавиатуры.
   */
  packRows(rows).forEach((row, index) => {
    if (index > 0) keyboard.row();
    for (const button of row) keyboard.text(button.label, button.action);
  });

  return keyboard;
}
