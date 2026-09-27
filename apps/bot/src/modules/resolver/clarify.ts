import { clockPhraseOf, clockTimesIn, withoutClockPhrase } from '../classifier/clock-time.js';
import { isRecordCommand, startsWithReplacement } from '../router/append.js';
import { namesNoDeed } from './deixis.js';

/**
 * Бот помнит, о чём переспросил (живой прогон Никиты 23.09.2026, 12:50).
 *
 * «Перенеси дело на пол 4» — «Какое дело? Назови его — и сделаю.» —
 * «Забрать посылку» — и бот ответил «Записала 1 дело…»: каждую реплику
 * модель видит отдельно, без того, что бот сказал секунду назад. Человек
 * понял бы с полуслова.
 *
 * Два переспроса без кнопок, и оба ждут одного ответа:
 *
 * - **«Какое дело?»** — ответ называет дело; команда доделывается над ним.
 * - **«Не поняла, 11:30 или 23:30?»** — ответ называет утро/вечер или
 *   однозначное время; перенос доделывается с ним.
 *
 * Невыполненная команда и так лежит черновиком (§16 — слова не теряются),
 * а пометка в причине черновика и есть память: какой переспрос и о чём.
 * Ждёт четверть часа и только следующую реплику. Не похоже на ответ —
 * реплика разбирается как обычно, и ничего не теряется.
 */

export type ClarifyKind = 'which' | 'time';

export const CLARIFY_REASON: Readonly<Record<ClarifyKind, string>> = {
  which: 'ждёт уточнения: какое дело',
  time: 'ждёт уточнения: утро или вечер',
};

/** Сколько бот помнит переспрос. */
export const CLARIFY_TTL_MS = 15 * 60_000;

/** Ответ длиннее — уже своя мысль, а не название дела. */
const ANSWER_WORDS = 6;

const DAYPARTS: Readonly<Record<string, string>> = {
  утра: 'утра',
  утром: 'утра',
  // Разговорное (проверка Никиты 24.09.2026): «вечерком», «с утра», «к
  // вечеру», «под вечер» бот не понимал, и вопрос терялся.
  утречком: 'утра',
  утро: 'утра',
  утру: 'утра',
  вечерком: 'вечера',
  вечер: 'вечера',
  вечеру: 'вечера',
  дня: 'дня',
  днем: 'дня',
  днём: 'дня',
  вечера: 'вечера',
  вечером: 'вечера',
  ночи: 'ночи',
  ночью: 'ночи',
  утренний: 'утра',
  утреннее: 'утра',
  вечерний: 'вечера',
  вечернее: 'вечера',
  /**
   * Выбор по порядку (прогон Никиты 27.09.2026, 18:02): «07:00 или 19:00?»
   * — «Второе». Бот не понял, вопрос закрылся, и «Вечером» следом ушло
   * подробностью к делу. В вопросе первым всегда идёт утреннее чтение
   * (`hourClarifyCommand` и переспрос переноса), вторым — вечернее.
   */
  первое: 'утра',
  первый: 'утра',
  первая: 'утра',
  второе: 'вечера',
  второй: 'вечера',
  вторая: 'вечера',
};

const FILLERS = new Set([
  'давай',
  'лучше',
  'ну',
  'наверное',
  'конечно',
  'это',
  'в',
  'на',
  // «с утра», «к вечеру», «под вечер», «рано утром», «поздно вечером».
  'с',
  'к',
  'под',
  'рано',
  'поздно',
  // «Второй вариант».
  'вариант',
]);

function trimmed(text: string): string {
  return text.trim().replace(/[.!…\s]+$/u, '');
}

function words(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\d:]+/u)
    .filter((word) => word.length > 0);
}

/**
 * Команда, доделанная ответом, — или ничего, если ответ на ответ не похож.
 *
 * Сборка — словами, а не полями: дальше команда идёт обычным путём правки,
 * с теми же стражами (запись-эхо, час без дня, два чтения часа).
 */
export function clarifiedCommand(
  kind: ClarifyKind,
  command: string,
  answer: string,
): string | undefined {
  const said = trimmed(answer);
  if (said === '' || said.includes('?')) return undefined;
  const spoken = words(said);

  if (kind === 'which') {
    if (spoken.length > ANSWER_WORDS) return undefined;
    // Своя команда — не ответ: «перенеси врача на пятницу», «удали это».
    if (namesNoDeed(said) || isRecordCommand(said) || startsWithReplacement(said)) {
      return undefined;
    }
    if (!spoken.some((word) => /\p{L}{3,}/u.test(word))) return undefined;
    return `${trimmed(command)} — ${said}`;
  }

  const content = spoken.filter((word) => !FILLERS.has(word));
  const daypart = content.length === 1 ? DAYPARTS[content[0] ?? ''] : undefined;
  if (daypart !== undefined) return `${trimmed(command)} ${daypart}`;

  /**
   * «Утром в 8» — часть суток и свой час (24.09.2026): час называет
   * человек, а не вопрос. Только час от 1 до 12 — «утром в 15» не такой.
   */
  if (content.length === 2) {
    const [first, second] = content;
    const part = DAYPARTS[first ?? ''] ?? DAYPARTS[second ?? ''];
    const hour = [first, second].find((word) => /^\d{1,2}$/u.test(word ?? ''));
    if (part !== undefined && hour !== undefined && Number(hour) >= 1 && Number(hour) <= 12) {
      return `${trimmed(withoutClockPhrase(command))} в ${hour} ${part}`;
    }
  }

  // «Семь вечера» — час словом без «в» (24.09.2026): читается с ним.
  const direct = clockTimesIn(said)[0];
  const phrase = direct === undefined ? `в ${said}` : said;
  const reading = direct ?? clockTimesIn(phrase)[0];
  if (reading?.length === 1 && spoken.length <= ANSWER_WORDS) {
    return `${trimmed(withoutClockPhrase(command))} ${phrase}`;
  }

  return undefined;
}

/**
 * Переспрос о часе нового дела (вариант Б, решение Никиты 24.09.2026):
 * «Забрать ребёнка в 7» — «Во сколько — 07:00 или 19:00?». Помнится он
 * так же, как переспрос переноса, — черновиком с командой, и ответ её
 * доделывает: «вечером» дописывает «вечера», «в 19:30» заменяет час.
 *
 * Команда — перенос этого дела на час без части суток, словами, которые
 * разбор читает с дописанной частью суток ровно одним чтением
 * (`clockPhraseOf`). Часа в названии нет: иначе первым читался бы он, с
 * двумя чтениями.
 */
/** Название дела из команды `hourClarifyCommand`; своя команда человека — пусто. */
export function hourClarifyTitle(command: string): string | undefined {
  const title = /^Перенеси «(.+)» в [^«»]+$/u.exec(command.trim())?.[1];
  return title === undefined || title.trim() === '' ? undefined : title;
}

export function hourClarifyCommand(title: string, morning: number): string {
  return `Перенеси «${withoutClockPhrase(title)}» ${clockPhraseOf(morning)}`;
}
