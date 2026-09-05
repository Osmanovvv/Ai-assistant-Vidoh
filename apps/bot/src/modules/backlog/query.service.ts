import type { Logger } from 'pino';

import type { Item } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { findSimilarItems } from '../embedder/embedder.service.js';
import type { EmbeddingProvider } from '../embedder/providers/types.js';
import { embedText } from '../embedder/embedder.service.js';
import type { ModelPricing } from '../metering/pricing.js';
import { effectiveEnergy, selectForToday } from '../output/filter.js';
import { openItemsFor } from '../items/items.repo.js';
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
}

export interface QueryParams {
  readonly userId: string;
  /** Что человек спросил. */
  readonly text: string;
  readonly batchId?: string | undefined;
  readonly now?: Date | undefined;
}

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
  /** Спрашивали про конкретное дело: что о нём известно. */
  | { readonly kind: 'about'; readonly items: readonly Item[] }
  /** Ничего похожего не нашлось. */
  | { readonly kind: 'nothing' };

/** Сколько записей показывать в ответе: §13.9 просит коротких реплик. */
const MAX_SHOWN = 5;

/** Близость, при которой запись считается ответом на вопрос. */
const RELEVANT = 0.35;

const TODAY_WORDS = ['сегодня', 'на сегодня', 'сейчас', 'ближайшее', 'ближайшие'];

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
  const words = wordsOf(text);

  const times = new Set(TODAY_WORDS.map((word) => word.replace(/ё/gu, 'е')));
  if (!words.some((word) => times.has(word))) return false;

  const frame = new Set(FRAME_WORDS.map((word) => word.replace(/ё/gu, 'е')));

  // Предмет — слово, которое не о времени и не из рамки вопроса.
  return !words.some((word) => !times.has(word) && !frame.has(word));
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

  if (asksAboutToday(params.text)) {
    const context = await outputContextOf(deps.db, params.userId);
    const today = selectForToday(await openItemsFor(deps.db, params.userId), {
      energy: effectiveEnergy(context.state, context.energyDefault, {
        now,
        timeZone: context.timeZone,
      }),
      now,
      timeZone: context.timeZone,
    });

    return today.length === 0 ? { kind: 'nothing' } : { kind: 'today', items: today };
  }

  if (deps.embedder === undefined) return { kind: 'nothing' };

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
      },
      {
        text: params.text,
        purpose: 'query',
        userId: params.userId,
        ...(params.batchId === undefined ? {} : { batchId: params.batchId }),
      },
    );
  } catch (error) {
    deps.logger?.warn({ err: error }, 'Вектор вопроса не посчитан, отвечать нечем');
    return { kind: 'nothing' };
  }

  const similar = await findSimilarItems(deps.db, {
    userId: params.userId,
    vector,
    limit: MAX_SHOWN * 2,
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

  return { kind: 'about', items: found };
}
