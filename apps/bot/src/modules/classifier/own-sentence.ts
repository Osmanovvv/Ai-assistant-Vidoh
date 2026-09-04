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
  /** «Следующая неделя» — период, у которого дата всё же считается. */
  | { readonly kind: 'nextWeek' }
  /** Срок назван, но дня в нём нет: недели, месяцы, «через». */
  | { readonly kind: 'vague' };

/** Ключ обозначения дня: по нему считается, сколько их названо разных. */
function keyOf(mark: DayMark): string {
  if (mark.kind === 'relative') return `r${String(mark.shift)}`;
  if (mark.kind === 'weekday') return `w${String(mark.weekday)}`;
  return mark.kind;
}

/**
 * «Следующая неделя» — двусловное обозначение, и потому проверяется
 * раньше одиночных слов (задача 3.56).
 *
 * Слово «неделю» само по себе расплывчато и стоит в `VAGUE`: из «через
 * неделю-две» дня не вывести. Но «на следующую неделю» — период с
 * известным началом, и человек назвал его прямо. Живой прогон
 * 04.09.2026: «позвонить стоматологу, записаться **на следующую
 * неделю**» — единственный срок, который был в речи, но не доехал до
 * записи вовсе.
 */
const NEXT_WEEK: readonly (readonly [string, string])[] = [
  ['следующую', 'неделю'],
  ['следующей', 'неделе'],
  ['следующей', 'недели'],
  ['будущей', 'неделе'],
  ['будущую', 'неделю'],
];

function isNextWeek(word: string, next: string): boolean {
  return NEXT_WEEK.some(([first, second]) => word === first && next === second);
}

/**
 * Обозначение, начинающееся ровно на этом слове.
 *
 * Нужно там, где важно не «названо ли где-то в предложении», а «стоит ли
 * прямо здесь»: см. `dayRightAfterItsWords`.
 */
function markAt(words: readonly string[], index: number): DayMark | undefined {
  const word = words[index];
  if (word === undefined) return undefined;

  const next = words[index + 1];
  if (next !== undefined && isNextWeek(word, next)) return { kind: 'nextWeek' };

  for (const [name, shift] of RELATIVE) {
    if (word === name) return { kind: 'relative', shift };
  }
  for (const [name, weekday] of WEEKDAYS) {
    if (word === name) return { kind: 'weekday', weekday };
  }
  if (WEEKEND.includes(word)) return { kind: 'weekend' };
  if (VAGUE.includes(word)) return { kind: 'vague' };

  return undefined;
}

function marksIn(sentence: string): readonly DayMark[] {
  const words = tokens(sentence);
  const seen = new Map<string, DayMark>();

  for (let index = 0; index < words.length; index++) {
    const mark = markAt(words, index);
    if (mark === undefined) continue;

    seen.set(keyOf(mark), mark);
    // «следующую неделю» занимает два слова: второе повторно не читаем,
    // иначе «неделю» добавит ещё и расплывчатое обозначение.
    if (mark.kind === 'nextWeek') index++;
  }

  return [...seen.values()];
}

/**
 * Предложения речи, которых мысль касается **дословно**.
 *
 * Берутся все цепочки слов мысли длиной от двух, идущие в предложении
 * подряд; предложение попадает в набор, если такая цепочка встречается
 * ровно в нём одном. Цепочка, найденная в двух предложениях, ничего не
 * доказывает и отбрасывается.
 *
 * **Почему все, а не самая длинная.** Сперва бралась одна, самая
 * длинная, — на том основании, что чем длиннее совпадение, тем надёжнее
 * связь. Живой прогон 04.09.2026 показал изъян: у мысли «Разобрать
 * балкон, коробки, выкинуть ненужное, посмотреть, сколько свободного
 * места останется» самой длинной оказалась «свободного места
 * останется», а она сидит в **соседнем** предложении — «Посмотреть,
 * сколько вообще свободного места останется», — где дня нет вовсе.
 * Короткая цепочка «разобрать балкон» указывала на нужное предложение,
 * с «на выходных», но до неё дело не доходило. Срок терялся молча.
 *
 * Мысль часто собрана из двух предложений речи, и день может стоять в
 * любом из них. Поэтому смотреть надо на все, куда мысль дотянулась, а
 * проверку однозначности делать по дню, а не по числу предложений.
 */
function touchedSentences(
  item: readonly string[],
  sentences: readonly string[],
): readonly string[] {
  const asWords = sentences.map((sentence) => ` ${tokens(sentence).join(' ')} `);
  const touched = new Set<number>();

  for (let length = item.length; length >= 2; length--) {
    for (let start = 0; start + length <= item.length; start++) {
      const run = ` ${item.slice(start, start + length).join(' ')} `;
      const found = asWords.reduce<number[]>(
        (all, words, index) => (words.includes(run) ? [...all, index] : all),
        [],
      );

      // Цепочка из двух предложений связь не доказывает: пропускаем её.
      if (found.length === 1 && found[0] !== undefined) touched.add(found[0]);
    }
  }

  return [...touched].map((index) => sentences[index] ?? '');
}

export function dayFromOwnSentence(params: {
  readonly itemText: string;
  readonly spoken: string;
  readonly now: Date;
  readonly timeZone: string;
}): SentenceDay | undefined {
  const item = tokens(params.itemText);
  if (item.length < 2) return undefined;

  /**
   * Дословной цепочки не нашлось вовсе — но это ещё не отказ (задача
   * 3.56). Запись «Записаться к стоматологу» в речи не звучит: человек
   * сказал «позвонить стоматологу, записаться». Цепочки из двух слов
   * подряд нет, а единственное слово «записаться» место в речи указывает
   * однозначно, и сразу за ним стоит срок.
   */
  const owning = touchedSentences(item, sentencesOf(params.spoken));
  if (owning.length === 0) return dayRightAfterItsWords(params);

  /**
   * Однозначность проверяется **по дню**, а не по числу предложений:
   * мысль часто собрана из двух, и это не повод отказываться. А вот два
   * разных дня — повод: какой из них чей, отсюда не видно.
   */
  const seen = new Map<string, DayMark>();
  for (const sentence of owning) {
    for (const mark of marksIn(sentence)) seen.set(keyOf(mark), mark);
  }

  const marks = [...seen.values()];

  /**
   * Обозначений два и больше — предложение неоднозначно, и тогда
   * пробуется второе правило: **срок, стоящий сразу за словами дела**
   * (задача 3.56). Оно точнее: смотрит не на предложение целиком, а на
   * место в речи вплотную за словом самой мысли.
   */
  if (marks.length !== 1) {
    return dayRightAfterItsWords(params);
  }

  const mark = marks[0];
  if (mark === undefined) return undefined;

  return dateOf(mark, params.now, params.timeZone) ?? dayRightAfterItsWords(params);
}

/** Дата обозначения. Считается один раз, уже убедившись, что оно одно. */
function dateOf(mark: DayMark, now: Date, timeZone: string): SentenceDay | undefined {
  if (mark.kind === 'vague') return undefined;

  const context = { now, timeZone };

  if (mark.kind === 'relative') {
    const today = startOfDayInZone(localDateParts(now, timeZone), timeZone);
    const shifted = new Date(today.getTime() + mark.shift * 24 * 60 * 60_000);
    return {
      at: startOfDayInZone(localDateParts(shifted, timeZone), timeZone),
      accuracy: 'day',
    };
  }

  if (mark.kind === 'weekday') {
    return { at: nearestWeekday(mark.weekday, context), accuracy: 'day' };
  }

  // Следующая неделя: её начало, ближайший понедельник. Точность
  // недельная — человек назвал период, а не день.
  if (mark.kind === 'nextWeek') {
    return { at: nearestWeekday(1, context), accuracy: 'week' };
  }

  // Выходные: ближайшая суббота, точность «неделя» — человек назвал
  // период, а не день, и притворяться, что день, нельзя.
  return { at: nearestWeekday(6, context), accuracy: 'week' };
}

/**
 * Предлоги, через которые срок может стоять сразу за словом дела.
 *
 * Ровно один и только из этого списка. «Записаться **на** следующую
 * неделю» — предлог, «английский **у меня** послезавтра» — уже два слова,
 * и правило молчит: там связь не доказана.
 */
const LINKING = ['на', 'в', 'во', 'до', 'к', 'ко', 'по'];

/** Сколько раз слово встречается во всей речи как отдельное слово. */
function timesInSpeech(spoken: string, word: string): number {
  return tokens(spoken).filter((one) => one === word).length;
}

/**
 * Срок, стоящий **сразу за словами дела** (задача 3.56).
 *
 * **Зачем понадобилось второе правило.** Живой прогон 04.09.2026:
 * «...вот в пятницу тогда надо помыть машину, ещё позвонить стоматологу,
 * записаться на следующую неделю. Конкретно время к стоматологу я пока не
 * знаю». Дело про стоматолога осталось **без срока вовсе**, хотя срок в
 * речи назван.
 *
 * Правило по предложению помочь не могло, и оба раза по делу:
 *
 * - в первом предложении названы и «пятницу», и «следующую неделю» —
 *   какой из двух сроков чей, оттуда не видно;
 * - а дословная цепочка записи «Записаться к стоматологу» попадает лишь
 *   во **второе** предложение, где дня нет вовсе: «время к стоматологу».
 *
 * **Условия, и каждое проверяется.** Берётся слово мысли, которое во всей
 * речи встречается **ровно один раз**, — тогда место в речи найдено
 * однозначно, без догадок. Сразу за ним, через ноль или один предлог из
 * закрытого списка, должно **начинаться** обозначение срока. И в том же
 * предложении: за точкой начинается речь о другом, и «вынести мусор. Ещё
 * **сегодня** хотел позвонить бабушке» иначе отдало бы «сегодня» мусору.
 *
 * Если таких мест несколько и они называют разные сроки — правило
 * молчит: спор решать не ему.
 */
function dayRightAfterItsWords(params: {
  readonly itemText: string;
  readonly spoken: string;
  readonly now: Date;
  readonly timeZone: string;
}): SentenceDay | undefined {
  const own = new Set(tokens(params.itemText));
  const found = new Map<string, DayMark>();

  for (const sentence of sentencesOf(params.spoken)) {
    const words = tokens(sentence);

    for (let index = 0; index < words.length; index++) {
      const word = words[index];
      if (word === undefined || !own.has(word)) continue;
      // Слово должно быть единственным в речи: иначе место не найдено.
      if (timesInSpeech(params.spoken, word) !== 1) continue;

      let after = index + 1;
      if (LINKING.includes(words[after] ?? '')) after++;

      const mark = markAt(words, after);
      if (mark !== undefined) found.set(keyOf(mark), mark);
    }
  }

  if (found.size !== 1) return undefined;

  const mark = [...found.values()][0];
  if (mark === undefined) return undefined;

  return dateOf(mark, params.now, params.timeZone);
}

/**
 * Слова, которыми человек отменяет только что сказанное.
 *
 * Закрытый список, и проверяется он **в начале предложения**: «хотя нет»
 * посреди фразы может быть чем угодно, а первым словом — это отмена.
 */
const RETRACTION: readonly (readonly string[])[] = [
  ['хотя', 'нет'],
  ['хотя', 'давай'],
  ['а', 'нет'],
  ['нет', 'давай'],
  ['нет', 'лучше'],
  ['передумал'],
  ['передумала'],
];

function opensWithRetraction(words: readonly string[]): boolean {
  return RETRACTION.some((opener) => opener.every((word, at) => words[at] === word));
}

/** Служебные слова: общими они ничего не доказывают. */
const FUNCTION_WORDS = new Set([
  'надо',
  'нужно',
  'хотел',
  'хотела',
  'давай',
  'лучше',
  'тогда',
  'вот',
  'еще',
  'это',
  'меня',
  'мне',
  'уже',
  'там',
  'потом',
]);

/** Обозначение дня, из которого дата выводится однозначно. */
function isDefinite(mark: DayMark): boolean {
  return mark.kind === 'relative' || mark.kind === 'weekday';
}

/**
 * День, на который человек **перенёс дело, передумав вслух** (задача 3.56).
 *
 * **Зачем.** Живой прогон 04.09.2026: «Ещё в четверг хотел заехать я на
 * мойку. Хотя нет, давай мойку лучше в пятницу». Бот завёл «Заехать на
 * мойку в четверг» — дело на день, от которого человек отказался сам,
 * через полсекунды. В списке это выглядит так, будто бот не слушал.
 *
 * **Это единственное место, где день модели перебивается.** Обычно
 * дату модели не трогают: она видит фразу целиком. Но отмена сказана
 * прямо, своими словами, и слушать надо человека.
 *
 * **Четыре условия, и каждое проверяется:**
 *
 * 1. Следующее предложение **начинается** словами отмены из закрытого
 *    списка.
 * 2. В прежнем предложении назван ровно один определённый день, и в
 *    отменяющем — ровно один, и они разные.
 * 3. У двух предложений есть **общее значимое слово** — оно доказывает,
 *    что речь об одном и том же деле, а не о новом.
 * 4. Дословная цепочка самой мысли лежит в **прежнем** предложении: это
 *    её день отменили, а не чей-то ещё.
 */
export function dayAfterRetraction(params: {
  readonly itemText: string;
  readonly spoken: string;
  readonly now: Date;
  readonly timeZone: string;
}): SentenceDay | undefined {
  const sentences = sentencesOf(params.spoken);
  const item = tokens(params.itemText);
  if (item.length < 2) return undefined;

  for (let index = 0; index + 1 < sentences.length; index++) {
    const before = sentences[index] ?? '';
    const after = sentences[index + 1] ?? '';

    if (!opensWithRetraction(tokens(after))) continue;

    const wasMarks = marksIn(before).filter(isDefinite);
    const nowMarks = marksIn(after).filter(isDefinite);
    if (wasMarks.length !== 1 || nowMarks.length !== 1) continue;

    const was = wasMarks[0];
    const moved = nowMarks[0];
    if (was === undefined || moved === undefined) continue;
    if (keyOf(was) === keyOf(moved)) continue;

    // Общее значимое слово: без него это отмена чего-то другого.
    const shared = tokens(before).some(
      (word) => word.length >= 4 && !FUNCTION_WORDS.has(word) && tokens(after).includes(word),
    );
    if (!shared) continue;

    // И отменили день именно этой мысли: её слова лежат в прежнем
    // предложении, дословно.
    if (!touchedSentences(item, sentences).includes(before)) continue;

    return dateOf(moved, params.now, params.timeZone);
  }

  return undefined;
}
