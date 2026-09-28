import { mentionedIn, type ContextPack } from './context-pack.js';
import { pastFormsOf } from './past-forms.js';

/**
 * Сито живой строки (Никита 25.09.2026: «нам нельзя, чтобы фиговые фразы
 * были… нужно безопасно и точно»).
 *
 * Страж голоса (`context-line.ts`) — чёрный список: ловит «хорошее»,
 * «надо», «не забыла» — то, что уже встречалось. Новую неудачную фразу
 * он пропускает: так на бою 24.09.2026 ушло «Поняла, что поездка за
 * ребёнком запланирована на завтра». Сито — белый список, два правила:
 *
 * 1. **Каждое слово** строки — из фактов (названия дел, сферы, имя, срок)
 *    или из закрытого словаря бота ниже. Слова нет — строки нет: «хорошее
 *    дополнение к осеннему вечеру» не из чего сложить, как и любую
 *    выдумку, которую заранее не угадать.
 * 2. **Строка — о поводе**: называет дело, из-за которого она вообще
 *    пишется (срок прошёл, на сегодня, закрыла, повтор, большая цель). Без
 *    повода-дела строка может быть только о тишине или о первой выгрузке;
 *    строка об одном только записанном — пересказ списка, а список в
 *    ответе уже есть.
 *
 * Не прошла — ответ уходит без неё, как до 22.09.2026: хуже не бывает по
 * построению. Живость держит словарь: он из её же текста о характере
 * бота (docs/15) и из примеров промпта — расширять словарь, а не
 * ослаблять правило.
 */

export type LineHook = 'known' | 'overdue' | 'today' | 'done' | 'goals' | 'silence' | 'first';

/** «Прошлая выгрузка три дня назад и больше» — повод; вчера и позавчера — нет. */
const SILENCE_DAYS = 3;

/**
 * Повод для строки — те же семь, что в промпте презентера («За что
 * цепляться»), только по фактам кодом (проверка Никиты 24.09.2026,
 * 18:59–19:01: при одних целях модель трижды писала строку «ради строки»).
 */
export function hooksOf(pack: ContextPack): readonly LineHook[] {
  const known = new Set(pack.alreadyKnown);
  const hooks: LineHook[] = [];
  // «Уже было записано раньше» — как в `renderContextPack`: по записанному.
  if (pack.recorded.some((item) => known.has(item.title))) hooks.push('known');
  if (pack.overdue.length > 0) hooks.push('overdue');
  if (pack.today.length > 0) hooks.push('today');
  if (pack.doneRecently.length > 0) hooks.push('done');
  if (pack.projects.length > 0) hooks.push('goals');
  if (pack.daysSinceLast !== undefined && pack.daysSinceLast >= SILENCE_DAYS) {
    hooks.push('silence');
  }
  if (pack.daysSinceLast === undefined) hooks.push('first');
  return hooks;
}

export type SiftedLine = { readonly ok: true } | { readonly ok: false; readonly why: string };

/**
 * Словарь бота — служебные слова и его собственная речь. Всё, что о её
 * делах, берётся из фактов, а не отсюда.
 *
 * Нарочно **нет**: «снова», «виду», «вижу», «вернулась» — строки «ради
 * строки» из запретов промпта; «поняла» — начало пересказа; оценок,
 * советов и обещаний — их и чёрный список ловит, но словарь не должен их
 * даже знать.
 */
const VOCABULARY: ReadonlySet<string> = new Set(
  [
    // служебные
    'а и но или да нет не ни же ли бы то что чтобы как так когда где тут здесь там сюда',
    'теперь сейчас уже еще все всё весь вся всю всех это этот эта эти этого этой этим',
    'тот та те того той тем том про о об обо в во на к ко с со у из за по до от для без при',
    'над под после перед раз пока ведь вот лишь только тоже даже',
    // местоимения
    'ты тебя тебе тобой твой твоя твое твои твою твоих твоим твоей твоего',
    'я меня мне мной мой моя мое мои',
    'он она оно они его ее их ему ей им него нее них нему ней ним нем ними',
    'свой своя свое свои свою своих',
    // счёт и время — значения сверяет страж голоса по фактам
    'один одна одно одну одной первый первая первое первую первого',
    'второй вторая второе вторую второго два две двух три трех четыре пять шесть семь',
    'восемь девять десять несколько третий третья третью третьего четвертый четвертая',
    'пятый пятая шестой шестая седьмой седьмая восьмой девятый десятый',
    'день дня дней дню неделя недели неделю недель месяц месяца месяцев час часа часов',
    'сегодня завтра вчера послезавтра назад скоро срок срока',
    'прошел прошла прошло прошли висит висят',
    // речь бота — примеры промпта и её текст о характере (docs/15)
    'помню напомню держу держать голове голова голову головы',
    'запись записи записью записей записала записывала записано завела',
    'лежит лежат месте место никуда делась делось делся делись потерялась потерялось',
    'ждет ждут вопрос вопроса дело дела дел делу делом делах',
    'тишина тишины тишину тишиной была был было были есть занята занят другим',
    'дальше можно просто скидывать приходит значит повторной повторную больше',
    'шаг цель цели целью',
    // пересказ её дела: «платье, которое нужно забрать» (журнал боя
    // 27.09.2026, docs/29); понукание «нужно» стережёт страж голоса
    'нужно надо который которая которое которую которого которой которые',
  ]
    .join(' ')
    .split(' '),
);

/**
 * Слова о сделанном — правда только при закрытых делах в фактах: иначе
 * «Справка закрыта» об открытой. С «не» перед ними — всегда можно:
 * «всё ещё не закрыта».
 */
const DONE_WORDS: ReadonlySet<string> = new Set([
  'закрыт',
  'закрыта',
  'закрыто',
  'закрыты',
  'закрыла',
]);

function normalized(text: string): string {
  return text.toLowerCase().replace(/ё/gu, 'е');
}

/**
 * «Срок был», «срок прошёл» — правда только при прошедшем сроке в фактах
 * (бой 25.09.2026, 17:12): стоматолог перенесён на послезавтра, а живой
 * ответ сказал «срок был 27.09, 19:00». Все слова из фактов и словаря —
 * сито слов такое пропускает; ловит только связь «срок» с прошедшим.
 *
 * Между «срок» и «был» — до трёх слов («срок у анализов был»), и обратный
 * порядок («был срок»). Запятая или число между ними связь рвут.
 */
const PAST_DEADLINE_SOURCE =
  '(?<!\\p{L})срок\\p{L}*(?:\\s+\\p{L}+){0,3}?\\s+(?:уже\\s+)?(?:был|прошел|вышел|истек)(?!\\p{L})' +
  '|(?<!\\p{L})(?:уже\\s+)?(?:был|прошел|вышел|истек)\\s+срок';

const PAST_DEADLINE_WHY = 'срок назван прошедшим, а он впереди';

/** Где в тексте срок назван прошедшим. Свежий объект — у глобального нет общего `lastIndex`. */
function pastDeadlineClaims(text: string): RegExpMatchArray[] {
  return [...normalized(text).matchAll(new RegExp(PAST_DEADLINE_SOURCE, 'gu'))];
}

const DATE = /(?<!\d)(\d{1,2})\.(\d{2})(?!\d)/u;

/**
 * Срок в ответе назван прошедшим неверно (у ответа факты — текст
 * `questionFacts`). Дата рядом — сверяется она сама: прошедшая в фактах
 * записана «срок прошёл: 13.09», будущая — «срок: 27.09» или «— 23.09» в
 * ближайших днях. Даты нет — хватит прошедшего срока хоть у одного дела.
 */
function pastDeadlineWrongInAnswer(answer: string, factsText: string): boolean {
  const text = normalized(answer);
  const claims = pastDeadlineClaims(answer);
  if (claims.length === 0) return false;

  const anyPast = factsText.includes('срок прошел');
  return claims.some((claim) => {
    const start = claim.index ?? 0;
    const end = start + claim[0].length;
    const found =
      DATE.exec(text.slice(end, end + 24)) ?? DATE.exec(text.slice(Math.max(0, start - 12), start));
    if (found === null) return !anyPast;
    const date = `${(found[1] ?? '').padStart(2, '0')}.${found[2] ?? ''}`;
    return !factsText.includes(`срок прошел: ${date}`);
  });
}

function wordsOf(text: string): string[] {
  return normalized(text).match(/\p{L}+/gu) ?? [];
}

/** Слова фактов: её дела, сферы, имя, сроки — всё, что строка может назвать. */
function factWordsOf(pack: ContextPack): string[] {
  return [
    pack.name ?? '',
    ...pack.recorded.flatMap((item) => [item.title, item.topic, item.due ?? '']),
    ...pack.alreadyKnown,
    ...pack.overdue.map((item) => item.title),
    ...pack.today.flatMap((item) => [item.title, item.time ?? '']),
    ...pack.projects,
    ...pack.doneRecently,
  ].flatMap(wordsOf);
}

/**
 * Слово строки взято из фактов — с поправкой на падеж: «справку» из
 * «справка», «звонок» из «позвонить», «оплаты» из «оплатить». Основа —
 * слово без двух последних букв, не короче четырёх; она должна стоять
 * внутри слова фактов. Короткое слово факта («кот», «обои», «няню») —
 * по первым трём буквам, но не служебное: «под» из «под ключ» не
 * открывает «подарок». Слово в четыре буквы — по первым трём в начале
 * слова факта: «кота» из «котом», «маме» из «мамы». «Осеннему» из
 * «осень» так не сложить, и это нарочно: подробность, которой в фактах
 * нет.
 */
function fromFacts(word: string, facts: readonly string[]): boolean {
  if (word.length <= 3) return facts.some((fact) => fact.startsWith(word));
  if (
    word.length === 4 &&
    facts.some(
      (fact) => fact.length >= 4 && !VOCABULARY.has(fact) && fact.startsWith(word.slice(0, 3)),
    )
  ) {
    return true;
  }
  const core = word.slice(0, Math.max(4, word.length - 2));
  return facts.some(
    (fact) =>
      fact.includes(core) ||
      (fact.length >= 3 &&
        fact.length <= 4 &&
        !VOCABULARY.has(fact) &&
        word.startsWith(fact.slice(0, 3))),
  );
}

/** Прошедшее время глагола закрытого дела: «найти няню» → «нашла». */
function donePastForms(pack: ContextPack): ReadonlySet<string> {
  return new Set(
    pack.doneRecently.flatMap((title) => {
      const [verb] = wordsOf(title);
      return verb === undefined ? [] : pastFormsOf(verb);
    }),
  );
}

const asCandidates = (titles: readonly string[]): { id: string; title: string }[] =>
  titles.map((title) => ({ id: title, title }));

export function siftLine(line: string, pack: ContextPack): SiftedLine {
  const facts = factWordsOf(pack);
  const pastOfDone = donePastForms(pack);
  const words = wordsOf(line);

  if (pack.overdue.length === 0 && pastDeadlineClaims(line).length > 0) {
    return { ok: false, why: PAST_DEADLINE_WHY };
  }

  for (const [index, word] of words.entries()) {
    if (DONE_WORDS.has(word)) {
      if (words[index - 1] === 'не' || pack.doneRecently.length > 0) continue;
      return { ok: false, why: `слово не из фактов: ${word}` };
    }
    if (VOCABULARY.has(word) || pastOfDone.has(word) || fromFacts(word, facts)) continue;
    return { ok: false, why: `слово не из фактов: ${word}` };
  }

  const hooks = hooksOf(pack);
  const known = new Set(pack.alreadyKnown);
  const hookTitles = [
    ...pack.recorded.filter((item) => known.has(item.title)).map((item) => item.title),
    ...pack.overdue.map((item) => item.title),
    ...pack.today.map((item) => item.title),
    ...pack.doneRecently,
    ...pack.projects,
  ];
  const newTitles = pack.recorded
    .filter((item) => !known.has(item.title))
    .map((item) => item.title);

  const aboutHook = mentionedIn(line, asCandidates(hookTitles)).length > 0;
  if (aboutHook) return { ok: true };

  // Без дела-повода — только тишина или первая выгрузка, и не о записанном.
  const generic = hooks.includes('silence') || hooks.includes('first');
  const aboutNew = mentionedIn(line, asCandidates(newTitles)).length > 0;
  return generic && !aboutNew ? { ok: true } : { ok: false, why: 'не о поводе' };
}

/**
 * Сито живого ответа на вопрос (Никита 25.09.2026, пункт 2).
 *
 * Ответ пишет модель по закрытому списку фактов (`questionFacts`), и
 * страж голоса там — тот же чёрный список, что был у строки. Правило то
 * же, что у строки: каждое слово — из фактов (найденные дела, шаги,
 * сроки, её же вопрос) или из словаря бота. Ответ длиннее строки и
 * говорит о найденном полнее — словарь шире: «дальше», «потом»,
 * «подождёт», «ничего не записано», месяцы.
 *
 * О сделанном: прошедшее время глагола из фактов («собрала», «нашла») —
 * можно, открытое сделанным не назовёт страж голоса (`openDeedForms`);
 * «закрыто» — только при сделанном в фактах; «отложила», «поручила»,
 * «отменила» — только при таком состоянии в фактах.
 */
const ANSWER_VOCABULARY: ReadonlySet<string> = new Set(
  [
    'хотела дальше потом затем следующий следующая следующее остается осталось осталась остались',
    'подождет подождут оба обе остальное остальные ближайшее ближайшая ближайший ближайшие время',
    'надо нужно ничего записано говорила да у них нем',
    'января февраля марта апреля мая июня июля августа сентября октября ноября декабря',
    'конце начале середине месяца неделе утром днем вечером',
  ]
    .join(' ')
    .split(' '),
);

/** Слова состояния — правда только при нём же в фактах. */
const STATE_WORDS: ReadonlyMap<string, string> = new Map([
  ['отложила', 'отложено'],
  ['отложено', 'отложено'],
  ['поручила', 'поручено'],
  ['поручено', 'поручено'],
  ['отменила', 'отменено'],
  ['отменено', 'отменено'],
  ['отменен', 'отменено'],
  ['отменена', 'отменено'],
]);

/**
 * «Запись всё ещё открыта» — правда, только если в фактах есть незакрытое
 * (интеграционный тест 22.09.2026); у одних сделанных — неправда.
 */
const OPEN_WORDS: ReadonlySet<string> = new Set(['открыт', 'открыта', 'открыто', 'открыты']);

/**
 * «Ничего не назначено» — речь самого бота (`periodEmpty`: «На вторник
 * ничего не назначено.»), и только с «не» (проверка Никиты 25.09.2026,
 * 20:24: верный ответ «На сегодня ничего не назначено. Завтра — …» сито
 * отвергло из-за одного слова). «Стоматолог назначен на 27.09» — уже
 * запись к врачу, а у человека дело «записаться»: без «не» — нет.
 */
const NEGATED_ONLY: ReadonlySet<string> = new Set(['назначено']);

/**
 * «На сегодня ничего не назначено» — правда, только если на сегодня в
 * фактах пусто: в обзоре нет строки «На сегодня:», у найденного нет срока
 * «сегодня» (`questionFacts` пишет его и с часом: «срок: сегодня, 16:00»).
 * «Ничего не записано» словарь знал и раньше — правило то же. «Больше
 * ничего», «кроме», «только» — о прочем: при делах на сегодня это правда.
 */
const EMPTY_TODAY_WHY = 'на сегодня дела есть, а сказано «ничего»';

function emptyTodayWrongInAnswer(answer: string, factsText: string): boolean {
  const todayInFacts =
    /(?:^|\n)на сегодня:/u.test(factsText) || factsText.includes('срок: сегодня');
  if (!todayInFacts) return false;

  return normalized(answer)
    .split(/[.!?\n]+/u)
    .some(
      (sentence) =>
        /(?<!\p{L})сегодня(?!\p{L})/u.test(sentence) &&
        /(?<!\p{L})не\s+(?:назначено|записано)(?!\p{L})/u.test(sentence) &&
        !/(?<!\p{L})(?:больше|кроме|только)(?!\p{L})/u.test(sentence),
    );
}

/** Есть ли в фактах незакрытое: найденное без «сделано/отменено», обзор или шаги. */
function hasOpen(factsText: string): boolean {
  return factsText
    .split('\n')
    .some(
      (line) =>
        (line.startsWith('— ') && !/— (сделано|отменено)$/u.test(line)) ||
        /^(на сегодня|срок прошел|ближайшие дни|большие цели|неточные сроки|следующий шаг|осталось еще|шаги еще не разложены)/u.test(
          line,
        ),
    );
}

/** Прошедшее время всех глаголов фактов: «Собрать фотографии» → «собрала». */
function pastFormsIn(facts: string): ReadonlySet<string> {
  return new Set(wordsOf(facts).flatMap((word) => pastFormsOf(word)));
}

export function siftAnswer(answer: string, facts: string): SiftedLine {
  const factsText = normalized(facts);
  const factWords = wordsOf(facts);
  const past = pastFormsIn(facts);
  const anyDone = /сделано|все шаги закрыты/u.test(factsText);
  const anyOpen = hasOpen(factsText);
  const words = wordsOf(answer);

  if (pastDeadlineWrongInAnswer(answer, factsText)) {
    return { ok: false, why: PAST_DEADLINE_WHY };
  }
  if (emptyTodayWrongInAnswer(answer, factsText)) {
    return { ok: false, why: EMPTY_TODAY_WHY };
  }

  for (const [index, word] of words.entries()) {
    if (NEGATED_ONLY.has(word)) {
      if (words[index - 1] === 'не') continue;
      return { ok: false, why: `слово не из фактов: ${word}` };
    }
    const state = STATE_WORDS.get(word);
    if (state !== undefined) {
      if (factsText.includes(state)) continue;
      return { ok: false, why: `слово не из фактов: ${word}` };
    }
    if (OPEN_WORDS.has(word)) {
      if (anyOpen) continue;
      return { ok: false, why: `слово не из фактов: ${word}` };
    }
    if (DONE_WORDS.has(word)) {
      if (words[index - 1] === 'не' || anyDone) continue;
      return { ok: false, why: `слово не из фактов: ${word}` };
    }
    if (
      VOCABULARY.has(word) ||
      ANSWER_VOCABULARY.has(word) ||
      past.has(word) ||
      fromFacts(word, factWords)
    ) {
      continue;
    }
    return { ok: false, why: `слово не из фактов: ${word}` };
  }
  return { ok: true };
}
