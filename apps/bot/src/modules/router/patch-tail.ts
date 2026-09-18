import { hasTimeWord } from '../classifier/time-words.js';
import { looksLikeAppend, looksLikeExplicitAppend } from './append.js';
import type { Segment } from './router.service.js';

/**
 * Мысль, приклеенная к правке (серия голосовых 18.09.2026, голос 10).
 *
 * «Во вторник отвести дочку к врачу, хотя нет к врачу лучше в пятницу
 * ещё оплатить садик до 20 купить подарок сестре» — без точек модель
 * маршрутизатора отдала правкой всё до точки. Резолвер увидел в одной
 * «правке» три дела и сказал «новая мысль»: садик и подарок код спас как
 * поздние мысли, а перенос врача пропал. Промпт не трогаем.
 *
 * Правило то же, что после вопроса о дне (`day-question.ts`): «ещё» с
 * повелением за ним — начало следующей мысли. Только у правки, и не у
 * дополнения — «к банку добавь: ещё позвонить менеджеру», «а ещё туда
 * надо взять карту прививок» (§7.4) — там «ещё …» и есть содержание.
 * И только когда то, что до «ещё», само похоже на правку: в нём слово о
 * времени («лучше в пятницу») — иначе резать нечего.
 */

/** «И ещё …» — начало следующей мысли, если после него повеление. */
const AND_MORE = /[\s,]+(?:(?:и|а)\s+)?(?:ещё|еще)\s+/giu;

/** Глагол в повелении — «оплатить», «записаться». */
const INFINITIVE = /\p{L}+(?:ть|ться|чь|чься)(?!\p{L})/u;

function splitSegment(segment: Segment): readonly Segment[] {
  if (looksLikeExplicitAppend(segment.text) || looksLikeAppend(segment.text)) return [segment];

  for (const match of segment.text.matchAll(AND_MORE)) {
    const head = segment.text.slice(0, match.index).trim();
    const tail = segment.text.slice(match.index).replace(/^[\s,]+/u, '');

    if (hasTimeWord(head) && INFINITIVE.test(tail)) {
      return [
        { intent: 'PATCH', text: head },
        { intent: 'DUMP', text: tail },
      ];
    }
  }

  return [segment];
}

export function splitPatchTails(segments: readonly Segment[]): readonly Segment[] {
  return segments.flatMap((segment) =>
    segment.intent === 'PATCH' ? splitSegment(segment) : [segment],
  );
}
