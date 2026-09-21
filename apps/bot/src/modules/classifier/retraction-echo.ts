import { looksLikeThought } from '../router/thought-words.js';
import { ownSentences, retractingSentences, sharesSignificantWord } from './own-sentence.js';

/**
 * Эхо самопоправки — не запись (стенд 21.09.2026, живой набор `live-14`).
 *
 * «Так, во вторник надо отвезти дочку к врачу, хотя нет к врачу лучше в
 * пятницу» — извлечение сделало две единицы: «Во вторник надо отвезти
 * дочку к врачу» и «К врачу лучше в пятницу». День у первой перенесён
 * правилом отмены вслух (`dayAfterRetraction`) верно, а вторая — те же
 * слова поправки — легла второй записью про врача. Поправка меняет
 * соседа; сама она записью не бывает.
 *
 * Правило, а не догадка, и условий три, все проверяемые:
 *
 * 1. Единица **дословно принадлежит** отменяющему предложению и только
 *    ему — та же однозначность, что у запасного пути дня
 *    (`touchedSentences`: цепочка от двух слов, найденная ровно в одном
 *    предложении). «Во вторник к врачу» касается прежнего предложения,
 *    и общая с поправкой пара «к врачу» ничего не решает.
 * 2. В единице нет ни слова долга, ни глагола дела (`thought-words.ts`):
 *    «помыть машину», «позвонить стоматологу» внутри отменяющей фразы —
 *    настоящие дела, они остаются.
 * 3. У неё есть сосед с общим значимым словом — то дело, которое
 *    поправка и правила: без него это поправка сама по себе, и решать за
 *    человека нельзя.
 *
 * Считается **после** классификации, по текстам единиц: вход модели не
 * меняется, и починка меряется по записи ответов бесплатно.
 */
export function retractionEchoes(units: readonly string[], speech: string): Set<number> {
  const echoes = new Set<number>();
  const retracting = new Set(retractingSentences(speech));
  if (retracting.size === 0) return echoes;

  for (const [index, unit] of units.entries()) {
    if (looksLikeThought(unit)) continue;

    const own = ownSentences(unit, speech);
    if (own.length === 0 || !own.every((sentence) => retracting.has(sentence))) continue;

    const hasSibling = units.some(
      (other, at) => at !== index && sharesSignificantWord(unit, other),
    );
    if (!hasSibling) continue;

    echoes.add(index);
  }

  return echoes;
}
