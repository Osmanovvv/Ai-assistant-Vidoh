import type { RecognizedUtterance, TranscriptionResult } from './providers/types.js';

/**
 * День после паузы — следующему делу (прогон Никиты 27.09.2026, задача 3.68).
 *
 * **Что было.** Дважды за день одно и то же: человек сказал «…надо ещё
 * подарок ей купить. [пауза] В пятницу записать Мишу к ортодонту», а
 * распознавание вернуло «…подарок ей купить в пятницу, записать Мишу к
 * Ортодонту». Точку ставит литературная нормализация Yandex, и ставит не по
 * паузам. По такому тексту «в пятницу» принадлежит подарку — и никакая
 * модель после этого не угадает иначе, а ортодонт остаётся без дня.
 *
 * **Что слышно.** Времена слов распознавание отдаёт. На обоих голосовых
 * перед днём пауза 650 и 851 мс, после — ноль: «купить ‖650‖ в пятницу
 * записать». Внутри одной мысли паузы короче («день рождения ‖490‖ купить
 * ей подарок»), между делами — 600–1400 мс.
 *
 * **Правило узкое**, из четырёх примет сразу, и только на названии дня:
 * 1. перед ним пауза не короче `PAUSE_BEFORE_MS`;
 * 2. после него речь идёт без паузы (короче `JOINED_AFTER_MS`);
 * 3. распознавание прилепило день к предыдущему — перед ним в тексте нет
 *    знака препинания;
 * 4. и отделило от следующего — сразу после дня запятая или точка.
 *
 * Тогда точка переезжает: «…купить. В пятницу записать Мишу…». Обратный
 * случай — «купить подарок в пятницу, [пауза] записать…» — не трогается:
 * там пауза после дня, а не перед ним. Сомнение (обе паузы длинные, дней
 * в словах и в тексте не поровну) — текст как есть.
 */
export const PAUSE_BEFORE_MS = 500;
export const JOINED_AFTER_MS = 250;

/** Названия дня: закрытый список, слова распознавания — строчные, без знаков. */
const DAY_PHRASES: readonly (readonly string[])[] = [
  ['в', 'понедельник'],
  ['во', 'вторник'],
  ['в', 'среду'],
  ['в', 'четверг'],
  ['в', 'пятницу'],
  ['в', 'субботу'],
  ['в', 'воскресенье'],
  ['сегодня'],
  ['завтра'],
  ['послезавтра'],
];

const plain = (word: string): string => word.toLowerCase().replace(/ё/gu, 'е');

function phraseAt(words: readonly string[], at: number): readonly string[] | undefined {
  return DAY_PHRASES.find((phrase) =>
    phrase.every((token, offset) => words[at + offset] === token),
  );
}

function phrasePattern(phrase: readonly string[]): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${phrase.join('\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
}

/** Одна фраза распознавания: точка переезжает к паузе там, где стоит день. */
export function dayAfterPause(utterance: RecognizedUtterance): RecognizedUtterance {
  const words = utterance.words.map((word) => plain(word.text));
  const moves: { readonly phrase: readonly string[]; readonly ordinal: number }[] = [];
  const seen = new Map<string, number>();

  for (let at = 0; at < words.length; at++) {
    const phrase = phraseAt(words, at);
    if (phrase === undefined) continue;

    const key = phrase.join(' ');
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);

    const previous = utterance.words[at - 1];
    const first = utterance.words[at];
    const last = utterance.words[at + phrase.length - 1];
    const next = utterance.words[at + phrase.length];
    if (previous === undefined || first === undefined || last === undefined || next === undefined) {
      continue;
    }

    const before = first.startMs - previous.endMs;
    const after = next.startMs - last.endMs;
    if (before >= PAUSE_BEFORE_MS && after < JOINED_AFTER_MS) moves.push({ phrase, ordinal });
  }

  let text = utterance.text;
  // С конца: правка позже по тексту не сдвигает то, что раньше.
  for (const move of [...moves].reverse()) {
    const found = [...text.matchAll(phrasePattern(move.phrase))];
    const inWords = seen.get(move.phrase.join(' ')) ?? 0;
    // Дней в тексте и в словах не поровну — какой из них какой, не сказать.
    if (found.length !== inWords) continue;

    const match = found[move.ordinal];
    if (match === undefined) continue;

    const start = match.index;
    const end = start + match[0].length;
    const head = text.slice(0, start).trimEnd();
    const tail = text.slice(end);

    // Условие 3: день прилеплен к предыдущему — знака перед ним нет.
    if (head === '' || !/[\p{L}\p{N}]$/u.test(head)) continue;
    // Условие 4: и отделён от следующего — знак сразу после.
    if (!/^\s*[,.;]/u.test(tail)) continue;

    const day = match[0];
    text = `${head}. ${day.charAt(0).toUpperCase()}${day.slice(1)} ${tail.replace(/^\s*[,.;]\s*/u, '')}`;
  }

  return text === utterance.text ? utterance : { text, words: utterance.words };
}

/**
 * Расшифровка целиком. Ничего не переехало — тот же объект; переехало —
 * общий текст собирается из фраз заново, как его собирает распознавание.
 */
export function withDaysAfterPauses(result: TranscriptionResult): {
  readonly result: TranscriptionResult;
  readonly moved: number;
} {
  const utterances = result.utterances;
  if (utterances === undefined || utterances.length === 0) return { result, moved: 0 };

  const heard = utterances.map(dayAfterPause);
  const moved = heard.filter((one, index) => one !== utterances[index]).length;
  if (moved === 0) return { result, moved: 0 };

  return {
    result: { ...result, utterances: heard, text: heard.map((one) => one.text).join(' ') },
    moved,
  };
}
