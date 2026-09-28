import {
  requestStructured,
  type AiClientDeps,
  type StructuredOutcome,
  type StructuredRequest,
} from '../ai/client.js';
import { READER_SCHEMA_NAME, type ReaderReading } from '../ai/schemas/index.js';
import { clockTimesIn, withoutClockPhrase } from '../classifier/clock-time.js';
import { withCapital } from '../items/item-text.js';
import { moodOf } from '../presenter/mood.js';
import type { TextProfile } from '../../texts/index.js';

import { hourClarifyTitle, notADeed, sameWord, titleWords, words } from './clarify.js';

/**
 * Чтение ответа на вопрос бота моделью (шаг 3 плана docs/28, 28.09.2026).
 *
 * Бот спросил — «07:00 или 19:00?», «Какое дело?», «Перенести «X»?», «Это
 * про «X» или отдельная история?», — а код по своим спискам ответа не
 * узнал: «После работы», «Утром не получится, вечером», «В 7 чего?».
 * Замер docs/eval-dialog: таких 116 из 415 фраз. Модель говорит, что
 * человек имел в виду; **решает код**:
 *
 * - выбор — только из предложенного, а свой час — только если код сам
 *   читает его в реплике;
 * - новая мысль — дословно из реплики и отдельной частью, после знака;
 * - новое дело («Вечером позвонить маме») ответом не становится: глагол
 *   дела не из названия — значит, это мысль, а не ответ;
 * - встречный вопрос — только если в реплике есть вопрос.
 *
 * Не прошло — «не прочитано», и бот ведёт себя как без модели: худший
 * случай равен прежнему. Модель не ответила — то же самое.
 */

export type ReaderQuestion =
  /** «07:00 или 19:00?» у нового дела и «11:30 или 23:30?» у переноса. */
  | { readonly kind: 'time'; readonly command: string }
  /** «Какое дело? Назови его — и сделаю.» */
  | { readonly kind: 'which'; readonly command: string }
  /** «Перенести «X»?» — да или нет. */
  | { readonly kind: 'move'; readonly title: string }
  /** «Это про «X» или отдельная история?» */
  | { readonly kind: 'attach'; readonly title: string };

export type ReplyMeaning =
  | {
      readonly kind: 'answer';
      /** Доделанная команда переспроса (час, дело); у кнопок — нет. */
      readonly command?: string | undefined;
      /** «19:00», слова дела, «да»/«нет», «к прошлой»/«отдельно». */
      readonly choice: string;
      /** Новая мысль из той же реплики — в обычный разбор; нет — пусто. */
      readonly thought: string;
    }
  | { readonly kind: 'counter_question' }
  | { readonly kind: 'undecided' }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'not_answer' }
  | { readonly kind: 'unread'; readonly why: string };

const MAX_TOKENS = 200;

/** «Не знаю», «потом» — короткие; длиннее — уже своя мысль. */
const UNDECIDED_WORDS = 8;

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Два предложенных часа переспроса: утро и вечер. */
function offeredOf(command: string): readonly number[] {
  const first = clockTimesIn(command)[0];
  return first?.length === 2 ? first : [];
}

function askedText(question: ReaderQuestion, texts: TextProfile): { asked: string; kind: string } {
  if (question.kind === 'time') {
    const [morning, evening] = offeredOf(question.command).map(clock);
    const found = hourClarifyTitle(question.command);
    // В команде переспроса название со строчной; спрашивал бот — с заглавной.
    const title = found === undefined ? undefined : withCapital(found);
    const pair = `${morning ?? '?'} или ${evening ?? '?'}`;
    return {
      asked:
        title === undefined
          ? texts.resolver.timeUnclear(morning ?? '?', evening ?? '?')
          : texts.resolver.newTimeUnclear(title, morning ?? '?', evening ?? '?'),
      kind: `час (${pair})`,
    };
  }
  if (question.kind === 'which') {
    return {
      asked: texts.resolver.whichRecord,
      kind: `какое дело (переспросил на «${question.command.trim()}»)`,
    };
  }
  if (question.kind === 'move') {
    return { asked: texts.resolver.questionMove(question.title), kind: 'перенести (да или нет)' };
  }
  return {
    asked: texts.resolver.question(question.title),
    kind: 'прежнее или отдельное (к прошлой или отдельно)',
  };
}

/**
 * Встречный вопрос или двоякий ответ — бот объясняет свой вопрос другими
 * словами и ждёт дальше.
 */
export function askedAgain(
  question: { readonly kind: 'time' | 'which'; readonly command: string },
  texts: TextProfile,
): string {
  if (question.kind === 'which') return texts.resolver.whichAskedAgain;
  const [morning, evening] = offeredOf(question.command).map(clock);
  const title = hourClarifyTitle(question.command);
  return title === undefined
    ? texts.resolver.timeAskedAgainMove(morning ?? '?', evening ?? '?')
    : texts.resolver.timeAskedAgain(withCapital(title), morning ?? '?', evening ?? '?');
}

/** Вход модели: вопрос бота, вид с вариантами, что было до, реплика. */
export function readerInput(
  question: ReaderQuestion,
  texts: TextProfile,
  reply: string,
  before?: string,
): string {
  const { asked, kind } = askedText(question, texts);
  return [
    `Бот спросил: ${asked}`,
    `Вид: ${kind}`,
    ...(before === undefined || before.trim() === '' ? [] : [`До этого: ${before.trim()}`]),
    `Ответ: ${reply.trim()}`,
  ].join('\n');
}

/**
 * Глаголы дела в неопределённой форме — «позвонить», «купить», «отвезти».
 * Числа («девять», «двадцать») и слова вроде «есть», «опять», «чуть» —
 * не они. Неизвестное слово на -ть читается глаголом: ошибка здесь
 * отвергает ответ модели, то есть ведёт к поведению без неё.
 */
const NOT_VERBS = new Set([
  'есть',
  'быть',
  'мать',
  'путь',
  'часть',
  'сеть',
  'опять',
  'хоть',
  'чуть',
  'гость',
  'память',
]);
const NUMBER = /(?:пять|шесть|семь|восемь|девять|десять|дцать)$/u;
const TI_VERBS = new Set([
  'идти',
  'прийти',
  'уйти',
  'зайти',
  'найти',
  'пойти',
  'выйти',
  'дойти',
  'отвезти',
  'привезти',
  'увезти',
  'завезти',
  'отнести',
  'принести',
  'вынести',
  'помочь',
  'испечь',
  'постричь',
]);
/** Слова ответа, а не дела: «добавить к прошлой», «перенести», «оставить». */
const ANSWER_VERBS = new Set(['добавить', 'перенести', 'переносить', 'оставить', 'поставить']);

function isVerb(word: string): boolean {
  if (TI_VERBS.has(word)) return true;
  if (!/(?:ть|ться)$/u.test(word) || word.length < 4) return false;
  return !NOT_VERBS.has(word) && !NUMBER.test(word) && !ANSWER_VERBS.has(word);
}

/** Есть ли в словах ответа дело — глагол не из названия. */
function namesDeed(text: string, title: readonly string[]): boolean {
  return words(text.replace(/ё/gu, 'е')).some(
    (word) => isVerb(word) && !title.some((own) => sameWord(word, own)),
  );
}

function titleOf(question: ReaderQuestion): readonly string[] {
  if (question.kind === 'time' || question.kind === 'which') return titleWords(question.command);
  return words(question.title.replace(/ё/gu, 'е'));
}

const CONJUNCTIONS = /(?:^|\s)(?:и|а|ещё|еще|кстати|также|плюс|потом)\s*$/iu;
const BOUNDARY = /[.,;:!?—–\-\n]\s*$/u;

/**
 * Реплика без мысли — или ничего, если мысли в ней нет или она не
 * отделена от ответа знаком: «Вечером. И купить хлеб» — да, «Позвонить
 * маме вечером» — нет («вечером» — час самой мысли).
 */
function answerPartOf(reply: string, thought: string): string | undefined {
  const bare = thought.trim().replace(/[.!…]+$/u, '');
  if (bare === '') return reply;
  const at = reply.toLowerCase().indexOf(bare.toLowerCase());
  if (at < 0) return undefined;

  let before = reply.slice(0, at);
  const after = reply.slice(at + bare.length);
  /**
   * Без знаков (набор cases-plain, 28.09.2026): «вечером и купить хлеб» —
   * граница союз. Что перед ним только ответ, проверит `namesDeed`.
   */
  let joined = false;
  while (CONJUNCTIONS.test(before)) {
    before = before.replace(CONJUNCTIONS, '');
    joined = true;
  }

  const rest = `${before} ${after}`;
  if (!/[\p{L}\d]/u.test(rest)) return undefined;
  const separated =
    before.trim() === '' ? /^\s*[.,;:!?—–\-\n]/u.test(after) : BOUNDARY.test(before) || joined;
  return separated ? rest : undefined;
}

const QUESTION_WORDS = new Set([
  'чего',
  'что',
  'какой',
  'какая',
  'какое',
  'какие',
  'какую',
  'каких',
  'где',
  'когда',
  'почему',
  'зачем',
  'как',
  'смысле',
  'поняла',
  'понял',
  'чем',
  'куда',
]);

/**
 * «Не знаю», «потом», «без разницы» — выбора нет, что бы ни сказала модель
 * (пробный замер 28.09.2026: «Не знаю пока» → «07:00» прошло бы проверку).
 */
const UNDECIDED = [
  'не знаю',
  'не помню',
  'потом',
  'без разницы',
  'не важно',
  'неважно',
  'все равно',
  'всё равно',
  'как хочешь',
  'посмотрим',
  // «Сложно сказать» — не дело «сказать» (набор cases-plain, 28.09.2026).
  'сложно сказать',
  'трудно сказать',
  'не могу сказать',
];

function soundsUndecided(reply: string): boolean {
  const joined = ` ${words(reply).join(' ')} `;
  return UNDECIDED.some((phrase) => joined.includes(` ${phrase} `));
}

/**
 * Отказ ставить или переносить (замер 28.09.2026: «Не надо переносить»,
 * «Время не надо»): у вопроса о часе — «оставлю как есть». У «Перенести?»
 * «не надо» — это «нет», и там его узнаёт словарь.
 */
const REFUSALS = ['не надо', 'не нужно', 'не ставь', 'не переноси', 'оставь'];

function refuses(reply: string): boolean {
  const joined = ` ${words(reply).join(' ')} `;
  return REFUSALS.some((phrase) => joined.includes(` ${phrase} `));
}

/**
 * Вопрос о своих делах — не встречный вопрос (замер 28.09.2026): «Что у
 * меня на завтра?» модель читала переспросом, и бот объяснял бы свой
 * вопрос вместо ответа.
 */
const ABOUT_OWN = new Set(['меня', 'мне', 'мой', 'моя', 'моё', 'мое', 'мои', 'моих', 'мою']);

function withoutUndecided(reply: string): string {
  let joined = ` ${words(reply).join(' ')} `;
  for (const phrase of UNDECIDED) joined = joined.split(` ${phrase} `).join(' ');
  return joined.trim();
}

function asksBack(reply: string): boolean {
  if (words(reply).some((word) => ABOUT_OWN.has(word))) return false;
  return reply.includes('?') || words(reply).some((word) => QUESTION_WORDS.has(word));
}

/**
 * Новая мысль называет дело, чувство или помечена «ещё», «кстати», «надо».
 * Иначе это пояснение к ответу (замер 28.09.2026: «Утром я на работе, так
 * что вечером», «ночью кто ж посылки забирает», «Посылку днём») — оно
 * часть ответа, а не запись.
 */
const THOUGHT_MARKERS = new Set(['ещё', 'еще', 'кстати', 'надо', 'нужно', 'забыть', 'также']);

function isThought(thought: string): boolean {
  if (moodOf(thought) !== undefined) return true;
  return words(thought.replace(/ё/gu, 'е')).some(
    (word) => THOUGHT_MARKERS.has(word) || isVerb(word),
  );
}

/** Согласие первым словом: «да», «ага», «угу». */
const YES_WORDS = new Set(['да', 'ага', 'угу']);

/** Ответ модели — через проверки кода. */
export function checkReading(
  question: ReaderQuestion,
  reply: string,
  reading: ReaderReading,
): ReplyMeaning {
  const title = titleOf(question);

  switch (reading.kind) {
    case 'not_answer':
      return { kind: 'not_answer' };
    case 'counter_question':
      if (words(reply).some((word) => ABOUT_OWN.has(word))) return { kind: 'not_answer' };
      return asksBack(reply)
        ? { kind: 'counter_question' }
        : { kind: 'unread', why: 'встречный вопрос без вопроса' };
    case 'undecided':
      // «А какая разница?» — спрашивает, а не отказывается: объяснить.
      if (reply.includes('?') && asksBack(reply)) return { kind: 'counter_question' };
      // «Сложно сказать» — не дело «сказать»; «Не знаю, надо ещё позвонить
      // маме» — дело: ищется в словах без самой фразы «не знаю».
      if (
        words(reply).length <= UNDECIDED_WORDS &&
        soundsUndecided(reply) &&
        !namesDeed(withoutUndecided(reply), title)
      ) {
        return { kind: 'undecided' };
      }
      return words(reply).length <= UNDECIDED_WORDS && !namesDeed(reply, title)
        ? { kind: 'undecided' }
        : { kind: 'unread', why: '«не решил» с новым делом' };
    case 'ambiguous':
      return namesDeed(reply, title)
        ? { kind: 'unread', why: '«двояко» с новым делом' }
        : { kind: 'ambiguous' };
    case 'answer':
      break;
  }

  // Пояснение к ответу — часть ответа, а не мысль.
  const thought = isThought(reading.thought) ? reading.thought.trim() : '';
  const part = answerPartOf(reply, thought);
  if (part === undefined) return { kind: 'unread', why: 'мысль не из реплики или не отделена' };

  /**
   * «Не знаю», «не надо переносить» у вопроса о часе и «Какое дело?» —
   * «оставлю как есть», какой бы выбор ни назвала модель. У кнопок —
   * не прочитано: там «не надо» — это «нет», и его знает словарь.
   */
  const unsure = soundsUndecided(part);
  if ((question.kind === 'time' || question.kind === 'which') && !namesDeed(part, title)) {
    if (unsure || refuses(part)) return { kind: 'undecided' };
  }
  if (unsure) return { kind: 'unread', why: '«не знаю» — выбора нет' };
  const choice = reading.choice.trim();

  if (question.kind === 'which') {
    if (choice === '' || notADeed(choice) || notADeed(part)) {
      return { kind: 'unread', why: 'не название дела' };
    }
    if (!part.toLowerCase().includes(choice.toLowerCase())) {
      return { kind: 'unread', why: 'дело названо не словами реплики' };
    }
    return {
      kind: 'answer',
      command: `${question.command.trim().replace(/[.!…\s]+$/u, '')} — ${choice}`,
      choice,
      thought,
    };
  }

  if (namesDeed(part, title)) return { kind: 'unread', why: 'в ответе новое дело' };

  if (question.kind === 'move' || question.kind === 'attach') {
    const allowed = question.kind === 'move' ? ['да', 'нет'] : ['к прошлой', 'отдельно'];
    if (!allowed.includes(choice)) return { kind: 'unread', why: 'выбор не из предложенных' };
    /**
     * Согласие в словах и «нет»/«отдельно» у модели — спор (замер
     * 28.09.2026: «Да, и ещё записать Диму к логопеду» → «отдельно»).
     */
    const first = words(part)[0] ?? '';
    if (YES_WORDS.has(first) && (choice === 'нет' || choice === 'отдельно')) {
      return { kind: 'unread', why: 'спор: согласие в словах, отказ у модели' };
    }
    return { kind: 'answer', choice, thought };
  }

  const time = /^(\d{1,2}):(\d{2})$/u.exec(choice);
  if (time === null) return { kind: 'unread', why: 'час не по форме' };
  const minutes = Number(time[1]) * 60 + Number(time[2]);
  const offered = offeredOf(question.command).includes(minutes);
  const said = clockTimesIn(part).some((one) => one.length === 1 && one[0] === minutes);
  if (!offered && !said) return { kind: 'unread', why: 'час ни предложен, ни сказан' };

  const base = withoutClockPhrase(question.command)
    .trim()
    .replace(/[.!…\s]+$/u, '');
  return {
    kind: 'answer',
    command: `${base} в ${clock(minutes)}`,
    choice: clock(minutes),
    thought,
  };
}

export type AskReading = (
  deps: AiClientDeps,
  request: StructuredRequest,
) => Promise<StructuredOutcome<ReaderReading>>;

export interface ReadReplyParams {
  readonly question: ReaderQuestion;
  readonly reply: string;
  readonly before?: string | undefined;
  readonly texts: TextProfile;
  readonly userId?: string | undefined;
  readonly batchId?: string | undefined;
}

/** Что человек имел в виду — по модели и проверкам кода. Никогда не бросает. */
export async function readReply(
  deps: AiClientDeps,
  params: ReadReplyParams,
  ask: AskReading = requestStructured,
): Promise<ReplyMeaning> {
  try {
    const outcome = await ask(deps, {
      stage: 'reader',
      input: readerInput(params.question, params.texts, params.reply, params.before),
      userId: params.userId,
      batchId: params.batchId,
      maxTokens: MAX_TOKENS,
    });
    if (!outcome.ok) return { kind: 'unread', why: outcome.problem };
    return checkReading(params.question, params.reply, outcome.value);
  } catch (error) {
    return { kind: 'unread', why: error instanceof Error ? error.message : String(error) };
  }
}

export { READER_SCHEMA_NAME };
