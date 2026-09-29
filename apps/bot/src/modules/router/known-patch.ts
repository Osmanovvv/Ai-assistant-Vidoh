import { clockTimesIn, naHourReadings, timeShiftIn } from '../classifier/clock-time.js';
import { namesDay } from '../classifier/own-sentence.js';
import { isVerb } from '../resolver/answer-reader.js';
import { sameWord } from '../resolver/clarify.js';

/**
 * Реплики без вопроса бота, которые маршрутизатор читает не так (набор
 * docs/eval-dialog/commands.md, замер 28.09.2026: верно 66 из 71).
 *
 * «Посылку на 10 утра», «давай хлеб на вечер», «у торта срок до пятницы»
 * он счёл новой мыслью — а это перенос записанного: завелось бы второе
 * дело рядом с «Забрать посылку». «Готово» он счёл болтовнёй — а это
 * «сделано» про последнее обсуждённое (`deixis.ts`).
 */

function wordsOf(text: string): readonly string[] {
  return text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .split(/[^\p{L}\d]+/u)
    .filter((word) => word !== '');
}

const DAYPARTS = new Set([
  'утро',
  'утром',
  'утра',
  'вечер',
  'вечером',
  'вечера',
  'вечеру',
  'днем',
  'дня',
  'ночью',
  'ночи',
]);

/**
 * Глагол дела не в неопределённой форме (29.09.2026): `isVerb` узнаёт
 * «заказать», но не «закажи» и не «заберу», и «Закажи такси на 9» шло
 * короткой поправкой — решала модель резолвера, а она могла счесть его
 * новым делом. С глаголом это повтор дела с новым часом, его ловит отсев
 * повторов кодом. Закрытый список частых дел: окончания «-и», «-ь»
 * носят и существительные («такси», «ночь»). «Давай» — связка, не дело.
 */
const DEED_FORMS = new Set(
  [
    'закажи закажу купи куплю позвони позвоню забери заберу отвези отвезу привези привезу',
    'перенеси перенесу напиши напишу сходи схожу съезди съезжу оплати оплачу вызови вызову',
    'отправь отправлю поставь поставлю сделай сделаю возьми возьму отнеси отнесу принеси',
    'принесу приготовь приготовлю убери уберу найди найду проверь проверю спроси спрошу',
    'скажи скажу передай передам узнай узнаю договорись договорюсь встреть встречу',
    'закажите купите позвоните заберите отвезите',
  ]
    .join(' ')
    .split(' '),
);

/** Просьба завести новое: «запиши к врачу в пятницу» — не перенос. */
const CREATE = new Set(['запиши', 'запишите', 'запомни', 'напомни', 'внеси', 'заведи', 'создай']);

/** Длиннее — уже рассказ, а не короткая поправка. */
const MAX_WORDS = 7;

/**
 * Одна реплика: названо записанное дело (слово его названия), назван срок
 * или час, и нет глагола — своего дела в ней нет. Такая «мысль» — перенос
 * этого дела; какого именно и куда, решает резолвер, как у «перенеси».
 * С глаголом («купить хлеб на завтра») — повтор с новым сроком, его ловит
 * отсев повторов (`same-text.ts`).
 */
export function patchesKnownItem(text: string, openTitles: readonly string[]): boolean {
  const words = wordsOf(text);
  if (words.length === 0 || words.length > MAX_WORDS) return false;
  if (words.some((word) => isVerb(word) || DEED_FORMS.has(word) || CREATE.has(word))) return false;

  // «Кстати такси на 9» — «на N» в конце у записанного дела тоже час (бой
  // 29.09.2026, 02:33: без этого завелось второе дело «Заказать такси на 9»).
  const timed =
    clockTimesIn(text).length > 0 ||
    naHourReadings(text) !== undefined ||
    timeShiftIn(text) !== undefined ||
    namesDay(text) ||
    words.some((word) => DAYPARTS.has(word));
  if (!timed) return false;

  const titles = openTitles.flatMap((title) => wordsOf(title).filter((word) => word.length >= 4));
  return words.some(
    (word) => word.length >= 4 && !DAYPARTS.has(word) && titles.some((own) => sameWord(word, own)),
  );
}

const DONE = new Set([
  'готово',
  'сделано',
  'сделала',
  'сделал',
  'выполнено',
  'выполнила',
  'выполнил',
]);
const AROUND_DONE = new Set(['все', 'уже', 'ну', 'вот', 'и', 'да', 'ок']);

/** «Готово», «всё, сделано», «уже сделала» — и ничего больше. */
export function onlyDoneWords(text: string): boolean {
  if (text.includes('?')) return false;
  const words = wordsOf(text);
  return (
    words.some((word) => DONE.has(word)) &&
    words.every((word) => DONE.has(word) || AROUND_DONE.has(word))
  );
}
