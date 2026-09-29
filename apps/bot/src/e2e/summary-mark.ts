import { defaultTexts, type TextProfile } from '../texts/index.js';

/**
 * Сводка ли это ветки — для стендов, которые ищут последний ответ человеку.
 *
 * По ветке сводку не отличить: её обновляют правкой по номеру сообщения, а
 * у правки признака ветки нет. Раньше признаком были слова заголовка «— что
 * здесь есть:»; с 29.09.2026 заголовок — просто название темы (правка
 * заказчицы), и признак — названия веток: сводка начинается с заголовка
 * своей ветки отдельной строкой.
 */
export function isTopicSummary(
  text: string,
  topicNames: readonly string[],
  texts: TextProfile = defaultTexts,
): boolean {
  return topicNames.some((name) => {
    const header = texts.summary.header(name);
    return text === header || text.startsWith(`${header}\n`);
  });
}
