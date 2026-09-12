import type { Logger } from 'pino';

import type { Item } from '../../db/schema.js';
import { isOwnOutage } from '../../infra/errors.js';
import type { Database } from '../../infra/db.js';
import { findSimilarItems } from '../embedder/embedder.service.js';
import type { EmbeddingProvider } from '../embedder/providers/types.js';
import type { SpendGuard } from '../metering/spend-guard.js';
import { embedText } from '../embedder/embedder.service.js';
import type { ModelPricing } from '../metering/pricing.js';
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';

import { items } from '../../db/schema.js';
import { localDateParts, startOfDayAfter, startOfDayInZone } from '../classifier/dates.js';
import { SEARCHABLE_STATUSES } from '../embedder/embedder.service.js';
import { selectForToday } from '../output/filter.js';
import { openItemsFor, openItemsWhere } from '../items/items.repo.js';
import { outputContextOf } from '../users/state.repo.js';

/**
 * Вопрос по бэклогу (§13.4 ТЗ, задача 3.10).
 *
 * «Напомни, что я хотела сделать с альбомом», «что там с днём рождения»,
 * «что на сегодня». Бот отвечает тем, что уже знает.
 *
 * **Главное правило здесь — не создать ничего.** §13.4: «ответ на вопрос
 * по бэклогу не создаёт записей и не предлагает новых действий, если об
 * этом не просили». Человек спросил, а получил три новых дела — это не
 * ответ, а встречное требование.
 *
 * **Модель не участвует.** Вопрос «что там с альбомом» — это поиск по
 * своим записям, и отвечать на него должен поиск, а не пересказ. Модель
 * добавила бы к ответу выдумку, а к каждому вопросу — рубль и секунды.
 */

export interface QueryDeps {
  readonly db: Database;
  readonly embedder?: EmbeddingProvider | undefined;
  readonly pricing?: Readonly<Record<string, ModelPricing>> | undefined;
  readonly logger?: Logger | undefined;
  /**
   * Страж расхода (задача 3.82).
   *
   * Вопрос по бэклогу считает вектор — это платный вызов. Без стража он
   * шёл мимо потолка: тот останавливал модель, а векторы продолжали
   * тратиться до самого отказа провайдера.
   */
  readonly spendGuard?: SpendGuard | undefined;
}

export interface QueryParams {
  readonly userId: string;
  /** Что человек спросил. */
  readonly text: string;
  readonly batchId?: string | undefined;
  readonly now?: Date | undefined;
  /**
   * Сфера ветки, из которой пришёл вопрос (§8.1; ревизия этапа 3, F4).
   *
   * «Что там у меня?» внутри ветки «здоровье» — вопрос про здоровье, а
   * не про весь бэклог. Без ветки — по всему.
   */
  readonly topic?: string | undefined;
}

/** О каком дне спросили, кроме сегодняшнего (ревизия этапа 3, F2). */
export type AskedPeriod = 'tomorrow' | 'weekend' | 'week';

export type BacklogAnswer =
  /**
   * Спрашивали про большую цель: где мы в ней (§21 п.6).
   *
   * Отдельный вид ответа, а не список записей: у проекта человек
   * спрашивает не «что записано», а «где мы».
   */
  | { readonly kind: 'project'; readonly item: Item }
  /** Спрашивали про сегодня: список дел на сегодня. */
  | { readonly kind: 'today'; readonly items: readonly Item[] }
  /**
   * Спрашивали про завтра, выходные или неделю (ревизия этапа 3, F2):
   * дела со сроком в этом отрезке. Раньше такие вопросы уходили в
   * смысловой поиск по словам «что на завтра» и получали «ничего не
   * записано» при трёх делах на завтра.
   */
  | { readonly kind: 'period'; readonly period: AskedPeriod; readonly items: readonly Item[] }
  | { readonly kind: 'periodEmpty'; readonly period: AskedPeriod }
  /**
   * Спрашивали про дело, которое записано, но закрыто, убрано или ушло в
   * фон (ревизия этапа 3, F1). «Ничего не записано» здесь было ложью:
   * записано — и бот сам вчера его закрыл по нажатию «сделано».
   */
  | { readonly kind: 'aboutClosed'; readonly items: readonly Item[] }
  /**
   * Спрашивали про сегодня, а на сегодня пусто (ревизия этапа 3, E16).
   *
   * Отдельный вид, а не `nothing`: «ничего не записано» — утверждение
   * о всех делах человека, а у него тридцать записей на следующую
   * неделю. Ответ тот же, что у кнопки «Сегодня».
   */
  | { readonly kind: 'todayEmpty' }
  /** Спрашивали про конкретное дело: что о нём известно. */
  | { readonly kind: 'about'; readonly items: readonly Item[] }
  /** Ничего похожего не нашлось. */
  | { readonly kind: 'nothing' }
  /**
   * Посмотреть не удалось: вектор вопроса не посчитался.
   *
   * Отдельный вид ответа, а не `nothing`. «Ничего не записано» — это
   * утверждение о делах человека, и говорить его, не заглянув в них,
   * значит соврать про существующую запись.
   */
  | { readonly kind: 'unavailable' };

/** Сколько записей показывать в ответе: §13.9 просит коротких реплик. */
const MAX_SHOWN = 5;

/** Близость, при которой запись считается ответом на вопрос. */
const RELEVANT = 0.35;

const TODAY_WORDS = ['сегодня', 'на сегодня', 'сейчас', 'ближайшее', 'ближайшие'];

/** Слова о другом дне — каждое ведёт к своему отрезку (F2). */
const PERIOD_WORDS: Readonly<Record<string, AskedPeriod>> = {
  завтра: 'tomorrow',
  выходные: 'weekend',
  выходных: 'weekend',
  неделе: 'week',
  неделю: 'week',
  неделя: 'week',
};

/**
 * Слова, из которых состоит сам вопрос, а не его предмет (задача 3.66).
 *
 * **Найдено живым прогоном проджекта 04.09.2026.** Он спросил: «Что у меня
 * сейчас есть по сайту и что мне нужно сделать по нему в ближайшее время?»
 * — и получил список дел на сегодня, где про сайт была одна строка из
 * девяти. Предмет вопроса бот не посмотрел вовсе.
 *
 * Причина: в списке слов про сегодня стоят «сейчас» и «ближайшее». Они
 * там не зря — «что сейчас?» и «что в ближайшее время?» это правда вопрос
 * про сегодня. Но те же слова стоят и внутри вопроса о предмете, и одного
 * их присутствия мало.
 *
 * **Различение простое: вопрос про сегодня — тот, в котором кроме слова о
 * времени нет предмета.** Список закрытый и держится узким намеренно:
 * лишнее слово здесь превращает вопрос о предмете в список на сегодня, то
 * есть возвращает ровно тот дефект.
 */
const FRAME_WORDS = [
  'что',
  'чего',
  'какие',
  'какой',
  'какая',
  'кто',
  'у',
  'меня',
  'мне',
  'мной',
  'есть',
  'нужно',
  'надо',
  'сделать',
  'делать',
  'по',
  'нему',
  'ней',
  'ним',
  'этому',
  'это',
  'в',
  'на',
  'за',
  'и',
  'а',
  'ещё',
  'еще',
  'там',
  'вообще',
  'время',
  'времени',
  'планы',
  'план',
  'запланировано',
  'дела',
  'делах',
  'дело',
  'список',
  'покажи',
  'напомни',
  'скажи',
  'плане',
  'помню',
  'помнишь',
  'знаешь',
  // «На этой неделе», «на эти выходные» — указание, а не предмет.
  'этой',
  'эти',
  'эту',
  'ближайшую',
  'ближайшей',
];

function wordsOf(text: string): readonly string[] {
  return text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .split(/[^\p{L}]+/u)
    .filter((word) => word.length > 0);
}

/**
 * Спрашивают про сегодняшний день, а не про конкретное дело.
 *
 * Два условия, и второе появилось из живого прогона (задача 3.66):
 * слово о времени есть, а предмета — нет. «Что на сегодня?» и «Что у меня
 * сейчас?» спрашивают про день; «Что у меня сейчас по сайту?» — про сайт,
 * и отвечать на него списком дел на сегодня значит не ответить.
 */
export function asksAboutToday(text: string): boolean {
  return askedDay(text) === 'today';
}

/**
 * О каком дне спросили — или ни о каком (тогда это вопрос про дело).
 *
 * Правило одно на «сегодня» и остальные дни (F2): слово о времени есть,
 * а предмета — нет. «Что на завтра?» — про завтра; «что завтра по сайту?»
 * — про сайт.
 */
export function askedDay(text: string): 'today' | AskedPeriod | undefined {
  const words = wordsOf(text);

  const today = new Set(TODAY_WORDS.map((word) => word.replace(/ё/gu, 'е')));
  const period = words.map((word) => PERIOD_WORDS[word]).find((one) => one !== undefined);
  const isToday = words.some((word) => today.has(word));
  if (!isToday && period === undefined) return undefined;

  const frame = new Set(FRAME_WORDS.map((word) => word.replace(/ё/gu, 'е')));
  const isTime = (word: string): boolean => today.has(word) || word in PERIOD_WORDS;

  // Предмет — слово, которое не о времени и не из рамки вопроса.
  if (words.some((word) => !isTime(word) && !frame.has(word))) return undefined;

  return period ?? 'today';
}

/**
 * Дела со сроком в отрезке дня (F2): завтра — один день, выходные —
 * ближайшие суббота и воскресенье, неделя — семь дней от сегодня.
 * Только точные сроки: «около 15.09» на конкретный день не ложится.
 */
async function itemsInPeriod(
  db: Database,
  params: {
    readonly userId: string;
    readonly period: AskedPeriod;
    readonly now: Date;
    readonly timeZone: string;
    readonly topic?: string | undefined;
  },
): Promise<Item[]> {
  const { now, timeZone } = params;
  const todayStart = startOfDayInZone(localDateParts(now, timeZone), timeZone);

  let from: Date;
  let to: Date;
  if (params.period === 'tomorrow') {
    from = startOfDayAfter(now, 1, timeZone);
    to = startOfDayAfter(now, 2, timeZone);
  } else if (params.period === 'week') {
    from = todayStart;
    to = startOfDayAfter(now, 7, timeZone);
  } else {
    // День недели местной даты: суббота — 6, воскресенье — 0. В субботу и
    // воскресенье «выходные» — эти; в будни — ближайшие.
    const parts = localDateParts(now, timeZone);
    const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    const untilSaturday = weekday === 0 ? -1 : 6 - weekday;
    from = startOfDayAfter(now, untilSaturday, timeZone);
    to = startOfDayAfter(now, untilSaturday + 2, timeZone);
  }

  return await db
    .select()
    .from(items)
    .where(
      and(
        openItemsWhere(params.userId),
        eq(items.deadlineAccuracy, 'day'),
        gte(items.deadlineAt, from),
        lt(items.deadlineAt, to),
        params.topic === undefined ? undefined : eq(items.topic, params.topic),
      ),
    )
    .orderBy(asc(items.deadlineAt));
}

/**
 * Отвечает на вопрос по бэклогу.
 *
 * Ничего не пишет в базу — ни записи, ни черновика, ни вопроса. Это не
 * осторожность, а требование §13.4, и проверяется оно счётчиком.
 */
export async function answerBacklogQuery(
  deps: QueryDeps,
  params: QueryParams,
): Promise<BacklogAnswer> {
  const now = params.now ?? new Date();

  const day = askedDay(params.text);

  if (day === 'today') {
    const context = await outputContextOf(deps.db, params.userId);
    const today = selectForToday(await openItemsFor(deps.db, params.userId), {
      now,
      timeZone: context.timeZone,
    }).filter((item) => params.topic === undefined || item.topic === params.topic);

    // Пустой день — не «ничего не записано» (ревизия этапа 3, E16):
    // записи есть, просто не на сегодня.
    return today.length === 0 ? { kind: 'todayEmpty' } : { kind: 'today', items: today };
  }

  if (day !== undefined) {
    const context = await outputContextOf(deps.db, params.userId);
    const listed = await itemsInPeriod(deps.db, {
      userId: params.userId,
      period: day,
      now,
      timeZone: context.timeZone,
      topic: params.topic,
    });

    return listed.length === 0
      ? { kind: 'periodEmpty', period: day }
      : { kind: 'period', period: day, items: listed };
  }

  // «Ничего не записано» без взгляда в записи — ложь (ревизия этапа 3, F3):
  // без провайдера векторов посмотреть нечем.
  if (deps.embedder === undefined) return { kind: 'unavailable' };

  /**
   * Вектор вопроса, а не его слова.
   *
   * «Что там с днём рождения» и «Не забыть поздравить Любу с днём
   * рождения» общих слов почти не имеют, а речь об одном.
   */
  let vector: readonly number[];
  try {
    vector = await embedText(
      {
        db: deps.db,
        provider: deps.embedder,
        ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        ...(deps.pricing === undefined ? {} : { pricing: deps.pricing }),
        ...(deps.spendGuard === undefined ? {} : { spendGuard: deps.spendGuard }),
        /**
         * Один заход, а не три.
         *
         * Вопрос интерактивный: человек ждёт ответа прямо сейчас. Три
         * попытки по таймауту в полминуты с паузами — это полторы минуты
         * тишины перед честным «не смогла заглянуть». Прежняя неправда
         * была быстрой; правда не должна быть медленной настолько.
         */
        retry: { attempts: 1 },
      },
      {
        text: params.text,
        purpose: 'query',
        userId: params.userId,
        ...(params.batchId === undefined ? {} : { batchId: params.batchId }),
      },
    );
  } catch (error) {
    /**
     * Не посчитали вектор — значит не посмотрели, а не «ничего нет».
     *
     * Сюда приходит и наш простой — перейдённый потолок расхода, 403 от
     * провайдера, — и обычный отказ вектора. Прежде всё это отвечало
     * «Про это у меня ничего не записано»: наш сбой становился
     * утверждением о записях человека, а единственный его читатель — сам
     * человек, и проверить это ему нечем. Партия при этом закрывается
     * успешной, повтора не будет, и ответ остаётся навсегда.
     *
     * В журнале — те же слова, что были, плюс опознаватели: жалоба
     * приходит от конкретного человека в конкретное время, а привязать к
     * нему строку было нечем. `ownOutage` — тем же предикатом, которым
     * конвейер решает судьбу выгрузки: разбирающему надо отличить
     * «кончились деньги или доступ» от «провайдер моргнул», а второе
     * правило для этого однажды разошлось бы с первым.
     */
    deps.logger?.warn(
      {
        err: error,
        userId: params.userId,
        batchId: params.batchId,
        ownOutage: isOwnOutage(error),
      },
      'Вектор вопроса не посчитан: человеку сказано, что посмотреть не вышло',
    );

    return { kind: 'unavailable' };
  }

  const similar = await findSimilarItems(deps.db, {
    userId: params.userId,
    vector,
    limit: MAX_SHOWN * 2,
    // И закрытое тоже: про него спрашивают так же, как про открытое (F1).
    statuses: [...SEARCHABLE_STATUSES, 'done', 'cancelled'],
    ...(params.topic === undefined ? {} : { topic: params.topic }),
  });

  const relevant = similar.filter((candidate) => candidate.similarity >= RELEVANT);
  if (relevant.length === 0) return { kind: 'nothing' };

  const ids = new Set(relevant.slice(0, MAX_SHOWN).map((candidate) => candidate.id));
  const open = await openItemsFor(deps.db, params.userId);
  const found = open.filter((item) => ids.has(item.id));

  /**
   * Если самое близкое — большая цель, отвечаем про неё целиком.
   *
   * «Что там с днём рождения» — вопрос не о том, что записано, а о том,
   * где мы. Список из одной строки «Спланировать день рождения» на такой
   * вопрос не отвечает вовсе.
   */
  const best = relevant[0];
  const project = found.find((item) => item.id === best?.id && item.isProject);
  if (project !== undefined) return { kind: 'project', item: project };

  /**
   * Нашлось, но показать нечего — значит «ничего», а не пустой список.
   *
   * Найдено ревизией второго этапа. Смысловой поиск и «открытые записи»
   * смотрят на **разные** наборы: поиск берёт и отложенные, и ушедшие в
   * фон, а `openItemsFor` их не отдаёт и держит потолок по свежести.
   * Пересечение поэтому бывает пустым при непустом поиске — и человек
   * получал «Вот что у меня про это записано:» и ничего после
   * двоеточия.
   *
   * Пути до этого житейские: нажал «Отложить» под карточкой и спросил
   * «что там с садиком»; начал с чистого листа — §13.6 требует, чтобы
   * такие записи остались доступными; или записи просто старше потолка.
   *
   * Честное «ничего не записано» человек поймёт, а шапку в пустоту
   * прочтёт как поломку — и будет прав.
   */
  if (found.length === 0) {
    /**
     * Нашлось, но не среди открытых — значит закрыто, убрано или ушло в
     * фон (F1). Это не «ничего»: человек спрашивает «что там с тортом»,
     * а торт вчера сам закрыл кнопкой. Ему называется запись и её
     * состояние. Старше потолка свежести — тот же ответ: запись есть.
     */
    const closed = await deps.db
      .select()
      .from(items)
      .where(and(eq(items.userId, params.userId), inArray(items.id, [...ids])))
      .orderBy(asc(items.updatedAt));

    return closed.length === 0 ? { kind: 'nothing' } : { kind: 'aboutClosed', items: closed };
  }

  return { kind: 'about', items: found };
}
