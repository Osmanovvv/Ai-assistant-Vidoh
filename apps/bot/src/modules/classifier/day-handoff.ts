import type { ClassifiedItems } from '../ai/schemas/classifier.js';
import { namesDay, ownSentences, sentencesOf, tokens } from './own-sentence.js';

/**
 * День в конце предложения — следующему делу (стенд 27.09.2026,
 * voice-27-08).
 *
 * «…и позвонить в банк по кредиту в пятницу в субботу. День рождения у
 * Иры, подарок еще не купила.» — распознавание поставило точку после
 * второго дня, а не между днями. Модель отдала банку «в пятницу **или** в
 * субботу» — «или» она придумала, — и подарок остался без срока.
 *
 * **Условия, все обязательны:**
 *
 * 1. цитата дня у дела — два дня через «или», а в речи «или» между ними
 *    нет: предложение кончается этими двумя днями подряд;
 * 2. слова самого дела стоят в этом предложении;
 * 3. в следующем предложении своего дня нет;
 * 4. в нём дословно сказано ровно одно дело без срока.
 *
 * Тогда второй день — этому делу, у первого остаётся первый, а
 * придуманное «или …» уходит из его названия. Сказал «или» человек сам —
 * выбор его, правило молчит. Дату второго дня считает обычная проверка
 * срока по цитате (`resolveDeadline`): цитата дословно есть в речи.
 */

type RawItem = ClassifiedItems['items'][number];

export interface HandedOff {
  readonly items: readonly RawItem[];
  readonly said: readonly string[] | undefined;
  /** Сколько дней отдано следующему делу. */
  readonly moved: number;
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function hasDay(item: RawItem): boolean {
  return item.deadlineText.trim() !== '' || item.deadline.trim() !== '';
}

export function handOffTrailingDay(
  items: readonly RawItem[],
  said: readonly string[] | undefined,
  speech: string | undefined,
): HandedOff {
  const aligned = said?.length === items.length ? said : undefined;
  if (speech === undefined) return { items, said: aligned, moved: 0 };

  const sentences = sentencesOf(speech);
  const next = [...items];
  const nextSaid = aligned === undefined ? undefined : [...aligned];
  let moved = 0;

  for (const [index, item] of items.entries()) {
    if (item.type !== 'TASK') continue;

    const parts = item.deadlineText.split(/\s+или\s+/iu).map((part) => part.trim());
    const [first, second] = parts;
    if (parts.length !== 2 || first === undefined || second === undefined) continue;
    if (!namesDay(first) || !namesDay(second)) continue;

    // 1. Предложение кончается двумя днями подряд — без «или».
    const pair = [...tokens(first), ...tokens(second)];
    const at = sentences.findIndex((sentence) => {
      const words = tokens(sentence);
      const tail = words.slice(words.length - pair.length);
      return tail.length === pair.length && pair.every((word, offset) => tail[offset] === word);
    });
    const own = sentences[at];
    const following = sentences[at + 1];
    if (own === undefined || following === undefined) continue;

    // 2. Слова дела — в этом предложении.
    if (!ownSentences(item.text, speech).includes(own)) continue;

    // 3. У следующего предложения своего дня нет.
    if (namesDay(following)) continue;

    // 4. Ровно одно дело без срока сказано в следующем предложении.
    const takers = items.flatMap((other, other_index) =>
      other_index !== index &&
      other.type === 'TASK' &&
      !hasDay(next[other_index] ?? other) &&
      ownSentences(other.text, speech).includes(following)
        ? [other_index]
        : [],
    );
    const taker = takers[0];
    if (takers.length !== 1 || taker === undefined) continue;

    const invented = new RegExp(`\\s+или\\s+${escaped(second)}`, 'iu');
    next[taker] = {
      ...(next[taker] ?? item),
      deadline: item.deadline,
      deadlineAccuracy: 'day',
      deadlineText: second,
    };
    next[index] = { ...item, deadlineText: first, text: item.text.replace(invented, '') };
    if (nextSaid !== undefined) nextSaid[index] = (nextSaid[index] ?? '').replace(invented, '');
    moved++;
  }

  return { items: next, said: nextSaid, moved };
}
