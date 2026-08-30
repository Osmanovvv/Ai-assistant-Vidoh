/**
 * Списки бэклога с постраничностью (§12.1 ТЗ, задача 3.11).
 *
 * **Двести записей в одно сообщение не помещаются.** Telegram отводит на
 * текст 4096 знаков, а на клавиатуру — сотню кнопок; список из двухсот
 * дел не пройдёт ни по одному из пределов, и бот молча ответит ошибкой.
 * Проверять это на живом человеке с накопленным списком — поздно.
 *
 * Страница здесь — чистая арифметика: ни базы, ни Telegram. Всё, что она
 * умеет, проверяется таблицей.
 */

/**
 * Сколько записей на странице.
 *
 * Не по пределу Telegram, а по человеку: восемь строк читаются одним
 * взглядом, двадцать — уже список, в котором ищут. Предел платформы при
 * восьми не достигается с любым разумным заголовком.
 */
export const PAGE_SIZE = 8;

export interface Page<T> {
  readonly items: readonly T[];
  /** Номер страницы с нуля. */
  readonly index: number;
  readonly pages: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  /** Сколько всего записей: человеку полезно знать масштаб. */
  readonly total: number;
}

/**
 * Отрезает страницу.
 *
 * Номер за пределами списка не ошибка: кнопка «дальше» могла остаться в
 * старом сообщении, а записи с тех пор закрылись. Такой номер
 * прижимается к последней странице — человек увидит конец списка, а не
 * пустоту.
 */
export function pageOf<T>(items: readonly T[], index: number, size = PAGE_SIZE): Page<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const safe = Math.min(Math.max(0, Math.trunc(index)), pages - 1);
  const from = safe * size;

  return {
    items: items.slice(from, from + size),
    index: safe,
    pages,
    hasPrevious: safe > 0,
    hasNext: safe < pages - 1,
    total: items.length,
  };
}
