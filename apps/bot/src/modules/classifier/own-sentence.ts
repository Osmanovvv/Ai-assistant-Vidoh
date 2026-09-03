import { localDateParts, nearestWeekday, startOfDayInZone } from './dates.js';

/**
 * День из **своего предложения речи** (задача 3.49).
 *
 * **Зачем.** Живой прогон 03.09.2026 на выгрузке проджекта: «Ещё сегодня
 * хотел позвонить бабушке» и «Вот на выходных надо бы разобрать балкон» —
 * модель не дала этим делам срока вовсе. Взять его из текста самой мысли
 * нельзя: извлечение переписало их в «Позвонить бабушке» и «Разобрать
 * балкон», без слова о дне. А в речи слово стоит рядом, в том же
 * предложении.
 *
 * **Почему это не догадка, от которой я раньше отказался.** Отказ был от
 * «сопоставить единицу с предложением» по пересечению слов — это правда
 * гадание, и цена ему выдуманные сроки. Здесь три условия, и каждое
 * проверяется, а не предполагается:
 *
 * 1. **Дословность.** Берётся самая длинная цепочка слов мысли, идущая в
 *    речи подряд, и не короче двух слов. Пересказ не подойдёт — и это
 *    правильно: значит связь не доказана.
 * 2. **Единственность предложения.** Цепочка встречается ровно в одном
 *    предложении. Встретилась в двух — связь неоднозначна, выходим.
 * 3. **Единственность дня.** В этом предложении названо ровно одно
 *    обозначение дня. «Хотя нет, давай мойку лучше в пятницу, вот в
 *    пятницу тогда надо помыть машину, ещё позвонить стоматологу,
 *    записаться на следующую неделю» — два разных обозначения, выходим.
 *
 * **Работает только как запасной путь:** когда своего срока у записи не
 * вышло вовсе. Дату, которую дала модель, здесь никто не перебивает.
 *
 * **И только у дел.** Желанию и замыслу срок не нужен: §6.3 держит их
 * вне выдачи, а лишняя дата у «когда-нибудь хочу наушники» — это
 * выдуманный срок, худшая из ошибок разбора.
 */

export interface SentenceDay {
  readonly at: Date;
  readonly accuracy: 'day' | 'week';
}

/** Обозначения дня: слово → смещение в сутках от сегодня. */
const RELATIVE: readonly (readonly [string, number])[] = [
  ['послезавтра', 2],
  ['сегодня', 0],
  ['завтра', 1],
];

/** Дни недели: слово → номер дня, как у `Date.getDay()`. */
const WEEKDAYS: readonly (readonly [string, number])[] = [
  ['понедельник', 1],
  ['вторник', 2],
  ['среду', 3],
  ['среда', 3],
  ['среды', 3],
  ['четверг', 4],
  ['пятницу', 5],
  ['пятница', 5],
  ['пятницы', 5],
  ['субботу', 6],
  ['суббота', 6],
  ['субботы', 6],
  ['воскресенье', 0],
  ['воскресенья', 0],
];

/** «Выходные» — период, а не день: дата ставится на ближайшую субботу. */
const WEEKEND = ['выходные', 'выходных'];

/**
 * Обозначения срока, из которых **дня не вывести**: недели, месяцы,
 * «через столько-то».
 *
 * Считаются наравне с остальными и потому мешают: сами дату не дают, а
 * рядом с днём делают предложение неоднозначным. «Вот в пятницу тогда
 * надо помыть машину, ещё позвонить стоматологу, записаться **на
 * следующую неделю**» — какой из двух сроков чей, отсюда не видно.
 *
 * Без этого списка правило брало «пятницу» и ставило её стоматологу.
 */
const VAGUE = ['неделю', 'неделе', 'недели', 'месяц', 'месяце', 'месяца', 'через'];

function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/gu, 'е');
}

function tokens(text: string): readonly string[] {
  return normalize(text)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0);
}

/** Предложения речи. Точка, вопрос, восклицание и перевод строки. */
function sentencesOf(speech: string): readonly string[] {
  return speech
    .split(/[.!?\n]+/u)
    .map((one) => one.trim())
    .filter((one) => one.length > 0);
}

/**
 * Какой день назван в предложении.
 *
 * Возвращается описание, а не дата: считать дату надо один раз, уже
 * убедившись, что обозначение ровно одно.
 */
type DayMark =
  | { readonly kind: 'relative'; readonly shift: number }
  | { readonly kind: 'weekday'; readonly weekday: number }
  | { readonly kind: 'weekend' }
  /** Срок назван, но дня в нём нет: недели, месяцы, «через». */
  | { readonly kind: 'vague' };

function marksIn(sentence: string): readonly DayMark[] {
  const words = tokens(sentence);
  const marks: DayMark[] = [];
  const seen = new Set<string>();

  const remember = (key: string, mark: DayMark): void => {
    if (seen.has(key)) return;
    seen.add(key);
    marks.push(mark);
  };

  for (const word of words) {
    for (const [name, shift] of RELATIVE) {
      if (word === name) remember(`r${String(shift)}`, { kind: 'relative', shift });
    }
    for (const [name, weekday] of WEEKDAYS) {
      if (word === name) remember(`w${String(weekday)}`, { kind: 'weekday', weekday });
    }
    if (WEEKEND.includes(word)) remember('weekend', { kind: 'weekend' });
    if (VAGUE.includes(word)) remember('vague', { kind: 'vague' });
  }

  return marks;
}

/**
 * Самая длинная цепочка слов мысли, идущая в речи подряд.
 *
 * Не короче двух слов: одно слово встречается в речи слишком часто,
 * чтобы что-то доказывать.
 */
function longestRun(item: readonly string[], speech: string): string {
  const haystack = ` ${tokens(speech).join(' ')} `;

  for (let length = item.length; length >= 2; length--) {
    for (let start = 0; start + length <= item.length; start++) {
      const run = item.slice(start, start + length).join(' ');
      if (haystack.includes(` ${run} `)) return run;
    }
  }

  return '';
}

export function dayFromOwnSentence(params: {
  readonly itemText: string;
  readonly spoken: string;
  readonly now: Date;
  readonly timeZone: string;
}): SentenceDay | undefined {
  const item = tokens(params.itemText);
  if (item.length < 2) return undefined;

  const run = longestRun(item, params.spoken);
  if (run === '') return undefined;

  const owning = sentencesOf(params.spoken).filter((sentence) =>
    ` ${tokens(sentence).join(' ')} `.includes(` ${run} `),
  );
  if (owning.length !== 1) return undefined;

  const marks = marksIn(owning[0] ?? '');
  if (marks.length !== 1) return undefined;

  const mark = marks[0];
  if (mark === undefined || mark.kind === 'vague') return undefined;

  const today = startOfDayInZone(localDateParts(params.now, params.timeZone), params.timeZone);
  const context = { now: params.now, timeZone: params.timeZone };

  if (mark.kind === 'relative') {
    const shifted = new Date(today.getTime() + mark.shift * 24 * 60 * 60_000);
    return {
      at: startOfDayInZone(localDateParts(shifted, params.timeZone), params.timeZone),
      accuracy: 'day',
    };
  }

  if (mark.kind === 'weekday') {
    return { at: nearestWeekday(mark.weekday, context), accuracy: 'day' };
  }

  // Выходные: ближайшая суббота, точность «неделя» — человек назвал
  // период, а не день, и притворяться, что день, нельзя.
  return { at: nearestWeekday(6, context), accuracy: 'week' };
}
