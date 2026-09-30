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

function wordsOf(text: string): readonly string[] {
  return text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}
