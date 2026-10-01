import type { ClassifiedItems } from '../ai/schemas/classifier.js';
import { isStrictInfinitive } from './split-actions.js';

type RawItem = ClassifiedItems['items'][number];

export interface Attached {
  readonly items: readonly RawItem[];
  /** Слова единиц извлечения — тем же порядком; не сошлись по числу — нет. */
  readonly said: readonly string[] | undefined;
  /** Сколько хвостов приклеено к целям. */
  readonly attached: number;
}

/**
 * Хвост перечисления — к большой цели (заказчица, 30.09.2026).
 *
 * Её голосовое распознало так: «…разобраться с днем рождения ребенка,
 * место гости торт. Украшения ведущей?» Точку и вопрос поставил SpeechKit,
 * и «Украшения ведущей» стало отдельной идеей, хотя это продолжение
 * перечисления частей цели.
 *
 * Приклеивается, только если всё сразу:
 * - перед хвостом — большая цель, и хвост из той же сферы;
 * - хвост — не дело и не чувство: без глагола в неопределённой форме,
 *   без срока и повтора, без слов предложения («мне», «надо»);
 * - хвост короткий: до трёх слов на часть, до шести всего, без цифр;
 * - это правда перечисление: у цели в конце уже есть части через запятую,
 *   или сам хвост — две части и больше.
 *
 * Иначе — как было: отдельная запись. Лишняя запись видна и убирается
 * одной кнопкой, а чужая мысль, приклеенная к цели, пропала бы из вида.
 */
export function attachListTails(
  items: readonly RawItem[],
  said: readonly string[] | undefined,
): Attached {
  const aligned = said?.length === items.length ? said : undefined;
  const outItems: RawItem[] = [];
  const outSaid: string[] = [];
  let attached = 0;

  for (const [index, item] of items.entries()) {
    const last = outItems.length - 1;
    const goal = outItems[last];
    const parts = goal === undefined ? undefined : tailParts(goal, item);

    if (goal !== undefined && parts !== undefined) {
      outItems[last] = { ...goal, text: `${withoutEnd(goal.text)}, ${parts}` };
      outSaid[last] = `${outSaid[last] ?? ''} ${aligned?.[index] ?? ''}`.trim();
      attached++;
      continue;
    }

    outItems.push(item);
    outSaid.push(aligned?.[index] ?? '');
  }

  return { items: outItems, said: aligned === undefined ? undefined : outSaid, attached };
}

/** Хвост как части цели — или ничего, если это не хвост её перечисления. */
function tailParts(goal: RawItem, tail: RawItem): string | undefined {
  if (!goal.isProject || (goal.type !== 'TASK' && goal.type !== 'DESIRE')) return undefined;
  if (tail.isProject || tail.type === 'EMOTION') return undefined;
  if (tail.topic.trim().toLowerCase() !== goal.topic.trim().toLowerCase()) return undefined;
  if (tail.deadlineAccuracy !== 'none' || tail.deadlineText.trim() !== '') return undefined;
  if (tail.recurrenceKind !== 'none') return undefined;

  const text = withoutEnd(tail.text);
  const chunks = listChunks(text);
  if (chunks === undefined) return undefined;
  if (chunks.flat().length > MAX_TAIL_WORDS) return undefined;

  // Перечисление: части у цели уже есть — или хвост сам из нескольких.
  const goalChunks = listChunks(goal.text.split(',').slice(1).join(','));
  const listing = (goalChunks !== undefined && goalChunks.length >= 2) || chunks.length >= 2;
  if (!listing) return undefined;

  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** До трёх слов на часть: «украшения ведущей», «торт». */
const MAX_PART_WORDS = 3;
const MAX_TAIL_WORDS = 6;

/** Слова предложения, а не перечисления: с ними хвост — уже мысль. */
const SENTENCE_WORDS = new Set([
  'я',
  'мне',
  'меня',
  'мы',
  'нам',
  'нас',
  'ты',
  'тебе',
  'он',
  'она',
  'они',
  'надо',
  'нужно',
  'нужен',
  'нужна',
  'хочу',
  'хочется',
  'можно',
  'может',
  'не',
  'нет',
  'да',
  'ну',
  'это',
  'вот',
  'там',
  'тут',
  'где',
  'когда',
  'как',
  'что',
  'почему',
  'зачем',
  'ли',
  'уже',
  'очень',
]);

/**
 * Прошедшее время — это уже мысль, а не часть: «подарок купила» (стенд
 * 01.10.2026). От пяти букв: «пила», «мыло» — не глаголы. Ошибка в
 * сторону «не часть» безопасна: перечисление остаётся как было.
 */
const PAST_TENSE = /(?:ла|ли|ло|лся|лась|лись|лось)$/u;

/**
 * Части перечисления словами — или ничего, если это не перечисление:
 * пустая часть, длинная часть, цифры, глагол или слово предложения.
 * Общая для хвоста цели и для короткого названия (`project-title.ts`).
 */
export function listChunks(text: string): (readonly string[])[] | undefined {
  const chunks = text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .split(/\s*,\s*|\s+и\s+/u)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => chunk.split(/\s+/u));
  if (chunks.length === 0) return undefined;

  for (const chunk of chunks) {
    if (chunk.length > MAX_PART_WORDS) return undefined;
    for (const word of chunk) {
      if (!/^\p{L}+(?:-\p{L}+)?$/u.test(word)) return undefined;
      if (SENTENCE_WORDS.has(word) || isStrictInfinitive(word)) return undefined;
      if (word.length >= 5 && PAST_TENSE.test(word)) return undefined;
    }
  }

  return chunks;
}

function withoutEnd(text: string): string {
  return text.trim().replace(/[\s.!?…,;:]+$/u, '');
}
