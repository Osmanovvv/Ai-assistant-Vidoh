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
  /(?<!\p{L})(попробуй|постарайся|советую|рекомендую|не забудь|не забывай|стоит\s+(сделать|начать|заняться)|надо|нужно|пора|придётся|придется)(?!\p{L})/iu;
/** «Жду» от себя — давление: ждёт дело, а не бот (второй проход 22.09.2026). */
const PRESSURE = /(?<!\p{L})(жду|ждём|ждем|ждала|дожидаюсь)(?!\p{L})/iu;
/** «Помнишь», «знаешь» — говорить за неё; помнит бот (третий проход 22.09.2026). */
const FOR_HER = /(?<!\p{L})(помнишь|знаешь|видишь|понимаешь|записывалась|записалась)(?!\p{L})/iu;
/** Канцелярит и язык таск-менеджера — «не таск-менеджер» из её текста. */
const OFFICE = /(?<!\p{L})(просрочен\p{L}*|выгрузк\p{L}*|статус\p{L}*|категори\p{L}*)(?!\p{L})/iu;
/** Обещания и планы за неё — «не заставляет организовывать». */
const PROMISE = /(?<!\p{L})(разбер[её]мся|сделаем|успеем|справимся|займ[её]мся)(?!\p{L})/iu;
/** Оценка — «не оценивает»: «не забыла», «умница» и прочее сверх FORBIDDEN. */
const PRAISE = /(?<!\p{L})(не\s+забыла|умница|отлично|здорово|молодчина)(?!\p{L})/iu;
const YOU_PLURAL = /(?<!\p{L})(вы|вас|вам|вами|ваш|ваша|ваше|ваши|вашу|вашей|вашего)(?!\p{L})/iu;
const MASCULINE_SELF =
  /(?<!\p{L})(понял|услышал|записал|запомнил|забрал|разложил|поймал|увидел)(?!\p{L})/iu;
const WEEKDAY =
  /(?<!\p{L})(понедельник|вторник|сред[аыуе]|четверг|пятниц|суббот|воскресень)\p{L}*/iu;
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

/**
 * Проверка строки кодом. `facts` — тот же текст, что ушёл модели: числа и
 * дни недели в строке обязаны в нём быть.
 */
export function checkContextLine(raw: string, facts: string): CheckedLine {
  const line = raw
    .replace(/\s*\n+\s*/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (line === '') return { ok: false, why: 'пусто' };
  if (line.length > MAX_LINE) return { ok: false, why: 'длинно' };
  if (line.includes('?')) return { ok: false, why: 'вопрос' };
  if (/!{2,}/u.test(line)) return { ok: false, why: 'восклицания' };
  if (sentencesIn(line) > MAX_SENTENCES) return { ok: false, why: 'больше двух предложений' };

  const forbidden = forbiddenPhraseIn(line);
  if (forbidden !== undefined) return { ok: false, why: `запрет: ${forbidden}` };
  if (ADVICE.test(line)) return { ok: false, why: 'совет' };
  if (PRESSURE.test(line)) return { ok: false, why: 'давление' };
  if (FOR_HER.test(line)) return { ok: false, why: 'за неё' };
  if (OFFICE.test(line)) return { ok: false, why: 'канцелярит' };
  if (PROMISE.test(line)) return { ok: false, why: 'обещание' };
  if (PRAISE.test(line)) return { ok: false, why: 'оценка' };
  if (picturesIn(line).length > 0) return { ok: false, why: 'эмодзи' };
  if (OPENING.test(line)) return { ok: false, why: 'повторяет открытие' };
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
