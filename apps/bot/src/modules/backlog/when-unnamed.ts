import { FRAME_WORDS, normalizeText, wordsOf } from './question-words.js';

/**
 * Вопрос о сроке без названного дела (проверка Никиты 25.09.2026, 20:23).
 *
 * Бот ответил про стоматолога, человек переспросил «На когда» — с
 * опиской и поправкой в одной выгрузке: «На когад На когда». Предмета в
 * вопросе нет, поиск по смыслу ничего не нашёл, и ответ был «Про это у
 * меня ничего не записано». Спрашивали про то, о чём только что шла речь.
 *
 * Признак узкий, из трёх условий: все слова — рамка вопроса (`FRAME_WORDS`)
 * или слова вокруг срока; хоть одно — о сроке («когда», «во сколько»,
 * «какого числа»); других слов нет. «Что там?» и «Что делать?» — без
 * слова о сроке, это не он; «На когда стоматолог?» — дело названо, его
 * найдёт обычный поиск. Общую рамку не трогает: она одна на три разбора.
 */
const WHEN_WORDS: ReadonlySet<string> = new Set([
  'когда',
  'сколько',
  'числа',
  'число',
  'срок',
  'срока',
]);

/** Слова вокруг срока, которые дела не называют: «во сколько», «какого числа у него». */
const AROUND_WORDS: ReadonlySet<string> = new Set([
  'во',
  'со',
  'с',
  'какого',
  'какое',
  'ну',
  'так',
  'ли',
  'же',
  'его',
  'ее',
  'него',
  'нее',
  'он',
  'она',
  'оно',
  'этим',
  'этом',
  'тогда',
]);

const FRAME: ReadonlySet<string> = new Set(FRAME_WORDS.map(normalizeText));

function known(word: string): boolean {
  return FRAME.has(word) || WHEN_WORDS.has(word) || AROUND_WORDS.has(word);
}

/** Одна правка между словами: замена, вставка, пропуск или перестановка соседних букв. */
function oneEditApart(one: string, other: string): boolean {
  if (one === other || Math.abs(one.length - other.length) > 1) return false;

  if (one.length === other.length) {
    const differ: number[] = [];
    for (let index = 0; index < one.length; index++) {
      if (one[index] !== other[index]) differ.push(index);
    }
    if (differ.length === 1) return true;
    const [first, second] = differ;
    return (
      differ.length === 2 &&
      first !== undefined &&
      second === first + 1 &&
      one[first] === other[second] &&
      one[second] === other[first]
    );
  }

  const [longer, shorter] = one.length > other.length ? [one, other] : [other, one];
  for (let skip = 0; skip < longer.length; skip++) {
    if (longer.slice(0, skip) + longer.slice(skip + 1) === shorter) return true;
  }
  return false;
}

/**
 * Описка, поправленная в том же вопросе: незнакомое слово от четырёх букв,
 * в одной правке от знакомого слова рядом («когад» при «когда»). Без
 * правильного слова рядом описка не угадывается — «На когад» остаётся
 * как есть.
 */
function slipInSameQuestion(word: string, words: readonly string[]): boolean {
  return (
    word.length >= 4 &&
    !known(word) &&
    words.some((other) => known(other) && oneEditApart(word, other))
  );
}

export function asksWhenOfUnnamed(text: string): boolean {
  const words = wordsOf(text);
  const kept = words.filter((word) => !slipInSameQuestion(word, words));

  return kept.some((word) => WHEN_WORDS.has(word)) && kept.every(known);
}
