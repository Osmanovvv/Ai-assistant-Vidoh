import { isStrictInfinitive } from '../classifier/split-actions.js';

/**
 * Фраза, порванная вопросительным знаком распознавания (бой 29.09.2026,
 * заказчица): «Спросить рецепт? Рыбы у Анжелы, так ещё нужно…». Сказано
 * было «спросить рецепт рыбы у Анжелы»; распознавание услышало подъём
 * голоса и поставило «?». Разбор взял «Спросить рецепт» делом, а «Рыбы у
 * Анжелы» без глагола потерял — «про Анджелу пропустил».
 *
 * Склеивается только так: перед «?» — дело (первым словом, после связок,
 * глагол в неопределённой форме; ни одного вопросительного слова), после —
 * короткий обрывок без глагола до ближайшего знака. Настоящий вопрос («что
 * у меня на завтра?»), ответ («Нет, лучше…») и новое дело с глаголом не
 * трогаются. Только для расшифровок: в тексте «?» ставит сам человек.
 */

/** Связки перед делом: «так, спросить…», «мне нужно спросить…». */
const LEAD = new Set([
  'так',
  'ну',
  'и',
  'а',
  'ещё',
  'еще',
  'кстати',
  'мне',
  'нам',
  'нужно',
  'надо',
  'также',
  'потом',
  'вот',
  'слушай',
  'смотри',
]);

/** Вопрос, а не дело: вопросительное слово или «ли» где угодно в нём. */
const QUESTION = new Set([
  'что',
  'где',
  'когда',
  'как',
  'почему',
  'зачем',
  'кто',
  'куда',
  'откуда',
  'сколько',
  'какой',
  'какая',
  'какое',
  'какие',
  'каком',
  'какую',
  'чей',
  'чья',
  'чьё',
  'ли',
  'разве',
  'неужели',
]);

/** После «?» — ответ, поправка или своё дело, а не хвост прежнего. */
const NOT_TAIL = new Set([
  'да',
  'нет',
  'не',
  'а',
  'но',
  'или',
  'кстати',
  'так',
  'ну',
  'хотя',
  'это',
  'вот',
  'ещё',
  'еще',
  'и',
  'может',
  'наверное',
  'давай',
  'ладно',
  'ок',
  'надо',
  'нужно',
  'можно',
  'хочу',
  'тоже',
  'потом',
]);

/** Хвост — короткий: длиннее — уже своя фраза. */
const MAX_TAIL_WORDS = 5;

const wordsOf = (text: string): string[] =>
  (text.match(/[\p{L}\d-]+/gu) ?? []).map((word) => word.toLowerCase().replace(/ё/gu, 'е'));

function isDeed(sentence: string): boolean {
  const words = wordsOf(sentence);
  if (words.some((word) => QUESTION.has(word))) return false;
  const first = words.find((word) => !LEAD.has(word));
  return first !== undefined && isStrictInfinitive(first);
}

function isTail(fragment: string): boolean {
  const words = wordsOf(fragment);
  const [first] = words;
  if (first === undefined || words.length > MAX_TAIL_WORDS || NOT_TAIL.has(first)) return false;
  return !words.some((word) => isStrictInfinitive(word));
}

/** Расшифровка с обратно склеенными делами, порванными «?». */
export function rejoinBrokenQuestions(text: string): string {
  let result = text;
  let from = 0;
  for (;;) {
    const mark = result.indexOf('?', from);
    if (mark < 0) return result;
    from = mark + 1;

    const start = Math.max(
      result.lastIndexOf('.', mark - 1),
      result.lastIndexOf('!', mark - 1),
      result.lastIndexOf('?', mark - 1),
      result.lastIndexOf('\n', mark - 1),
    );
    const sentence = result.slice(start + 1, mark);
    const after = /^(\s+)(\p{Lu})/u.exec(result.slice(mark + 1));
    if (after === null || !isDeed(sentence)) continue;

    const rest = result.slice(mark + 1 + (after[1]?.length ?? 0));
    const fragment = rest.split(/[,.!?\n]/u)[0] ?? '';
    if (!isTail(fragment)) continue;

    result = `${result.slice(0, mark)} ${rest.charAt(0).toLowerCase()}${rest.slice(1)}`;
    from = mark;
  }
}
