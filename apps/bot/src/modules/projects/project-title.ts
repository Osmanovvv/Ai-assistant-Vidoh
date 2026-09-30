import { sameWord, words } from '../resolver/clarify.js';

/**
 * Короткое название цели от модели раскладки — или ничего (заказчица,
 * 30.09.2026).
 *
 * Её голосовое: «Так мне надо разобраться с днём рождения ребёнка. Место,
 * гости, торт, украшения, ведущий». Цель записалась одной строкой вместе с
 * частями. Части — это шаги, а в названии должна остаться сама цель.
 *
 * Отличить части («…, место, гости, торт») от продолжения фразы
 * («разобрать шкаф, балкон, гараж») может только смысл, поэтому название
 * предлагает модель раскладки. Код принимает его, только если:
 *
 * 1. это её же слова с начала названия — модель укоротила, а не переписала;
 * 2. отрезано по границе перечисления: в названии дальше идёт запятая,
 *    двоеточие или тире, а не середина фразы;
 * 3. каждое отрезанное слово есть в шагах — ничего не потеряно;
 * 4. шаги с отрезанными словами не повторяют действие цели — её первое
 *    слово: «Разобрать балкон» при «Разобрать шкаф, балкон, гараж» значит,
 *    что балкон — продолжение цели, а не её часть. Только первое: «Купить
 *    школьную форму» при «Подготовить сына к школе» — часть, а не повтор
 *    (проба decomposer@2, 30.09.2026).
 *
 * Не прошло — название остаётся прежним: как было до правки, не хуже.
 */
export function shortTitleFrom(
  original: string,
  proposed: string | undefined,
  steps: readonly string[],
): string | undefined {
  if (proposed === undefined) return undefined;

  const theirs = [...normalized(original).matchAll(/[\p{L}\d]+/gu)].map((match) => ({
    word: match[0],
    end: match.index + match[0].length,
  }));
  const short = words(normalized(proposed));
  if (short.length === 0 || short.length >= theirs.length) return undefined;

  // 1. Слово в слово с начала названия.
  if (short.some((word, index) => theirs[index]?.word !== word)) return undefined;

  // 2. Дальше в названии — граница перечисления.
  const end = theirs[short.length - 1]?.end ?? 0;
  if (!/^\s*[,:;—–-]/u.test(original.slice(end))) return undefined;

  // 3. Отрезанное — в шагах, 4. и шаги с ним не повторяют саму цель.
  const cut = theirs
    .slice(short.length)
    .map(({ word }) => word)
    .filter((word) => word.length >= 3 && !LINKING.has(word));
  if (cut.length === 0) return undefined;

  const [action] = short;
  const stepWords = steps.map((step) => words(normalized(step)));
  const covered = cut.every((word) => {
    const holders = stepWords.filter((step) => step.some((own) => sameWord(own, word)));
    return (
      holders.length > 0 &&
      holders.every((step) => !step.some((own) => action !== undefined && sameWord(own, action)))
    );
  });
  if (!covered) return undefined;

  return original.slice(0, end).trim();
}

/** Связки перечисления: сами по себе не часть цели. */
const LINKING = new Set(['или', 'еще', 'тоже', 'также', 'плюс', 'для', 'про', 'все', 'это']);

function normalized(text: string): string {
  return text.toLowerCase().replace(/ё/gu, 'е');
}
