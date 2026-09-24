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
 * открывает «подарок». «Осеннему» из «осень» так не сложить, и это
 * нарочно: подробность, которой в фактах нет.
 */
function fromFacts(word: string, facts: readonly string[]): boolean {
  if (word.length <= 3) return facts.some((fact) => fact.startsWith(word));
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
