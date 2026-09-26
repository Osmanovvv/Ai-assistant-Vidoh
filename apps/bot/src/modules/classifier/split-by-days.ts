import type { ClassifiedItems } from '../ai/schemas/classifier.js';
import { sameTopicName } from '../topics/topic-key.js';
import { FUNCTION_WORDS, tokens } from './own-sentence.js';

/**
 * Одно дело, разрезанное моделью по дням, — снова одно (живой прогон
 * Никиты 27.09.2026, шаг 3).
 *
 * Точки в расшифровке ставит распознавание, а не человек: «…оплатить
 * кружок. По рисованию до среды на работе, кстати, отчет по продажам
 * сдать во вторник до обеда в субботу. У свекрови день рождения…». Модель
 * поверила точкам и из одного «отчет по продажам сдать» сделала три дела
 * — по одному на каждое слово дня: «Сдать отчёт по рисованию на работе до
 * среды», «Сдать отчёт по продажам во вторник до обеда», «В субботу сдать
 * отчёт по продажам». Кружок остался без «до среды», подарок свекрови —
 * без «в субботу».
 *
 * **Признаки куска, и каждый проверяется.** Дела одной выгрузки с одним
 * глаголом держатся за один предмет, а в речи этот предмет сказан меньше
 * раз, чем дел за него держится («отчет» — один раз, дел — три). И дни у
 * них разные: список без дней или с одним днём на всех («сдать анализы
 * крови и мочи») — законное дробление, его правило не трогает. Разные
 * глаголы при общем имени («Отвести Машу», «Купить подарки Маше») — тоже
 * разные дела.
 *
 * **Остаётся то, что дословнее совпадает с речью** — самая длинная цепочка
 * слов подряд: «…во вторник до обеда» против «по рисованию». Поровну —
 * первое.
 *
 * **День убранного куска не пропадает, но и не угадывается.** Он уходит
 * делу без срока, чьё слово, сказанное в речи один раз, стоит к нему
 * вплотную — не дальше трёх слов, даже через точку распознавания, и без
 * чужих слов между: «оплатить **кружок** по рисованию **до среды**»,
 * «**в субботу** у **свекрови**». Такое дело должно быть одно; двое рядом
 * или никого — день пропадает вместе с куском. Дату считает дальше
 * обычная проверка срока по цитате (`resolveDeadline`), как у любого дела.
 */

type RawItem = ClassifiedItems['items'][number];

export interface Rejoined {
  readonly items: readonly RawItem[];
  /** Слова единиц извлечения — тем же порядком; не сошлись по числу — нет. */
  readonly said: readonly string[] | undefined;
  /** Сколько записей оказались кусками чужого дела и убраны. */
  readonly merged: number;
  /** Сколько обозначений дня отдано соседу без срока. */
  readonly moved: number;
}

/** Глагол дела — первое слово в неопределённой форме: «сдать», «отвести». */
const INFINITIVE = /(?:ть|ти|чь)(?:ся|сь)?$/u;

/** Как далеко от слова дела может стоять отданный ему день. */
const NEAR = 3;

function verbOf(words: readonly string[]): string | undefined {
  return words.find((word) => word.length >= 4 && INFINITIVE.test(word));
}

function significant(word: string): boolean {
  return word.length >= 4 && !FUNCTION_WORDS.has(word) && !/^\d+$/u.test(word);
}

/** Предметы дела: значимые слова без глагола и без слов своего дня. */
function objectsOf(item: RawItem, verb: string): readonly string[] {
  const day = new Set(tokens(item.deadlineText));
  return tokens(item.text).filter((word) => word !== verb && significant(word) && !day.has(word));
}

/** Где в речи звучит слово в любой своей форме. */
function placesOf(word: string, speech: readonly string[]): readonly number[] {
  return speech.flatMap((one, at) => (sameTopicName(one, word) ? [at] : []));
}

/** Самая длинная цепочка слов дела, сказанная подряд. */
function longestRun(item: readonly string[], speech: readonly string[]): number {
  let best = 0;
  for (let from = 0; from < item.length; from++) {
    for (let at = 0; at < speech.length; at++) {
      let length = 0;
      while (
        from + length < item.length &&
        at + length < speech.length &&
        item[from + length] === speech[at + length]
      ) {
        length++;
      }
      best = Math.max(best, length);
    }
  }
  return best;
}

function hasDay(item: RawItem): boolean {
  return item.deadlineText.trim() !== '' || item.deadline.trim() !== '';
}

export function rejoinSplitByDays(
  items: readonly RawItem[],
  said: readonly string[] | undefined,
  speech: string | undefined,
): Rejoined {
  const aligned = said?.length === items.length ? said : undefined;
  if (speech === undefined) return { items, said: aligned, merged: 0, moved: 0 };

  const heard = tokens(speech);

  const tasks = items.flatMap((item, index) => {
    if (item.type !== 'TASK') return [];
    const verb = verbOf(tokens(item.text));
    return verb === undefined ? [] : [{ index, verb, objects: objectsOf(item, verb) }];
  });

  // Куски одного дела — через общий предмет, сказанный реже, чем держится.
  const root = items.map((_, index) => index);
  const find = (index: number): number => {
    const up = root[index] ?? index;
    return up === index ? index : find(up);
  };
  for (const task of tasks) {
    for (const word of task.objects) {
      const times = placesOf(word, heard).length;
      // Слова в речи нет — модель его придумала, свидетельства нет.
      if (times === 0) continue;
      const holders = tasks.filter(
        (other) =>
          other.verb === task.verb && other.objects.some((one) => sameTopicName(one, word)),
      );
      if (holders.length <= times) continue;
      for (const holder of holders) root[find(holder.index)] = find(task.index);
    }
  }

  const groups = new Map<number, number[]>();
  for (const task of tasks) {
    const group = groups.get(find(task.index)) ?? [];
    group.push(task.index);
    groups.set(find(task.index), group);
  }

  const dropped = new Set<number>();
  const loose: { readonly from: RawItem; readonly winner: RawItem }[] = [];

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const members = group.map((index) => items[index]).filter((one) => one !== undefined);
    const days = new Set(
      members.map((one) => one.deadlineText.trim().toLowerCase()).filter((day) => day !== ''),
    );
    // Без дней или с одним днём на всех — законный список, не куски.
    if (days.size < 2) continue;

    const scored = group.map((index) => ({
      index,
      run: longestRun(tokens(items[index]?.text ?? ''), heard),
    }));
    const best = scored.reduce((top, one) => (one.run > top.run ? one : top));
    const winner = items[best.index];
    if (winner === undefined) continue;

    for (const { index } of scored) {
      if (index === best.index) continue;
      dropped.add(index);
      const piece = items[index];
      if (piece !== undefined) loose.push({ from: piece, winner });
    }
  }

  if (dropped.size === 0) return { items, said: aligned, merged: 0, moved: 0 };

  const next = [...items];
  const given = new Set<number>();
  let moved = 0;

  const kept = items.flatMap((item, index) => (dropped.has(index) ? [] : [{ item, index }]));
  const wordsOf = (item: RawItem): readonly string[] => tokens(item.text).filter(significant);

  for (const { from, winner } of loose) {
    const day = from.deadlineText.trim();
    if (day === '' || day.toLowerCase() === winner.deadlineText.trim().toLowerCase()) continue;

    const phrase = tokens(day);
    const starts = heard.flatMap((_, at) =>
      phrase.every((word, offset) => heard[at + offset] === word) ? [at] : [],
    );
    const start = starts[0];
    if (starts.length !== 1 || start === undefined) continue;
    const end = start + phrase.length - 1;

    const near = kept.filter(({ item, index }) => {
      if (item.type !== 'TASK' || hasDay(next[index] ?? item) || given.has(index)) return false;

      const others = kept
        .filter((other) => other.index !== index)
        .flatMap((other) => wordsOf(other.item));
      const clearBetween = (from: number, to: number): boolean =>
        heard
          .slice(from + 1, to)
          .every((word) => !others.some((other) => sameTopicName(other, word)));

      return wordsOf(item).some((word) => {
        const places = placesOf(word, heard);
        const at = places[0];
        if (places.length !== 1 || at === undefined) return false;
        if (at < start) return start - at <= NEAR && clearBetween(at, start);
        if (at > end) return at - end <= NEAR && clearBetween(end, at);
        return false;
      });
    });

    const only = near[0];
    if (near.length !== 1 || only === undefined) continue;

    next[only.index] = {
      ...only.item,
      deadline: from.deadline,
      deadlineAccuracy: from.deadlineAccuracy,
      deadlineText: from.deadlineText,
    };
    given.add(only.index);
    moved++;
  }

  return {
    items: next.filter((_, index) => !dropped.has(index)),
    said: aligned?.filter((_, index) => !dropped.has(index)),
    merged: dropped.size,
    moved,
  };
}
