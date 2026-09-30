import type { Item } from '../../db/schema.js';
import type { TextProfile } from '../../texts/types.js';
import { FUNCTION_WORDS, namesDay } from '../classifier/own-sentence.js';
import { isStrictInfinitive } from '../classifier/split-actions.js';
import { isPersonWord } from '../presenter/context-line.js';
import type { StatusButton } from '../presenter/status.service.js';
import { sameWord } from '../resolver/clarify.js';
import { toShortId } from '../shared/short-id.js';
import { CARD_ACTION } from './card-actions.js';

/**
 * Похожее открытое дело — повод спросить (заказчица, 30.09.2026).
 *
 * «Отнести пальто в химчистку» было записано, потом «Нужна химчистка» и
 * «Сдать пальто в химчистку» легли ещё двумя делами: повтор узнаётся
 * только дословно (`same-text.ts`). Она попросила: если похожее уже есть,
 * спросить — новое это дело или то же самое.
 *
 * Близость по вектору здесь не судья: у неё настоящий дубль 0,77, а
 * посторонние дела — до 0,72. Судья — **общее предметное слово**
 * («химчистка», «пальто»). Не в счёт глаголы («купить хлеб» и «купить
 * молоко» — разные дела), родня и звери («позвонить маме» и «купить маме
 * подарок»), имена, дни и время суток. Замер на тестовом аккаунте Никиты
 * (50 дел, 01.10.2026): 15 вопросов, из них ложных два-три.
 *
 * Спрашивается, а не сливается: ложное «похоже» стоит одного нажатия, а
 * молча съеденное дело — того, о чём человек не узнает.
 */

/** Время суток и еды — не предмет: «забрать туфли вечером». */
const DAYPART = new Set([
  'утром',
  'утра',
  'днем',
  'вечером',
  'вечера',
  'ночью',
  'ночи',
  'обед',
  'обеда',
  'обеду',
  'ужин',
  'ужина',
  'завтрак',
  'завтрака',
]);

/** Какие дела сравниваются: сведения и чувства — не дела. */
const COMPARABLE: ReadonlySet<Item['type']> = new Set(['TASK', 'DESIRE', 'IDEA']);

function normalized(word: string): string {
  return word.toLowerCase().replace(/ё/gu, 'е');
}

/** Имена: слово с заглавной не первым в названии — «Маше», «Калининград». */
function namesIn(text: string): ReadonlySet<string> {
  return new Set(
    text
      .split(/\s+/u)
      .slice(1)
      .filter((word) => /^\p{Lu}\p{Ll}/u.test(word))
      .map((word) => normalized(word.replace(/[^\p{L}]/gu, ''))),
  );
}

/** Предметные слова названия. */
function subjectsOf(text: string): readonly string[] {
  const names = namesIn(text);
  return normalized(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(
      (word) =>
        word.length >= 4 &&
        !/^\d+$/u.test(word) &&
        !FUNCTION_WORDS.has(word) &&
        !DAYPART.has(word) &&
        !namesDay(word) &&
        !isStrictInfinitive(word) &&
        !isPersonWord(word) &&
        !names.has(word),
    );
}

/**
 * Открытое дело, похожее на новое, — или ничего. Из нескольких — то, где
 * общих слов больше; поровну — самое свежее.
 */
export function similarOpen(
  fresh: { readonly text: string; readonly type: Item['type'] },
  open: readonly Item[],
): Item | undefined {
  if (!COMPARABLE.has(fresh.type)) return undefined;
  const mine = subjectsOf(fresh.text);
  if (mine.length === 0) return undefined;

  let best: { item: Item; shared: number } | undefined;
  for (const item of open) {
    if (item.status !== 'new' || item.isDraft || !COMPARABLE.has(item.type)) continue;
    const theirs = subjectsOf(item.text);
    const shared = mine.filter((word) => theirs.some((own) => sameWord(word, own))).length;
    if (shared === 0) continue;
    if (
      best === undefined ||
      shared > best.shared ||
      (shared === best.shared && item.createdAt.getTime() > best.item.createdAt.getTime())
    ) {
      best = { item, shared };
    }
  }

  return best?.item;
}

/** Три кнопки вопроса: новое, то же, изменить прежнее. */
export function similarButtons(
  freshId: string,
  oldId: string,
  texts: TextProfile,
): readonly StatusButton[] {
  const fresh = toShortId(freshId);
  const old = toShortId(oldId);
  return [
    { label: texts.card.buttonSimilarNew, action: `${CARD_ACTION.similarKeep}${fresh}` },
    { label: texts.card.buttonSimilarSame, action: `${CARD_ACTION.similarSame}${fresh}:${old}` },
    { label: texts.card.buttonSimilarEdit, action: `${CARD_ACTION.similarEdit}${fresh}:${old}` },
  ];
}
