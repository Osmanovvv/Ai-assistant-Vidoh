import {
  requestStructured,
  type AiClientDeps,
  type StructuredOutcome,
  type StructuredRequest,
} from '../ai/client.js';
import { SPLITTER_SCHEMA_NAME, type SplitterReply } from '../ai/schemas/index.js';
import { withCapital } from '../items/item-text.js';
import { isStrictInfinitive } from './split-actions.js';

/**
 * Покупки позициями (правка заказчицы 29.09.2026): «Купить овощи, мясо и
 * специи» — «разбить на позиции: овощи, мясо, специи», в ветке отдельными
 * строками.
 *
 * **Где отдельные покупки, решает модель, а проверяет код.** Код видит
 * только запятые: «овощи, мясо и специи» и «подарок маме, папе и бабушке»
 * для него одинаковы, а второе — одна покупка на троих. Модель называет
 * позиции словами самого дела (`purchase-split.ask.ts`); код принимает
 * ответ, только если позиции — дословные куски списка по порядку, между
 * ними одни разделители и ничего не потеряно (`checkedPositions`). Иначе
 * — одно дело, как раньше: хуже, чем было, стать не может.
 */

const PURCHASE = /^\s*(купить|докупить|прикупить|закупить|заказать)\s+(.+?)[\s.!]*$/iu;
/** Перечисление: запятая или «и» между словами. */
const LISTED = /,|\s+и\s+/u;

export interface PurchaseList {
  /** Глагол как в деле: «Купить». */
  readonly verb: string;
  /** Что купить: «овощи, мясо и специи». */
  readonly list: string;
}

/**
 * Дело — покупка со списком: начинается с глагола покупки и перечисляет.
 * Второй глагол в списке — уже не покупки («Купить хлеб и забрать
 * посылку»): такое сюда не идёт.
 */
export function purchaseList(text: string): PurchaseList | undefined {
  const match = PURCHASE.exec(text);
  const verb = match?.[1];
  const list = match?.[2];
  if (verb === undefined || list === undefined || !LISTED.test(list)) return undefined;
  const words = list.match(/\p{L}+/gu) ?? [];
  if (words.some((word) => isStrictInfinitive(word))) return undefined;
  return { verb, list };
}

/** Между позициями — только разделители: «,», «и», «, а также», «плюс». */
const SEPARATOR =
  /^\s*(?:,\s*(?:(?:и|а также|а ещё|а еще|ещё|еще|плюс)\s+)?|и\s+|а также\s+|плюс\s+)\s*$/iu;

const folded = (text: string): string => text.toLowerCase().replace(/ё/gu, 'е');

/**
 * Одно прилагательное — не вещь: «масло сливочное и подсолнечное» →
 * «подсолнечное» (замер лёгкой модели 30.09.2026), «зелёный и чёрный чай»
 * → «зелёный». Предмет у них общий, деление его теряет.
 */
const ADJECTIVE = /(?:ый|ий|ой|ая|яя|ое|ее|ые|ие|ую|юю|ого|его|ому|ему|ым|им|ых|их)$/u;
/** Слова с окончанием прилагательного, которые сами называют вещь. */
const NAMED_THINGS = new Set([
  'мороженое',
  'пирожное',
  'пирожные',
  'шампанское',
  'сладкое',
  'жаркое',
  'заливное',
]);

/** Количество впереди — часть самой вещи: «2 бутылки воды», «пакет молока». */
const QUANTITY = new Set([
  'пакет',
  'пакета',
  'пачку',
  'пачки',
  'бутылку',
  'бутылки',
  'коробку',
  'коробки',
  'банку',
  'банки',
  'десяток',
  'кг',
  'литр',
  'литра',
  'литров',
  'упаковку',
  'упаковки',
  'пару',
  'штуки',
  'штук',
  'рулон',
  'рулона',
  'мешок',
  'кусок',
]);

/**
 * Общее уточнение в конце (замер полной модели 30.09.2026): «носки и
 * трусы сыну» → «носки» и «трусы сыну» — «сыну» относится к обоим, а
 * деление приклеивает его к последнему. Так же «подарок и открытку
 * маме», «шарики и свечи на день рождения». Признак: все позиции, кроме
 * последней, — одно слово, а у последней после предмета стоят ещё слова
 * (впереди не прилагательное и не количество — те часть вещи: «цветную
 * бумагу», «2 бутылки воды»). Цена — промах там, где уточнение своё
 * («такси и столик в ресторане»): дело остаётся одним, как было.
 */
function sharedTail(positions: readonly string[]): boolean {
  const words: readonly (readonly string[])[] = positions.map((position) =>
    Array.from(folded(position).match(/[\p{L}\d]+/gu) ?? []),
  );
  const last = words.at(-1) ?? [];
  const head = last[0];
  if (head === undefined || last.length < 2) return false;
  if (!words.slice(0, -1).every((one) => one.length === 1)) return false;
  return !ADJECTIVE.test(head) && !QUANTITY.has(head) && !/^\d/u.test(head);
}

function loneAdjective(position: string): boolean {
  const words = folded(position).match(/\p{L}+/gu) ?? [];
  const [word] = words;
  return (
    words.length === 1 && word !== undefined && ADJECTIVE.test(word) && !NAMED_THINGS.has(word)
  );
}

/**
 * Позиции от модели — если это честное деление списка: не меньше двух,
 * дословные (регистр и «ё» не в счёт) куски по порядку, без запятых
 * внутри и не одно прилагательное, между ними одни разделители, после
 * последней — ничего, и нет общего уточнения в конце (`sharedTail`). Берутся
 * слова самого дела, а не модели. Не так — ничего: одно дело.
 */
export function checkedPositions(
  list: string,
  positions: readonly string[],
): readonly string[] | undefined {
  if (positions.length < 2) return undefined;
  const haystack = folded(list);
  const taken: string[] = [];
  let cursor = 0;
  for (const [index, raw] of positions.entries()) {
    const position = raw.trim();
    if (position === '' || position.includes(',') || loneAdjective(position)) return undefined;
    const at = haystack.indexOf(folded(position), cursor);
    if (at < 0) return undefined;
    const gap = list.slice(cursor, at);
    if (index === 0 ? gap.trim() !== '' : !SEPARATOR.test(gap)) return undefined;
    taken.push(list.slice(at, at + position.length));
    cursor = at + position.length;
  }
  return list.slice(cursor).trim() === '' && !sharedTail(taken) ? taken : undefined;
}

/** Названия позиций: «Купить овощи», «Купить мясо». */
export function purchaseTitles(verb: string, positions: readonly string[]): readonly string[] {
  return positions.map((position) => withCapital(`${verb.toLowerCase()} ${position}`));
}

export type AskSplitter = (
  deps: AiClientDeps,
  request: StructuredRequest,
) => Promise<StructuredOutcome<SplitterReply>>;

/** Позиций в ответе немного: полсотни знаков на каждую с запасом. */
const MAX_TOKENS = 200;

/**
 * Названия позиций для покупки со списком — или ничего: дело остаётся
 * одним. Модель зовётся только для кандидата (`purchaseList`); её ответ
 * принимается, только если прошёл проверку (`checkedPositions`). Никогда
 * не бросает. В журнал — числа, а не слова человека.
 */
export async function askPurchaseTitles(
  deps: AiClientDeps,
  params: {
    readonly text: string;
    readonly userId?: string | undefined;
    readonly batchId?: string | undefined;
  },
  ask: AskSplitter = requestStructured,
): Promise<readonly string[] | undefined> {
  const listed = purchaseList(params.text);
  if (listed === undefined) return undefined;
  try {
    const active = await deps.prompts.get('splitter');
    if (active.schemaName !== SPLITTER_SCHEMA_NAME) {
      deps.logger?.warn(
        { version: active.version, schema: active.schemaName },
        'Промпт покупок позициями не той схемы',
      );
      return undefined;
    }

    const outcome = await ask(deps, {
      stage: 'splitter',
      input: `Дело: ${params.text}`,
      userId: params.userId,
      batchId: params.batchId,
      maxTokens: MAX_TOKENS,
    });
    if (!outcome.ok) {
      deps.logger?.info(
        { batchId: params.batchId, problem: outcome.problem },
        'Покупки позициями: модель не ответила',
      );
      return undefined;
    }

    const positions = outcome.value.positions;
    if (positions.length === 0) return undefined;
    const checked = checkedPositions(listed.list, positions);
    if (checked === undefined) {
      deps.logger?.info(
        { batchId: params.batchId, positions: positions.length },
        'Покупки позициями: ответ модели не прошёл проверку, дело одно',
      );
      return undefined;
    }
    return purchaseTitles(listed.verb, checked);
  } catch (error) {
    deps.logger?.warn(
      { batchId: params.batchId, err: error },
      'Покупки позициями: модель не ответила',
    );
    return undefined;
  }
}

interface Purchasable {
  readonly text: string;
  readonly type: string;
  readonly isProject: boolean;
  readonly unclearTime?: readonly [number, number] | undefined;
}

/**
 * Записи после классификации, где покупка со списком — позиции с теми же
 * полями и пометкой `purchaseOf`: из какого дела вышли (подтверждение
 * «Записала в «Покупки»: Купить овощи, мясо и специи.» остаётся одной
 * строкой, как у заказчицы). Не делятся — и модель к ним не зовётся —
 * проект, не-дело, дело с вопросом «утро или вечер» и не список покупок.
 */
export async function splitPurchases<T extends Purchasable>(
  items: readonly T[],
  titlesOf: (text: string) => Promise<readonly string[] | undefined>,
): Promise<(T & { readonly purchaseOf?: string })[]> {
  const result: (T & { readonly purchaseOf?: string })[] = [];
  for (const item of items) {
    const eligible =
      item.type === 'TASK' &&
      !item.isProject &&
      item.unclearTime === undefined &&
      purchaseList(item.text) !== undefined;
    const titles = eligible ? await titlesOf(item.text) : undefined;
    if (titles === undefined || titles.length < 2) {
      result.push(item);
      continue;
    }
    for (const text of titles) result.push({ ...item, text, purchaseOf: item.text });
  }
  return result;
}
