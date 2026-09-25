import type { Logger } from 'pino';

import type { Item } from '../../db/schema.js';
import type { TextProfile } from '../../texts/types.js';
import { isOwnOutage } from '../../infra/errors.js';
import type { Database } from '../../infra/db.js';
import { findSimilarItems } from '../embedder/embedder.service.js';
import type { EmbeddingProvider } from '../embedder/providers/types.js';
import type { SpendGuard } from '../metering/spend-guard.js';
import { embedText } from '../embedder/embedder.service.js';
import type { ModelPricing } from '../metering/pricing.js';
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, ne } from 'drizzle-orm';

import { batches, items } from '../../db/schema.js';
import { SEARCHABLE_STATUSES } from '../embedder/embedder.service.js';
import { selectForToday, selectOverdue } from '../output/filter.js';
import { openItemsFor, openItemsWhere } from '../items/items.repo.js';
import { withCapital } from '../items/item-text.js';
import { listTopics, normalizeTopicName } from '../topics/topics.repo.js';
import { outputContextOf } from '../users/state.repo.js';
import { askedList, asksAboutEverything, type ListQuestion } from './list-questions.js';
import { askedDay, type AskedPeriod, doneWindow, periodLabel, periodWindow } from './periods.js';
import { FRAME_WORDS, normalizeText, wordsOf } from './question-words.js';
import { asksWhenOfUnnamed } from './when-unnamed.js';
import { DEFAULT_THRESHOLDS } from '../resolver/decision.js';
import { lastDiscussed } from '../resolver/deixis.repo.js';

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

export {
  askedDay,
  asksAboutToday,
  periodLabel,
  periodWindow,
  type AskedPeriod,
} from './periods.js';

/** Что за список спросили: признак из `askedList` или сфера человека. */
export type ListedQuestion =
  | Exclude<ListQuestion, { readonly kind: 'count' } | { readonly kind: 'pick' }>
  | { readonly kind: 'byTopic'; readonly topic: string };

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
  /** На сегодня пусто; `open` — сколько дел открыто вообще (находка 21). */
  | { readonly kind: 'todayEmpty'; readonly open: number }
  /** Спрашивали про конкретное дело: что о нём известно. */
  | { readonly kind: 'about'; readonly items: readonly Item[] }
  /**
   * «На когда» без названного дела, а о каком шла речь — не понять: разговора
   * не было, он давно или был о нескольких делах (проверка Никиты
   * 25.09.2026, 20:23). «Ничего не записано» здесь — неправда о записях.
   */
  | { readonly kind: 'whichItem' }
  /** Спрашивали обо всём сразу («покажи все мои задачи»): открытые дела. */
  | { readonly kind: 'all'; readonly items: readonly Item[] }
  /** Обо всём — а записей нет: «пусто», а не «ничего не записано» про предмет. */
  | { readonly kind: 'allEmpty' }
  /**
   * Список по признаку (21.09.2026): просрочено, на потом, без срока, что
   * записала, что сделала, по виду записи, по сфере. Пустой список — тоже
   * ответ: «Просроченного нет» — утверждение о делах, и оно верно.
   */
  | { readonly kind: 'listed'; readonly question: ListedQuestion; readonly items: readonly Item[] }
  /** «Сколько у меня дел»: открытые дела и раскладка по трём признакам. */
  | {
      readonly kind: 'count';
      readonly open: number;
      readonly today: number;
      readonly overdue: number;
      readonly later: number;
    }
  /** «С чего начать» — то же, что кнопка «Выбрать главное»; выбирает конвейер. */
  | { readonly kind: 'pick' }
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

/** Вопрос обо всём сразу — в `question-words.ts`, рядом с рамкой. */
export { asksAboutEverything };

/**
 * Дела со сроком в отрезке (F2): окно — `periodWindow`. Только сроки,
 * которые в окно ложатся: «около 15.09» на конкретный день не ложится.
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
  const { from, to } = periodWindow(params.period, { now, timeZone });

  /**
   * Неточные сроки — тоже в окне, если их период в нём начинается
   * (прогон 18.09.2026): «на неделе с 21.09» — на ближайшей неделе, а
   * «в октябре» — нет. У «завтра» и «выходных» окно короче недели, и
   * неделя в него не помещается — там только точные дни: «завтра» — день.
   * Окно от недели и длиннее — «на месяц», «на 10 дней» — вмещает и то и
   * другое.
   */
  const weekMs = 7 * 24 * 60 * 60_000;
  const accuracies: ('day' | 'week' | 'month')[] =
    to.getTime() - from.getTime() >= weekMs ? ['day', 'week', 'month'] : ['day'];

  return await db
    .select()
    .from(items)
    .where(
      and(
        openItemsWhere(params.userId),
        inArray(items.deadlineAccuracy, accuracies),
        gte(items.deadlineAt, from),
        lt(items.deadlineAt, to),
        params.topic === undefined ? undefined : eq(items.topic, params.topic),
      ),
    )
    .orderBy(asc(items.deadlineAt));
}

/** Шапка списка по признаку: со списком или для пустого — из текстов. */
export function listHeader(
  question: ListedQuestion,
  empty: boolean,
  texts: TextProfile['backlog'],
): string {
  switch (question.kind) {
    case 'overdue':
      return empty ? texts.overdueEmpty : texts.overdue;
    case 'later':
      return empty ? texts.laterEmpty : texts.later;
    case 'undated':
      return empty ? texts.undatedEmpty : texts.undated;
    case 'recent':
      if (question.scope === 'today') return empty ? texts.recentTodayEmpty : texts.recentToday;
      return empty ? texts.recentLastEmpty : texts.recentLast;
    case 'done': {
      const label =
        question.period === 'today'
          ? texts.labelToday
          : question.period === 'yesterday'
            ? texts.labelYesterday
            : periodLabel(question.period, texts);
      return empty ? texts.doneEmpty(label) : texts.done(label);
    }
    case 'byType':
      if (question.type === 'DESIRE') return empty ? texts.desiresEmpty : texts.desires;
      if (question.type === 'IDEA') return empty ? texts.ideasEmpty : texts.ideas;
      return empty ? texts.goalsEmpty : texts.goals;
    case 'byTopic': {
      const name = withCapital(question.topic);
      return empty ? texts.byTopicEmpty(name) : texts.byTopic(name);
    }
  }
}

/** Открытые дела — только дела: желания и замыслы «делами» не зовут. */
function tasksOf(open: readonly Item[]): Item[] {
  return open.filter((item) => item.type === 'TASK');
}

/** Записи списка по признаку — из открытых или из базы, где нужно прошлое. */
async function listedItems(
  db: Database,
  params: QueryParams,
  question: Exclude<ListQuestion, { readonly kind: 'count' } | { readonly kind: 'pick' }>,
  open: readonly Item[],
  day: { readonly now: Date; readonly timeZone: string },
): Promise<readonly Item[]> {
  switch (question.kind) {
    case 'overdue':
      return selectOverdue(tasksOf(open), day);
    case 'later':
      return tasksOf(open).filter((item) => item.deferredAt !== null);
    case 'undated':
      return tasksOf(open).filter((item) => item.deadlineAt === null);
    case 'byType':
      return open.filter((item) =>
        question.type === 'goal' ? item.isProject : item.type === question.type,
      );
    case 'recent':
      return await recentItems(db, params, question.scope, day);
    case 'done': {
      const { from, to } = doneWindow(question.period, day);
      return await db
        .select()
        .from(items)
        .where(
          and(
            eq(items.userId, params.userId),
            eq(items.isDraft, false),
            eq(items.status, 'done'),
            isNotNull(items.completedAt),
            gte(items.completedAt, from),
            lt(items.completedAt, to),
            params.topic === undefined ? undefined : eq(items.topic, params.topic),
          ),
        )
        .orderBy(asc(items.completedAt));
    }
  }
}

/**
 * «Что я сегодня записала» — записи за сегодняшний день в поясе человека;
 * «что последнее записала» — записи последней выгрузки, кроме текущей:
 * текущая — сам вопрос, и её записи не «последние».
 */
async function recentItems(
  db: Database,
  params: QueryParams,
  scope: 'today' | 'last',
  day: { readonly now: Date; readonly timeZone: string },
): Promise<readonly Item[]> {
  const notDraft = and(eq(items.userId, params.userId), eq(items.isDraft, false));

  if (scope === 'today') {
    const { from, to } = periodWindow('days:1', day);
    return await db
      .select()
      .from(items)
      .where(and(notDraft, gte(items.createdAt, from), lt(items.createdAt, to)))
      .orderBy(asc(items.createdAt), asc(items.sourceOrder));
  }

  const rows = await db
    .select({ batchId: items.sourceBatchId, openedAt: batches.openedAt })
    .from(items)
    .innerJoin(batches, eq(batches.id, items.sourceBatchId))
    .where(
      and(
        notDraft,
        isNotNull(items.sourceBatchId),
        params.batchId === undefined ? undefined : ne(items.sourceBatchId, params.batchId),
      ),
    )
    .orderBy(desc(batches.openedAt))
    .limit(1);
  const last = rows[0]?.batchId;
  if (last === null || last === undefined) return [];

  return await db
    .select()
    .from(items)
    .where(and(notDraft, eq(items.sourceBatchId, last)))
    .orderBy(asc(items.createdAt), asc(items.sourceOrder));
}

/** «По работе», «по дому»: сфера человека, названная любым падежом. */
const TOPIC_PHRASE = /(?<!\p{L})(?:по|про|в|из)\s+(?:сфере\s+|сферы\s+)?(\p{L}{3,})(?!\p{L})/gu;

async function askedTopic(db: Database, params: QueryParams): Promise<string | undefined> {
  const normalized = normalizeText(params.text);
  const names = (await listTopics(db, params.userId)).map((topic) => topic.name);
  if (names.length === 0) return undefined;

  const frame = new Set(FRAME_WORDS.map((word) => normalizeText(word)));

  for (const match of normalized.matchAll(TOPIC_PHRASE)) {
    const word = match[1] ?? '';
    const name = names.find((one) => {
      const known = normalizeTopicName(one);
      const stem = known.length >= 4 ? known.slice(0, -1) : known;
      return word === known || word.startsWith(stem);
    });
    if (name === undefined) continue;

    // Сверх сферы — только рамка вопроса; иначе это вопрос про предмет.
    const rest = normalized.replace(match[0], ' ');
    if (wordsOf(rest).every((one) => frame.has(one))) return name;
  }

  return undefined;
}

/**
 * Отвечает на вопрос по бэклогу.
 *
 * Ничего не пишет в базу — ни записи, ни черновика, ни вопроса. Это не
 * осторожность, а требование §13.4, и проверяется оно счётчиком.
 */
/** Дела, о которых ответ: разговор после него — о них (проверка Никиты 25.09.2026). */
export function answeredItemIds(answer: BacklogAnswer): readonly string[] {
  if ('items' in answer) return answer.items.map((item) => item.id);
  if (answer.kind === 'project') return [answer.item.id];
  return [];
}

export async function answerBacklogQuery(
  deps: QueryDeps,
  params: QueryParams,
): Promise<BacklogAnswer> {
  const now = params.now ?? new Date();

  const day = askedDay(params.text);

  /**
   * Обо всём сразу — список открытых дел без поиска и без вектора: платить
   * за вопрос, в котором нет предмета, не за что. Внутри ветки — её сфера
   * (§8.1), как и у остальных видов.
   */
  if (asksAboutEverything(params.text)) {
    const everything = (await openItemsFor(deps.db, params.userId)).filter(
      (item) => params.topic === undefined || item.topic === params.topic,
    );

    return everything.length === 0 ? { kind: 'allEmpty' } : { kind: 'all', items: everything };
  }

  if (day === 'today') {
    const context = await outputContextOf(deps.db, params.userId);
    const open = (await openItemsFor(deps.db, params.userId)).filter(
      (item) => params.topic === undefined || item.topic === params.topic,
    );
    const today = selectForToday(open, { now, timeZone: context.timeZone });

    // Пустой день — не «ничего не записано» (ревизия этапа 3, E16):
    // записи есть, просто не на сегодня. Сколько их — с ответом: без
    // этого «ничего срочного» человек с шестью делами читал как «у тебя
    // ничего нет» (скрины заказчицы 16.09.2026, находка 21).
    return today.length === 0
      ? { kind: 'todayEmpty', open: open.length }
      : { kind: 'today', items: today };
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

  /**
   * Списки по признаку (21.09.2026): без вектора и без поиска — признак
   * назван словами, платить не за что. Порядок после отрезков и «обо
   * всём»: те рамки уже проверены и не подошли.
   */
  const list = askedList(params.text);
  if (list !== undefined) {
    if (list.kind === 'pick') return { kind: 'pick' };

    const context = await outputContextOf(deps.db, params.userId);
    const day = { now, timeZone: context.timeZone };
    const open = (await openItemsFor(deps.db, params.userId)).filter(
      (item) => params.topic === undefined || item.topic === params.topic,
    );

    if (list.kind === 'count') {
      const tasks = open.filter((item) => item.type === 'TASK');
      return {
        kind: 'count',
        open: tasks.length,
        today: selectForToday(tasks, day).length,
        overdue: selectOverdue(tasks, day).length,
        later: tasks.filter((item) => item.deferredAt !== null).length,
      };
    }

    return {
      kind: 'listed',
      question: list,
      items: await listedItems(deps.db, params, list, open, day),
    };
  }

  const topic = await askedTopic(deps.db, params);
  if (topic !== undefined) {
    const open = (await openItemsFor(deps.db, params.userId)).filter(
      (item) => normalizeTopicName(item.topic ?? '') === normalizeTopicName(topic),
    );
    return { kind: 'listed', question: { kind: 'byTopic', topic }, items: open };
  }

  /**
   * «На когда» без названного дела — про последнее обсуждённое (проверка
   * Никиты 25.09.2026, 20:23): «Что там со стоматологом?» → «На когда» →
   * было «Про это у меня ничего не записано». Дело — то же, что у «это» в
   * правках (`lastDiscussed`, окно свежести), ровно одно и открытое;
   * иначе — переспрос, а не поиск по смыслу: искать в «на когда» нечего.
   */
  if (params.batchId !== undefined && asksWhenOfUnnamed(params.text)) {
    const discussed = await lastDiscussed(deps.db, {
      userId: params.userId,
      batchId: params.batchId,
      now,
      windowMs: DEFAULT_THRESHOLDS.freshMinutes * 60_000,
    });
    const only = discussed.length === 1 ? discussed[0] : undefined;
    const open =
      only === undefined
        ? []
        : await deps.db
            .select()
            .from(items)
            .where(and(openItemsWhere(params.userId), eq(items.id, only.id)))
            .limit(1);
    return open.length === 1 ? { kind: 'about', items: open } : { kind: 'whichItem' };
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
