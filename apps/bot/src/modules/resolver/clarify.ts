import { clockPhraseOf, clockTimesIn, withoutClockPhrase } from '../classifier/clock-time.js';
import { moodOf } from '../presenter/mood.js';
import { onlyThanks } from '../presenter/thanks.js';
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

/** Начало причины у всех переспросов — и открытых, и закрытых («… → уточнено»). */
export const CLARIFY_PREFIX = 'ждёт уточнения:';

export const CLARIFY_REASON: Readonly<Record<ClarifyKind, string>> = {
  which: `${CLARIFY_PREFIX} какое дело`,
  time: `${CLARIFY_PREFIX} утро или вечер`,
};

/**
 * Вопрос о часе, который пережил чужую реплику и ждёт дальше (28.09.2026):
 * ответ узнаётся так же, но короткое голосовое после чужой реплики — уже
 * не «почти всегда ответ» (`answersNow`).
 */
export const CLARIFY_TIME_WAITING = `${CLARIFY_PREFIX} утро или вечер, после других слов`;

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
  // «Нет, вечером», «пусть будет вечером», «да, утром», «тогда вечером»
  // (прогон Никиты 27.09.2026): ответ — по-прежнему только часть суток или
  // час, эти слова вокруг него ничего не решают.
  'нет',
  'да',
  'ага',
  'пусть',
  'будет',
  'тогда',
  'пожалуй',
  /**
   * Присказки вокруг ответа (прогон Никиты 28.09.2026, 23:59): «Туфли
   * забрать вечером если что» бот не узнал из-за «если что» и завёл второе
   * дело. Здесь только слова, которые сами ничего не делают и ни о чём не
   * говорят; «купить», «хлеб», «после работы» — уже своя мысль, не ответ.
   */
  'если',
  'что',
  'а',
  'но',
  'же',
  'уж',
  'бы',
  'вот',
  'так',
  'там',
  'уже',
  'тоже',
  'всё',
  'все',
  'таки',
  'короче',
  'значит',
  'получается',
  'ладно',
  'хорошо',
  'окей',
  'ок',
  'можно',
  'наверно',
  'думаю',
  'точно',
  'просто',
  'мне',
  'поставь',
  'ставь',
  'сделай',
  'запиши',
  'пожалуйста',
  // «Часов в семь вечера», «где-то в семь», «примерно в 7 вечера».
  'часов',
  'часа',
  'где',
  'то',
  'примерно',
  'около',
]);

/**
 * «Не утром, а вечером»: отвергнутая часть суток — не ответ, выбрана
 * оставшаяся. Одно «не вечером» ответом не становится: выбора в нём нет.
 */
function withoutRejected(spoken: readonly string[]): readonly string[] {
  return spoken.filter(
    (word, index) =>
      !(word === 'не' && DAYPARTS[spoken[index + 1] ?? ''] !== undefined) &&
      !(spoken[index - 1] === 'не' && DAYPARTS[word] !== undefined),
  );
}

/**
 * На «Какое дело?» — не название дела (замер docs/eval-dialog, 28.09.2026):
 * «Спасибо», «Устала», «Не помню», «Забудь» бот принимал за название и
 * искал такое дело. «Не знаю», «не надо» — ничего не решено; «ещё»,
 * «кстати», второе предложение — новая мысль, которую ответ целиком
 * проглотил бы.
 */
const NOT_A_DEED = [
  'не помню',
  'не знаю',
  'забудь',
  'не надо',
  'не нужно',
  'никакое',
  'никакого',
  'не важно',
  'неважно',
  'не поняла',
  'не понял',
  'проехали',
];

const NEW_THOUGHT = new Set(['ещё', 'еще', 'кстати']);

function notADeed(said: string): boolean {
  if (onlyThanks(said) || moodOf(said) !== undefined) return true;
  const spoken = words(said);
  const joined = ` ${spoken.join(' ')} `;
  if (NOT_A_DEED.some((phrase) => joined.includes(` ${phrase} `))) return true;
  if (spoken.some((word) => NEW_THOUGHT.has(word))) return true;
  return said.split(/[.!?;]+/u).filter((part) => /\p{L}/u.test(part)).length > 1;
}

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
    if (notADeed(said)) return undefined;
    if (!spoken.some((word) => /\p{L}{3,}/u.test(word))) return undefined;
    return `${trimmed(command)} — ${said}`;
  }

  /**
   * Ответ со словами самого дела (прогон Никиты 27.09.2026, 23:29): «Платье
   * забрать вечером» на вопрос о «Забрать платье из ателье». Слова дела —
   * не ответ и не новая мысль: без них должно остаться то, что ответом и
   * так считается («вечером», «в 8 вечера», «второе»). Осталось что-то
   * ещё — «…и купить хлеб» — не ответ, как и было.
   */
  const heard = timeAnswer(command, said);
  if (heard !== undefined) return heard;

  const rest = withoutTitleWords(said, command);
  return rest === said || rest === '' ? undefined : timeAnswer(command, rest);
}

/** Слова дела из команды переспроса: «Перенеси «Забрать платье из ателье» в 8». */
function titleWords(command: string): readonly string[] {
  const title = /«([^»]+)»/u.exec(command)?.[1];
  return title === undefined ? [] : words(title.replace(/ё/gu, 'е'));
}

/**
 * Слово то же, что в названии: целиком, общее начало из четырёх букв или
 * из трёх, если это не меньше половины короче из слов — «заберу» при
 * «забрать», «куплю» при «купить», но не «заболел» при «забрать».
 */
function sameWord(one: string, other: string): boolean {
  if (one === other) return true;
  let common = 0;
  while (common < one.length && one[common] === other[common]) common++;
  if (one.length >= 4 && other.length >= 4 && common >= 4) return true;
  return common >= 3 && common * 2 >= Math.min(one.length, other.length);
}

/**
 * Говорит ли реплика о деле из переспроса — хоть одним значимым словом его
 * названия (от четырёх букв: «из», «в» не в счёт).
 *
 * Вопрос о часе ждёт ответа, пока человек говорит о другом (прогон Никиты
 * 28.09.2026): «Купить молоко» отдельным сообщением закрывало вопрос, и
 * ответ следом заводил второе дело. Заговорил о самом деле и не ответил —
 * «перенеси туфли на пятницу», «туфли уже забрала» — вопрос снят, как и
 * было: доделывать его потом значило бы спорить с тем, что сказано после.
 */
export function mentionsDeed(command: string, text: string): boolean {
  const title = titleWords(command).filter((word) => word.length >= 4);
  if (title.length === 0) return false;
  return words(text.replace(/ё/gu, 'е')).some((word) => title.some((own) => sameWord(word, own)));
}

function withoutTitleWords(said: string, command: string): string {
  const title = titleWords(command);
  if (title.length === 0) return said;

  return words(said.replace(/ё/gu, 'е'))
    .filter((word) => !title.some((own) => sameWord(word, own)))
    .join(' ');
}

/** Ответ о части суток или часе — или ничего. */
function timeAnswer(command: string, said: string): string | undefined {
  const spoken = words(said);
  const content = withoutRejected(spoken).filter((word) => !FILLERS.has(word));
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
  if (reading?.length === 1 && spoken.length <= ANSWER_WORDS && onlyClockIn(phrase)) {
    return `${trimmed(withoutClockPhrase(command))} ${phrase}`;
  }

  return undefined;
}

/**
 * Кроме часа — только присказки (замер docs/eval-dialog, 28.09.2026):
 * «Позвонить в банк в 7 вечера» на вопрос про туфли ставило туфлям 19:00,
 * а звонок пропадал. Слова сверх часа — своя мысль, не ответ.
 */
function onlyClockIn(phrase: string): boolean {
  return words(withoutClockPhrase(phrase)).every(
    (word) => FILLERS.has(word) || DAYPARTS[word] !== undefined,
  );
}

/**
 * Ответ на переспрос внутри выгрузки из нескольких сообщений (прогон
 * Никиты 27.09.2026, 23:29).
 *
 * Бот спросил «08:00 или 20:00?», а человек успел наговорить два голосовых
 * про зубного и следом ответил «Платье забрать вечером» — одна выгрузка.
 * Ответ искался по всей выгрузке и не нашёлся: вопрос закрылся, «вечером»
 * стало новым делом. Теперь выгрузка целиком — как раньше; не ответ —
 * ответом может быть одно её сообщение (строка), с конца, а остальное
 * разбирается как обычно.
 *
 * Только у «утро или вечер»: ответы там узкие — часть суток, час, «второе».
 * На «Какое дело?» ответом выглядит любая короткая фраза, и среди новых
 * мыслей бот начал бы принимать их за ответ.
 */
export function answerInBatch(
  kind: ClarifyKind,
  command: string,
  combined: string,
): { readonly command: string; readonly besides: string } | undefined {
  const whole = clarifiedCommand(kind, command, combined);
  if (whole !== undefined) return { command: whole, besides: '' };
  if (kind !== 'time') return undefined;

  const lines = combined
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length < 2) return undefined;

  for (let at = lines.length - 1; at >= 0; at--) {
    const one = clarifiedCommand(kind, command, lines[at] ?? '');
    if (one !== undefined) {
      return { command: one, besides: lines.filter((_, index) => index !== at).join('\n') };
    }
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
