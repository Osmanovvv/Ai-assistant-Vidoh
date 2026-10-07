import type { ExtractedUnit } from '../extractor/extractor.service.js';
import { sameWord } from '../resolver/clarify.js';
import { FUNCTION_WORDS } from './own-sentence.js';

/**
 * Единицы, которых нет в ответе классификации (заказчица, 30.09.2026).
 *
 * Схема просит столько записей, сколько пришло единиц, но модель может
 * вернуть меньше — и тогда недостающее пропадало бы молча: код разбирает
 * только то, что вернулось. Её голосовое потеряло дело на соседнем шаге
 * (извлечение); здесь та же дыра закрыта заранее.
 *
 * Сверяется только при недостаче: записей не меньше — модель ничего не
 * потеряла. Единица считается покрытой, если хоть одно её значимое слово
 * есть в какой-нибудь записи: модель вправе слить «купить молоко» и
 * «молоко два литра» в одно дело. Узнать единицу не по чему — не угадываем.
 */
export function missingUnits(
  units: readonly ExtractedUnit[],
  titles: readonly string[],
): readonly ExtractedUnit[] {
  if (titles.length >= units.length) return [];

  const theirs = titles.map(wordsOf);
  return units.filter((unit) => {
    const own = wordsOf(unit.text).filter((word) => word.length >= 4 && !FUNCTION_WORDS.has(word));
    if (own.length === 0) return false;
    return !theirs.some((words) => words.some((word) => own.some((mine) => sameWord(word, mine))));
  });
}

/**
 * Убирает склейку соседних единиц, когда модель вернула правильное число
 * записей, но вписала слова следующей единицы в предыдущую.
 *
 * Сверка «есть ли слово где-нибудь в ответе» не ловит такой случай:
 * «врач, ещё посылка» и отдельная «посылка» выглядят как две покрытые
 * единицы. Порядок ответа классификатора совпадает с порядком extractor,
 * поэтому при явном пересечении двух значимых слов соседней единицы берём
 * исходный текст именно своей единицы. Дата и сфера дальше проверяются
 * обычным корректором уже на чистом тексте.
 *
 * Одна общая запись при меньшем количестве ответов намеренно не меняется:
 * это существующий случай, когда extractor оставил одну составную мысль.
 */
export function repairMergedItems<T extends { readonly text: string }>(
  units: readonly ExtractedUnit[],
  items: readonly T[],
): { readonly items: readonly T[]; readonly repaired: number } {
  if (units.length < 2 || items.length !== units.length) {
    return { items, repaired: 0 };
  }

  const unitWords = units.map((unit) => significantWords(unit.text));
  let repaired = 0;
  const fixed = items.map((item, index) => {
    const ownWords = unitWords[index] ?? [];
    if (ownWords.length === 0) return item;

    const itemWords = wordsOf(item.text);
    const ownMatches = overlap(itemWords, ownWords);
    const foreignMatches = unitWords.reduce(
      (count, words, unitIndex) =>
        unitIndex === index ? count : count + overlap(itemWords, words),
      0,
    );

    // Одного общего слова недостаточно: «забрать» может встречаться в
    // соседних делах. Два значимых слова дают надёжный признак склейки.
    if (ownMatches === 0 || foreignMatches < 2) return item;

    const unit = units[index];
    if (unit === undefined) return item;

    repaired++;
    return { ...item, text: unit.text };
  });

  return { items: fixed, repaired };
}

function significantWords(text: string): readonly string[] {
  return wordsOf(text).filter((word) => word.length >= 4 && !FUNCTION_WORDS.has(word));
}

function overlap(itemWords: readonly string[], unitWords: readonly string[]): number {
  return unitWords.filter((unitWord) => itemWords.some((itemWord) => sameWord(itemWord, unitWord)))
    .length;
}

function wordsOf(text: string): readonly string[] {
  return text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}
