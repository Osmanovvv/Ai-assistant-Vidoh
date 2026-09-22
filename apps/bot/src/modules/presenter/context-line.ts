import {
  requestStructured,
  type AiClientDeps,
  type StructuredOutcome,
  type StructuredRequest,
} from '../ai/client.js';
import { PRESENTER_V2_SCHEMA_NAME, type PresenterLine } from '../ai/schemas/index.js';
import { forbiddenPhraseIn, picturesIn } from '../../texts/rules.js';
import { renderContextPack, type ContextPack } from './context-pack.js';

/**
 * Живая строка поверх ответа на выгрузку (22.09.2026, слой A).
 *
 * Заказчица 21.09.2026: бот «не живой, негибкий, шаблонный… чтобы он
 * помнил из контекста, что это за женщина». Ответ на выгрузку собирает
 * код по её же образцу («Всё, забрала. Записала 6 дел…»), и это остаётся.
 * Модель пишет **одну-две фразы поверх**: то, что показывает — бот
 * помнит, что у неё есть, и уже что-то сделал за неё. Контекст ей даёт
 * `context-pack.ts` закрытым списком фактов.
 *
 * **Промпт — просьба, страж — правило.** До 16.09 модель писала признание
 * и написала «у тебя шесть дел, все обычные» — оценку, которую заказчица
 * прямо запретила. Поэтому каждая строка проходит проверку кодом: §13.7
 * (запреты), §13.9 (один вопрос на обмен — здесь ни одного), её текст о
 * характере (без советов, без «вы», без мужского рода), и **сверку с
 * фактами**: число или день недели, которых нет в контексте, — выдумка,
 * а выдуманная дата — худшее, что бот может сказать о делах. Строка не
 * прошла — ответ уходит как прежде, без неё. Хуже сегодняшнего быть не
 * может по построению.
 */

export type CheckedLine =
  { readonly ok: true; readonly line: string } | { readonly ok: false; readonly why: string };

const MAX_LINE = 240;
const MAX_SENTENCES = 2;

/** Слова, которыми код открывает ответ; строка с них — повтор. */
const OPENING = /^(всё,?\s*забрала|записала|поймала|разложила|поняла,?\s*забрала)/iu;
/** Совет и понукание — «не заставляет женщину организовывать». */
const ADVICE =
  /(?<!\p{L})(попробуй|постарайся|советую|рекомендую|не забудь|не забывай|стоит\s+(сделать|начать|заняться)|пора|придётся|придется)(?!\p{L})/iu;
/** «Надо/нужно» — понукание в строке без вопроса; в ответе на вопрос — её же слова. */
const MUST = /(?<!\p{L})(надо|нужно)(?!\p{L})/iu;
/** «Жду» от себя — давление: ждёт дело, а не бот (второй проход 22.09.2026). */
const PRESSURE = /(?<!\p{L})(жду|ждём|ждем|ждала|дожидаюсь)(?!\p{L})/iu;
/** Упрёк — «так и не», «до сих пор не», «опять не»: её правило «без упрёка». */
const REPROACH =
  /(?<!\p{L})(так и не|до сих пор не|опять не|снова не|всё ещё не сделал\p{L}*)(?!\p{L})/iu;
/** «Помнишь», «знаешь» — говорить за неё; помнит бот (третий проход 22.09.2026). */
const FOR_HER = /(?<!\p{L})(помнишь|знаешь|видишь|понимаешь|записывалась|записалась)(?!\p{L})/iu;
/** Канцелярит и язык таск-менеджера — «не таск-менеджер» из её текста. */
const OFFICE = /(?<!\p{L})(просрочен|выгрузк|статус|категори|задач)\p{L}*(?!\p{L})/giu;
/** Обещания и планы за неё — «не заставляет организовывать». */
const PROMISE = /(?<!\p{L})(разбер[её]мся|сделаем|успеем|справимся|займ[её]мся)(?!\p{L})/iu;
/** Оценка — «не оценивает»: «не забыла», «умница» и прочее сверх FORBIDDEN. */
const PRAISE = /(?<!\p{L})(не\s+забыла|умница|отлично|здорово|молодчина)(?!\p{L})/iu;
const YOU_PLURAL = /(?<!\p{L})(вы|вас|вам|вами|ваш|ваша|ваше|ваши|вашу|вашей|вашего)(?!\p{L})/iu;
const MASCULINE_SELF =
  /(?<!\p{L})(понял|услышал|записал|запомнил|забрал|разложил|поймал|увидел)(?!\p{L})/iu;
const WEEKDAY =
  /(?<!\p{L})(понедельник|вторник|сред[аыуе]|четверг|пятниц|суббот|воскресень)\p{L}*/iu;
/**
 * Родня и звери — только те, что названы в фактах (бой 22.09.2026): в
 * факте «забрать ребёнка пораньше», в строке «про сына помню». Догадка,
 * кто ребёнок, у заказчицы будет ошибкой на ровном месте. Основа слова
 * из строки должна встречаться в фактах.
 *
 * Окончания перечислены, а не `\p{L}*`: иначе «который» — кот,
 * «брать» — брат, «мужчина» — муж, «другой» — друг.
 */
const PERSONS: readonly (readonly [stem: string, endings: string])[] = [
  ['сын', 'а|у|ом|е|овья|очк\\p{L}*'],
  ['доч', 'ь|ка|ки|ке|ку|кой|ери|ерью|ек'],
  ['муж', 'а|у|ем|е|ья|ей|ьям'],
  ['жен', 'а|е|ы|у|ой'],
  ['мам', 'а|е|ы|у|ой|ин\\p{L}*'],
  ['пап', 'а|е|ы|у|ой|ин\\p{L}*'],
  ['сестр', 'а|е|ы|у|ой|[её]нк\\p{L}*'],
  ['брат', 'а|у|ом|е|ья|ьев|ьям|ьями|ик\\p{L}*'],
  ['бабушк', 'а|е|и|у|ой'],
  ['дедушк', 'а|е|и|у|ой'],
  ['свекров', 'ь|и|ью'],
  ['т[её]щ', 'а|е|и|у|ей'],
  ['подруг', 'а|е|и|у|ой'],
  ['реб[её]н', 'ок|ка|ку|ком|ке'],
  ['дет', 'и|ей|ям|ьми|ях|ок|ка|ки|ке'],
  ['кот', 'а|у|ом|е|ы|ов|ам|ами|ах|ик\\p{L}*|[её]нк\\p{L}*'],
  ['кош', 'ка|ки|ке|ку|кой|ек|кам'],
  ['собак', 'а|е|и|у|ой|ам'],
  ['п[её]с', 'а|у|ом|е|ы|ов|ик\\p{L}*'],
];

const PERSON_PATTERNS = PERSONS.map(
  ([stem, endings]) => new RegExp(`(?<!\\p{L})(${stem})(?:${endings})?(?!\\p{L})`, 'giu'),
);
const COUNT_OF_ITEMS =
  /\d+\s+(открыт\p{L}*\s+)?(дел[аоь]?|желани\p{L}*|иде[иейя]\p{L}*|запис\p{L}*)(?!\p{L})/iu;
const NUMBERS = /\d+(?:[:.,]\d+)*/gu;

/**
 * Числа словами перед единицей времени (прогон 22.09.2026): «три дня»,
 * «шестой день», «два часа». Модель скопировала «Три дня тишины» из
 * примера при «5 дней назад» в фактах — цифр не было, страж молчал.
 * Без единицы времени числительное — не срок: «запись одна», «первый раз».
 */
const NUMERAL_STEMS: readonly (readonly [RegExp, number])[] = [
  [/^(одн|перв)/u, 1],
  [/^(дв|втор)/u, 2],
  [/^(тр)/u, 3],
  [/^(четыр|четвёрт|четверт)/u, 4],
  [/^(пят)/u, 5],
  [/^(шест)/u, 6],
  [/^(сед|сем)/u, 7],
  [/^(вос)/u, 8],
  [/^(девят)/u, 9],
  [/^(десят)/u, 10],
];
const NUMERAL_BEFORE_UNIT =
  /(?<!\p{L})(одн\p{L}*|перв\p{L}*|дв\p{L}*|втор\p{L}*|тр[её]\p{L}*|тр[иь]\p{L}*|четыр\p{L}*|четв[её]рт\p{L}*|пят\p{L}*|шест\p{L}*|сед\p{L}*|сем\p{L}*|вос\p{L}*|девят\p{L}*|десят\p{L}*)\s+(день|дня|дней|недел\p{L}*|час\p{L}*|минут\p{L}*|месяц\p{L}*)(?!\p{L})/giu;

function spelledNumbersBeforeUnits(
  line: string,
): { readonly word: string; readonly value: number }[] {
  const found: { word: string; value: number }[] = [];
  for (const match of line.matchAll(NUMERAL_BEFORE_UNIT)) {
    const word = (match[1] ?? '').toLowerCase().replace(/ё/gu, 'е');
    const stem = NUMERAL_STEMS.find(([pattern]) => pattern.test(word));
    if (stem !== undefined) found.push({ word: match[1] ?? '', value: stem[1] });
  }
  return found;
}

/** Числа фактов — по цифрам: «6 дней», «5 дней назад», «21:00» → 6, 5, 21, 0. */
function numbersIn(facts: string): Set<number> {
  return new Set((facts.match(/\d+/gu) ?? []).map(Number));
}

function sentencesIn(text: string): number {
  return text.split(/[.!…]+(?:\s+|$)/u).filter((piece) => piece.trim() !== '').length;
}

/** Пределы текста от модели: у строки одни, у ответа на вопрос другие. */
export interface VoiceLimits {
  readonly maxLength: number;
  readonly maxSentences: number;
  /** Сколько знаков вопроса допустимо: у строки ноль, у ответа один (§13.9). */
  readonly maxQuestions: number;
  /** Слова открытия ответа — повтор; у ответа на вопрос открытия нет. */
  readonly forbidOpening: boolean;
  /** «Надо/нужно» допустимы: в ответе на вопрос это её слова, не понукание. */
  readonly allowMust?: boolean | undefined;
}

const LINE_LIMITS: VoiceLimits = {
  maxLength: MAX_LINE,
  maxSentences: MAX_SENTENCES,
  maxQuestions: 0,
  forbidOpening: true,
};

/**
 * Проверка строки кодом. `facts` — тот же текст, что ушёл модели: числа и
 * дни недели в строке обязаны в нём быть.
 */
export function checkContextLine(raw: string, facts: string): CheckedLine {
  return checkVoice(raw, facts, LINE_LIMITS);
}

/**
 * Общие правила голоса бота для всего, что пишет модель (её текст о
 * характере, §13.7, §13.9, сверка с фактами). Живая строка и живой ответ
 * на вопрос (слой B) проверяются одним стражем с разными пределами.
 */
export function checkVoice(raw: string, facts: string, limits: VoiceLimits): CheckedLine {
  const line = raw
    .replace(/\s*\n+\s*/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (line === '') return { ok: false, why: 'пусто' };
  if (line.length > limits.maxLength) return { ok: false, why: 'длинно' };
  const questions = (line.match(/\?/gu) ?? []).length;
  if (questions > limits.maxQuestions) {
    return { ok: false, why: limits.maxQuestions === 0 ? 'вопрос' : 'два вопроса' };
  }
  if (/!{2,}/u.test(line)) return { ok: false, why: 'восклицания' };
  if (sentencesIn(line) > limits.maxSentences) {
    return {
      ok: false,
      why: limits.maxSentences === 2 ? 'больше двух предложений' : 'больше трёх предложений',
    };
  }

  const forbidden = forbiddenPhraseIn(line);
  if (forbidden !== undefined) return { ok: false, why: `запрет: ${forbidden}` };
  if (ADVICE.test(line)) return { ok: false, why: 'совет' };
  if (limits.allowMust !== true && MUST.test(line)) return { ok: false, why: 'совет' };
  if (PRESSURE.test(line)) return { ok: false, why: 'давление' };
  if (FOR_HER.test(line)) return { ok: false, why: 'за неё' };
  if (REPROACH.test(line)) return { ok: false, why: 'упрёк' };
  // Канцелярит — кроме слова из её же записи: «сдать задачу по математике».
  for (const match of line.matchAll(OFFICE)) {
    const stem = (match[1] ?? '').toLowerCase().replace(/ё/gu, 'е');
    if (!facts.toLowerCase().replace(/ё/gu, 'е').includes(stem)) {
      return { ok: false, why: 'канцелярит' };
    }
  }
  if (PROMISE.test(line)) return { ok: false, why: 'обещание' };
  if (PRAISE.test(line)) return { ok: false, why: 'оценка' };
  if (picturesIn(line).length > 0) return { ok: false, why: 'эмодзи' };
  if (limits.forbidOpening && OPENING.test(line)) return { ok: false, why: 'повторяет открытие' };
  if (COUNT_OF_ITEMS.test(line)) return { ok: false, why: 'повторяет счёт' };
  if (YOU_PLURAL.test(line)) return { ok: false, why: 'на вы' };
  if (MASCULINE_SELF.test(line)) return { ok: false, why: 'мужской род' };

  for (const number of line.match(NUMBERS) ?? []) {
    if (!facts.includes(number)) return { ok: false, why: `число не из фактов: ${number}` };
  }
  const known = numbersIn(facts);
  for (const spelled of spelledNumbersBeforeUnits(line)) {
    if (!known.has(spelled.value)) {
      return { ok: false, why: `число не из фактов: ${spelled.word.toLowerCase()}` };
    }
  }
  const factsLower = facts.toLowerCase().replace(/ё/gu, 'е');
  for (const pattern of PERSON_PATTERNS) {
    for (const match of line.matchAll(pattern)) {
      const stem = (match[1] ?? '').toLowerCase().replace(/ё/gu, 'е');
      if (!factsLower.includes(stem)) {
        return { ok: false, why: `человек не из фактов: ${match[0].toLowerCase()}` };
      }
    }
  }
  const weekday = WEEKDAY.exec(line);
  if (weekday !== null && !new RegExp(weekday[1] ?? '', 'iu').test(facts)) {
    return { ok: false, why: 'день недели не из фактов' };
  }

  return { ok: true, line };
}

export interface ContextLineParams {
  readonly pack: ContextPack;
  /** В бою — всегда; стенд (`check-voice.ts`) зовёт без выгрузки. */
  readonly userId?: string | undefined;
  readonly batchId?: string | undefined;
}

export interface ContextLineOutcome {
  readonly line?: string | undefined;
  /** Почему строки нет: «пусто» — сказать нечего, остальное — в журнал. */
  readonly why?: string | undefined;
  /** Что написала модель, когда страж отверг: стенду — для правки промпта. */
  readonly rejected?: string | undefined;
}

/** Обращение к модели — подменяется в тестах; в бою `requestStructured`. */
export type AskStructured = (
  deps: AiClientDeps,
  request: StructuredRequest,
) => Promise<StructuredOutcome<PresenterLine>>;

/** Ответ модели — короткий; лимит ниже цены одной длинной ошибки. */
const MAX_TOKENS = 200;

/**
 * Спросить строку и проверить. Никогда не бросает: строка — украшение,
 * а ответ с разбором человек ждёт в любом случае.
 */
export async function askContextLine(
  deps: AiClientDeps,
  params: ContextLineParams,
  ask: AskStructured = requestStructured,
): Promise<ContextLineOutcome> {
  const facts = renderContextPack(params.pack);

  try {
    /**
     * Активен промпт первой версии (признание) — модель не зовётся: она
     * ответила бы по чужой схеме, и деньги ушли бы на два захода впустую.
     * Так бывает между выкладкой кода и заливкой промпта.
     */
    const active = await deps.prompts.get('presenter');
    if (active.schemaName !== PRESENTER_V2_SCHEMA_NAME) {
      const why = 'промпт презентера не второй версии';
      deps.logger?.warn({ version: active.version, schema: active.schemaName }, why);
      return { why };
    }

    const outcome = await ask(deps, {
      stage: 'presenter',
      input: facts,
      userId: params.userId,
      batchId: params.batchId,
      maxTokens: MAX_TOKENS,
    });
    if (!outcome.ok) {
      deps.logger?.info(
        { batchId: params.batchId, problem: outcome.problem },
        'Живая строка не получена',
      );
      return { why: outcome.problem };
    }

    const checked = checkContextLine(outcome.value.line, facts);
    if (!checked.ok) {
      if (checked.why !== 'пусто') {
        deps.logger?.info(
          { batchId: params.batchId, why: checked.why, line: outcome.value.line },
          'Живая строка отвергнута стражем',
        );
      }
      return checked.why === 'пусто'
        ? { why: checked.why }
        : { why: checked.why, rejected: outcome.value.line };
    }

    return { line: checked.line };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    deps.logger?.warn({ batchId: params.batchId, err: error }, 'Живая строка: модель не ответила');
    return { why };
  }
}
