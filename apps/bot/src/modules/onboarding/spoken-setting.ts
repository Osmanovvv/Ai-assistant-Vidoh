import { clockTimesIn, withoutClockPhrase } from '../classifier/clock-time.js';
import { moodOf } from '../presenter/mood.js';
import { onlyThanks } from '../presenter/thanks.js';
import { startsAsQuestion } from '../resolver/answer.js';
import { isVerb } from '../resolver/answer-reader.js';

import { parseName, parseTime } from './awaiting.js';

/**
 * Ответы на вопросы-настройки словами (план docs/28, шаг 6; набор
 * docs/eval-dialog/settings.md, 28.09.2026).
 *
 * Опрос и меню «Изменить» понимали время только цифрами: «в восемь»,
 * «полвосьмого», «давай в 8» — «не разобрала». Хуже того, «в 9» на «Во
 * сколько писать вечером?» сохранялось как 09:00, и вечерняя сводка
 * пришла бы утром. Имя бралось целиком: «Меня зовут Оля» — бот звал бы
 * «Меня зовут Оля», а «купить хлеб» становилось именем.
 *
 * Строгий разбор (`parseTime`, `parseName`) остаётся первым и прежним;
 * здесь — то, что к нему добавлено.
 */

export type DayPart = 'morning' | 'evening';

function wordsOf(text: string): readonly string[] {
  return text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .split(/[^\p{L}\d:]+/u)
    .filter((word) => word !== '');
}

function hasPhrase(text: string, phrase: string): boolean {
  return ` ${wordsOf(text).join(' ')} `.includes(` ${phrase} `);
}

/** Слова вокруг часа, которые ничего не значат: «давай в 8», «ну в 8 наверное». */
const AROUND = new Set([
  'давай',
  'пусть',
  'ну',
  'наверное',
  'наверно',
  'пожалуйста',
  'где',
  'то',
  'около',
  'примерно',
  'часов',
  'часа',
  'в',
  'во',
  'к',
  'утром',
  'утра',
  'вечером',
  'вечера',
  'это',
  'лучше',
  'можно',
  'тогда',
  'так',
]);

/** «Не пиши вечером» — вечерней сводки не надо (только у вечера). */
const OFF = ['не пиши', 'не надо', 'не нужно', 'не присылай', 'выключи', 'никогда'];

const MORNING_WORDS = new Set(['утра', 'утром']);

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Время ответа на «Во сколько писать утром / вечером?» — «ЧЧ:ММ», `off`
 * (вечером не писать) или ничего. Час без утра и вечера — в ту половину
 * суток, о которой спросили: «в 9» вечером — 21:00.
 */
export function settingTime(text: string, part: DayPart): string | undefined {
  const said = text.trim();
  if (said === '' || said.includes('?')) return undefined;
  if (part === 'evening' && !/\d/u.test(said) && OFF.some((phrase) => hasPhrase(said, phrase))) {
    return 'off';
  }

  const strict = parseTime(said);
  if (strict !== undefined) {
    const hour = Number(strict.slice(0, 2));
    const morningSaid = wordsOf(said).some((word) => MORNING_WORDS.has(word));
    return part === 'evening' && hour < 12 && !morningSaid
      ? `${String(hour + 12).padStart(2, '0')}${strict.slice(2)}`
      : strict;
  }

  // «Восемь утра» без «в» — час словом читается с ним, как в переспросе.
  const direct = clockTimesIn(said);
  const phrase = direct.length > 0 ? said : `в ${said}`;
  const found = direct.length > 0 ? direct : clockTimesIn(phrase);
  const [reading] = found;
  if (found.length !== 1 || reading === undefined) return undefined;
  // Кроме часа — только слова вокруг него: «позвонить маме в 8» — дело.
  if (!wordsOf(withoutClockPhrase(phrase)).every((word) => AROUND.has(word))) return undefined;

  if (reading.length === 1 && reading[0] !== undefined) return clock(reading[0]);
  const chosen = part === 'evening' ? reading[1] : reading[0];
  return reading.length === 2 && chosen !== undefined ? clock(chosen) : undefined;
}

/** Зачин перед именем: «меня зовут Оля», «зови меня Оля», «я Маша». */
const LEAD = /^(?:меня\s+зовут|зови\s+меня|называй\s+меня|можно\s+просто|можно|просто|я|это)\s+/iu;
/** Хвост после имени: «Катя, спасибо», «Настя конечно». */
const TAIL = /[\s,]+(?:спасибо|конечно|пожалуйста)$/iu;
/** «Не хочу говорить», «неважно» — имени нет. */
const NO_NAME = [
  'не хочу',
  'не скажу',
  'неважно',
  'не важно',
  'не знаю',
  'без разницы',
  'как хочешь',
];

/**
 * Имя из ответа на «Как тебя звать?» — или ничего: тогда реплика идёт
 * обычным разбором. Дело («купить хлеб»), спасибо, чувство и вопрос
 * именем не становятся.
 */
export function spokenName(text: string): string | undefined {
  const said = text.trim().replace(/[.!]+$/u, '');
  if (said === '' || text.includes('?')) return undefined;
  if (onlyThanks(said) || moodOf(said) !== undefined || startsAsQuestion(said)) return undefined;
  if (NO_NAME.some((phrase) => hasPhrase(said, phrase))) return undefined;
  if (wordsOf(said).some((word) => isVerb(word))) return undefined;

  let name = said;
  while (LEAD.test(name)) name = name.replace(LEAD, '');
  name = name.replace(TAIL, '');
  return parseName(name);
}
