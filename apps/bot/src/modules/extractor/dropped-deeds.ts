import { FUNCTION_WORDS, namesDay } from '../classifier/own-sentence.js';
import { sameWord } from '../resolver/clarify.js';
import { openingAction } from '../router/thought-words.js';
import type { ExtractedUnit } from './extractor.service.js';

/**
 * Дело, выпавшее из извлечения, — обратно (заказчица, 30.09.2026).
 *
 * Её голосовое: «…Мне нужно заказать шампунь. Сходить на Вайлдберриз? Что
 * то я так устала…». Маршрутизатор отдал кусок целиком, а извлечение
 * вернуло шесть единиц из семи: «Сходить на Вайлдберриз?» выпало молча.
 * Повтор той же модели на том же тексте его сохранил — это разброс, и
 * лечить его просьбой в промпте нельзя: страж нужен в коде, как у
 * маршрутизатора (`coverage.ts`).
 *
 * Правило узкое, по закрытому списку: предложение, которое **начинается
 * с глагола дела** («сходить», «купить», «позвонить» — `thought-words.ts`),
 * должно найтись хотя бы в одной единице — по предмету («вайлдберриз»), а
 * без предмета по глаголу. Не нашлось — дело возвращается словами
 * человека, на своё место.
 *
 * Не возвращается то, от чего человек отказался: «не», «уже», «передумала»
 * в самом предложении или «Нет, не надо» следом. Цена ложного срабатывания
 * — лишняя запись, видная и убираемая одной кнопкой; цена пропуска — дело,
 * о котором человек не узнает, пока не будет поздно.
 */

export interface Restored {
  readonly units: readonly ExtractedUnit[];
  /** Сколько дел вернул код. Ненулевое — извлечение теряет, смотреть журнал. */
  readonly restored: number;
}

/** Связки в начале предложения — не часть дела. */
const CONNECTIVE =
  /^(?:(?:и|а|но|ещё|еще|так|потом|вот|ну|короче|значит|кстати|также|тоже)(?=[\s,]|$)[\s,]*)+/iu;

/** Отказ в самом предложении. */
const REFUSAL = new Set(['не', 'нет', 'уже', 'передумала', 'передумал', 'отмена', 'отбой']);

/** Отказ следующим предложением: «Нет, не надо», «Хотя нет…». */
const TAKEN_BACK =
  /^(?:нет|хотя\s+нет|не\s+надо|не\s+нужно|отбой|передумала|передумал)(?=$|[^\p{L}])/iu;

function wordsOf(text: string): readonly string[] {
  return text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

function sentencesOf(input: string): readonly string[] {
  return input
    .split(/\n+|(?<=[.!?…])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** Предмет дела: слова, кроме глагола, связок, служебных и дней. */
function objectsOf(words: readonly string[], verb: string): readonly string[] {
  return words.filter(
    (word) =>
      word !== verb &&
      word.length >= 3 &&
      !FUNCTION_WORDS.has(word) &&
      !namesDay(word) &&
      !/^\d+$/u.test(word),
  );
}

/** Слова единицы, по которым её место в речи узнаётся. */
function anchorWords(text: string): readonly string[] {
  return wordsOf(text).filter((word) => word.length >= 4 && !FUNCTION_WORDS.has(word));
}

/** Текст дела словами человека: без связок в начале и знаков в конце, с заглавной. */
function deedText(sentence: string): string {
  const bare = sentence
    .replace(CONNECTIVE, '')
    .replace(/[\s.!?…,;:]+$/u, '')
    .trim();
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

export function restoreDroppedDeeds(input: string, units: readonly ExtractedUnit[]): Restored {
  const sentences = sentencesOf(input);
  const sentenceWords = sentences.map(wordsOf);

  // Где в речи каждая единица: первое предложение с её словом.
  const placed: { unit: ExtractedUnit; at: number }[] = units.map((unit) => {
    const own = anchorWords(unit.text);
    const at = sentenceWords.findIndex((words) =>
      words.some((word) => own.some((mine) => sameWord(word, mine))),
    );
    return { unit, at: at < 0 ? Number.NaN : at };
  });

  let restored = 0;

  for (const [index, sentence] of sentences.entries()) {
    const verb = openingAction(sentence);
    if (verb === undefined) continue;

    const words = sentenceWords[index] ?? [];
    if (words.some((word) => REFUSAL.has(word))) continue;
    if (TAKEN_BACK.test(sentences[index + 1] ?? '')) continue;

    const objects = objectsOf(words, verb);
    const covered = placed.some(({ unit }) => {
      const theirs = wordsOf(unit.text);
      return objects.length === 0
        ? theirs.some((word) => sameWord(word, verb))
        : objects.some((object) => theirs.some((word) => sameWord(word, object)));
    });
    if (covered) continue;

    const text = deedText(sentence);
    if (text === '') continue;

    // На своё место: после последней единицы, чьё предложение раньше.
    let after = -1;
    for (const [position, one] of placed.entries()) {
      if (one.at < index) after = position;
    }
    placed.splice(after + 1, 0, {
      unit: { text, isProject: false, isEmotion: false },
      at: index,
    });
    restored++;
  }

  return { units: restored === 0 ? units : placed.map(({ unit }) => unit), restored };
}
