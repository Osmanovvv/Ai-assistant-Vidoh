import { localMinutes } from '../classifier/clock-time.js';
import type { TextProfile } from '../../texts/index.js';
import { picturesIn } from '../../texts/rules.js';

/**
 * Приветствие — ответ сразу, фразой из словаря (Никита, 29.09.2026).
 *
 * ТЗ §7.1 прямо: «Приветствие, благодарность, реплика без содержания —
 * короткий ответ, без обращения к тяжёлым моделям»; §18 — первый отклик
 * практически мгновенный. «Привет» же шёл общим путём: полминуты тишины,
 * маршрутизатор, ответчик по делам и живой ответ — 33 секунды и 3,5–5 ₽
 * (бой 28–29.09.2026). Теперь — как «спасибо» (`thanks.ts`): сразу и без
 * модели.
 *
 * Правило, а не догадка: список закрытый, слово либо есть, либо нет. Всё
 * сверх приветствия — «Привет, купи хлеб», «Привет, как дела?» — уходит в
 * разбор, как раньше.
 */

/** Приветствия, от длинных к коротким: «салам алейкум» раньше «салам». */
const PHRASES: readonly (readonly string[])[] = [
  ['ас', 'саламу', 'алейкум'],
  ['ва', 'алейкум', 'ассалам'],
  ['ассаламу', 'алейкум'],
  ['ассалам', 'алейкум'],
  ['салам', 'алейкум'],
  ['салям', 'алейкум'],
  ['доброе', 'утро'],
  ['доброго', 'утра'],
  ['добрый', 'день'],
  ['доброго', 'дня'],
  ['добрый', 'вечер'],
  ['доброго', 'вечера'],
  ['привет'],
  ['приветик'],
  ['приветики'],
  ['приветствую'],
  ['здравствуй'],
  ['здравствуйте'],
  ['здрасте'],
  ['здрасьте'],
  ['салют'],
  ['салам'],
  ['салям'],
  ['хай'],
  ['хелло'],
  ['хеллоу'],
  ['hi'],
  ['hello'],
];

/**
 * Что может стоять рядом с приветствием, не делая его чем-то ещё:
 * обращение и связки — «И тебе привет», «Привет ещё раз», «Здравствуй,
 * Выдох». «Доброй ночи» и «спокойной ночи» сюда не входят: так прощаются.
 */
const AROUND = new Set([
  'выдох',
  'ну',
  'ой',
  'эй',
  'и',
  'тебе',
  'вам',
  'всем',
  'еще',
  'раз',
  'снова',
]);

/** Знаки, с которыми здороваются; 🙂 один — это «ок», его ведёт `onlyAck`. */
const PICTURES: ReadonlySet<string> = new Set(['👋', '🤗', '🙂', '😊', '😌', '🙌', '✋']);
const WAVES: ReadonlySet<string> = new Set(['👋', '🤗', '✋']);

const withoutSkinTone = (picture: string): string => picture.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');

interface Word {
  readonly word: string;
  readonly end: number;
}

function wordsOf(text: string): readonly Word[] {
  return [...text.matchAll(/\p{L}+/gu)].map((match) => ({
    word: match[0].toLowerCase().replace(/ё/gu, 'е'),
    end: match.index + match[0].length,
  }));
}

function phraseAt(words: readonly Word[], at: number): number {
  const found = PHRASES.find((phrase) =>
    phrase.every((part, offset) => words[at + offset]?.word === part),
  );
  return found?.length ?? 0;
}

/**
 * Сколько слов с начала — приветствие со связками, и было ли в них само
 * приветствие.
 */
function greetingRun(words: readonly Word[]): {
  readonly length: number;
  readonly greeted: boolean;
} {
  let at = 0;
  let greeted = false;
  while (at < words.length) {
    const phrase = phraseAt(words, at);
    if (phrase > 0) {
      greeted = true;
      at += phrase;
    } else if (AROUND.has(words[at]?.word ?? '')) {
      at += 1;
    } else {
      break;
    }
  }
  return { length: at, greeted };
}

/** Сообщение — одно приветствие, и ничего сверх него. */
export function onlyGreeting(text: string | undefined): boolean {
  if (text === undefined || text.trim() === '' || text.includes('?')) return false;

  const pictures = picturesIn(text).map(withoutSkinTone);
  if (!pictures.every((picture) => PICTURES.has(picture))) return false;

  const words = wordsOf(text);
  if (words.length === 0) return pictures.some((picture) => WAVES.has(picture));

  const run = greetingRun(words);
  return run.greeted && run.length === words.length;
}

/**
 * То, что сказано после приветствия: «Привет, я Оля» → «я Оля». Ответ на
 * «Как тебя звать?» часто начинается с «привет» — именем оно не становится.
 */
export function withoutGreeting(text: string): string {
  const words = wordsOf(text);
  const run = greetingRun(words);
  if (!run.greeted) return text.trim();

  const end = run.length === 0 ? 0 : (words[run.length - 1]?.end ?? 0);
  return text
    .slice(end)
    .replace(/^[\s,.!;:)\-—–👋🤗🙂😊😌🙌✋]+/u, '')
    .trim();
}

export type DayPart = 'morning' | 'day' | 'evening' | 'night';

/** Часть суток по часам человека: утро 5–12, день 12–18, вечер 18–23, ночь. */
export function dayPartAt(now: Date, timeZone: string): DayPart {
  const hour = Math.floor(localMinutes(now, timeZone) / 60);
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'day';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'night';
}

/** «Добрый день 🙂» — по часам человека, из словаря. */
export function salutationAt(texts: TextProfile, now: Date, timeZone: string): string {
  const part = dayPartAt(now, timeZone);
  if (part === 'morning') return texts.answer.greetingMorning;
  if (part === 'day') return texts.answer.greetingDay;
  if (part === 'evening') return texts.answer.greetingEvening;
  return texts.answer.greetingNight;
}

/** Ответ на приветствие: «Добрый день 🙂 Расскажешь, что в голове?». */
export function greetingLine(texts: TextProfile, now: Date, timeZone: string): string {
  return `${salutationAt(texts, now, timeZone)} ${texts.answer.greetingInvite}`;
}
