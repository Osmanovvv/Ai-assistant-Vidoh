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

export interface ShortenedWordsRestored {
  readonly units: readonly ExtractedUnit[];
  /** Сколько предметных слов вернули к полной форме из речи. */
  readonly restored: number;
}

/**
 * Убирает только явно выдуманную единицу из короткого списка.
 *
 * Иногда модель при одном предложении «заказать A и B» возвращает
 * «заказать A», «заказать новинку», «заказать B». Восстановление длинных
 * слов чинит A, но не может доказать, что «новинку» модель придумала. Здесь
 * удаляем такую единицу лишь когда все предметы исходной фразы уже покрыты
 * другими единицами и в исходнике нет второго предложения с тем же глаголом.
 * Поэтому обычные переформулировки и независимые дела не затрагиваются.
 */
export function removeUnsupportedUnits(
  input: string,
  units: readonly ExtractedUnit[],
): { readonly units: readonly ExtractedUnit[]; readonly removed: number } {
  const sentences = sentencesOf(input);
  const current = [...units];
  let removed = 0;

  for (const sentence of sentences) {
    const verb = openingAction(sentence);
    if (verb === undefined) continue;
    if (sentences.filter((one) => openingAction(one) === verb).length !== 1) continue;

    const sourceWords = wordsOf(sentence);
    const objects = objectsOf(sourceWords, verb).filter(
      (word) => word.length >= 4 && !REFUSAL.has(word),
    );
    if (objects.length < 2) continue;

    const hasObject = (unit: ExtractedUnit): boolean => {
      const theirs = wordsOf(unit.text);
      return objects.some((object) => theirs.some((word) => sameWord(word, object)));
    };
    if (
      !objects.every((object) =>
        current.some((unit) => wordsOf(unit.text).some((word) => sameWord(word, object))),
      )
    ) {
      continue;
    }

    const next = current.filter((unit) => {
      if (unit.isProject || unit.isEmotion) return true;
      const hasVerb = wordsOf(unit.text).some((word) => sameWord(word, verb));
      if (!hasVerb || hasObject(unit)) return true;
      removed++;
      return false;
    });
    current.splice(0, current.length, ...next);
  }

  return { units: removed === 0 ? units : current, removed };
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

interface WordToken {
  readonly raw: string;
  readonly normalized: string;
  readonly start: number;
  readonly end: number;
}

function tokensOf(text: string): readonly WordToken[] {
  const tokens: WordToken[] = [];
  const pattern = /[\p{L}\p{N}]+/gu;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const start = match.index;
    tokens.push({
      raw,
      normalized: raw.toLowerCase().replace(/ё/gu, 'е'),
      start,
      end: start + raw.length,
    });
  }
  return tokens;
}

function normalizedWord(text: string): string {
  return text.toLowerCase().replace(/ё/gu, 'е');
}

function replaceToken(text: string, token: WordToken, replacement: string): string {
  return `${text.slice(0, token.start)}${replacement}${text.slice(token.end)}`;
}

/**
 * Восстанавливает укороченные предметные слова в одной записи по исходной
 * единице. Возвращает исходный кандидат, если уверенного совпадения нет.
 */
export function restoreShortenedText(
  sourceText: string,
  candidateText: string,
): { readonly text: string; readonly restored: number } {
  const verb = openingAction(sourceText);
  if (verb === undefined) return { text: candidateText, restored: 0 };

  const sourceTokens = tokensOf(sourceText);
  const sourceWords = sourceTokens.map((token) => normalizedWord(token.raw));
  const objects = objectsOf(sourceWords, verb).filter(
    (word) => word.length >= 4 && !REFUSAL.has(word),
  );
  let text = candidateText;
  let restored = 0;

  for (const object of objects.filter((word) => word.length >= 8)) {
    const currentTokens = tokensOf(text);
    if (currentTokens.some((token) => token.normalized === object)) continue;

    const prefixes = currentTokens.filter(
      (token) =>
        token.normalized.length >= 4 &&
        object.startsWith(token.normalized) &&
        object.length - token.normalized.length >= 4,
    );
    if (prefixes.length !== 1) continue;

    const source = sourceTokens.find((token) => normalizedWord(token.raw) === object);
    const prefix = prefixes[0];
    if (source === undefined || prefix === undefined) continue;
    text = replaceToken(text, prefix, source.raw);
    restored++;
  }

  const finalTokens = tokensOf(text);
  const uncovered = objects.filter(
    (object) => !finalTokens.some((token) => sameWord(token.normalized, object)),
  );
  if (uncovered.length > 0) {
    // Классификация не имеет права выбрасывать часть единицы. Если после
    // точечной замены всё ещё не хватает предмета, сохраняем всю исходную
    // формулировку; дальнейшая чистка заголовка уберёт только служебный срок.
    return { text: deedText(sourceText), restored: restored + uncovered.length };
  }

  return { text, restored };
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

/**
 * Возвращает предметное слово, которое модель укоротила до общего начала.
 *
 * `sameWord` намеренно допускает общий префикс для падежей и форм глагола.
 * Для контроля потерь этого недостаточно: «чеснок» и «чеснокодавилку» тоже
 * считаются одним словом, хотя вторая половина названия — смысл покупки.
 * Поэтому здесь отдельное, более узкое правило: исправляем только длинное
 * слово, от которого в записи остался короткий префикс с разницей минимум
 * в четыре буквы. Обычные окончания («молока»/«молоко») не затрагиваются.
 */
export function restoreShortenedWords(
  input: string,
  units: readonly ExtractedUnit[],
): ShortenedWordsRestored {
  const current = units.map((unit) => ({ ...unit }));
  let restored = 0;

  for (const sentence of sentencesOf(input)) {
    const verb = openingAction(sentence);
    if (verb === undefined) continue;

    const sourceTokens = tokensOf(sentence);
    const sourceWords = sourceTokens.map((token) => normalizedWord(token.raw));
    const objects = objectsOf(sourceWords, verb).filter(
      (word) => word.length >= 8 && !REFUSAL.has(word),
    );

    const actionCandidates = current
      .map((unit, index) => ({ unit, index }))
      .filter(({ unit }) => tokensOf(unit.text).some((token) => sameWord(token.normalized, verb)));
    if (actionCandidates.length === 1) {
      const candidate = actionCandidates[0];
      if (candidate !== undefined) {
        const repaired = restoreShortenedText(sentence, candidate.unit.text);
        if (repaired.restored > 0) {
          current[candidate.index] = { ...candidate.unit, text: repaired.text };
          restored += repaired.restored;
          continue;
        }
      }
    }

    for (const object of objects) {
      if (
        current.some((unit) => tokensOf(unit.text).some((token) => token.normalized === object))
      ) {
        continue;
      }

      const candidates: { readonly index: number; readonly token: WordToken }[] = [];
      for (const [index, unit] of current.entries()) {
        const unitTokens = tokensOf(unit.text);
        const hasAction = unitTokens.some((token) => sameWord(token.normalized, verb));
        if (!hasAction) continue;

        const prefixes = unitTokens.filter(
          (token) =>
            token.normalized.length >= 4 &&
            object.startsWith(token.normalized) &&
            object.length - token.normalized.length >= 4,
        );
        const [prefix] = prefixes;
        if (prefix !== undefined) candidates.push({ index, token: prefix });
      }

      // Если подходящих записей несколько, не угадываем, к какой относится
      // слово: сохранённая короткая форма безопаснее автоматической замены.
      if (candidates.length !== 1) continue;

      const candidate = candidates[0];
      if (candidate === undefined) continue;
      const source = sourceTokens.find((token) => normalizedWord(token.raw) === object);
      if (source === undefined) continue;

      const unit = current[candidate.index];
      if (unit === undefined) continue;
      current[candidate.index] = {
        ...unit,
        text: replaceToken(unit.text, candidate.token, source.raw),
      };
      restored++;
    }
  }

  return { units: restored === 0 ? units : current, restored };
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
