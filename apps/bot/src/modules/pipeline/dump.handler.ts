import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import type { Logger } from 'pino';

import { itemRevisions, items, userSettings, type Batch, type Item } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { textsFor } from '../../texts/index.js';
import { fallbackOf } from '../../texts/rules.js';
import { recordMisunderstood } from '../misunderstood/misunderstood.repo.js';
import type { AiClientDeps } from '../ai/client.js';
import { markTrialSpent, mayParseDump } from '../billing/subscription.service.js';
import type { SettingsRegistry } from '../settings/settings.repo.js';
import { decideDegradation, type SpendLimit } from '../metering/limits.js';
import type { ClassifiedItems } from '../ai/schemas/classifier.js';
import type { ExtractedUnits } from '../ai/schemas/extractor.js';
import { classifyUnits, type ClassifiedItem } from '../classifier/classifier.service.js';
import { retractionEchoes } from '../classifier/retraction-echo.js';
import { embedText } from '../embedder/embedder.service.js';
import type { EmbeddingProvider } from '../embedder/providers/types.js';
import { extractUnits } from '../extractor/extractor.service.js';
import {
  answerBacklogQuery,
  type BacklogAnswer,
  listHeader,
  periodLabel,
} from '../backlog/query.service.js';
import { askLiveAnswer, questionFacts } from '../backlog/live-answer.js';
import { PAGE_SIZE } from '../backlog/backlog.service.js';
import { decomposeIfNeeded } from '../projects/decomposer.service.js';
import { describeProject } from '../projects/project-text.js';
import { stepButtons } from '../projects/project-actions.js';
import { contextOf, withNextSteps, type ProjectContext } from '../projects/projects.service.js';
import { openItemsFor, saveDraft, saveItems, type ItemToSave } from '../items/items.repo.js';
import { knownByText, splitKnown } from '../items/same-text.js';
import {
  aboutPending,
  changeButtons,
  describeChange,
  questionButtons,
  questionText,
  unchangedText,
} from '../resolver/change-text.js';
import { settlePendingQuestion } from '../resolver/pending.js';
import { CLARIFY_REASON, clarifiedCommand } from '../resolver/clarify.js';
import { closeClarification, openClarification } from '../resolver/clarify.repo.js';
import { datesInWords, rhythmInWords, suggestButtons } from '../recurrence/suggest-text.js';
import { suggestRecurrence } from '../recurrence/suggest.service.js';
import { openQuestionOf } from '../resolver/questions.repo.js';
import type { Applied } from '../resolver/patch.js';
import { resolvePatchSegment, type SegmentResult } from '../resolver/segment.js';
import { selectForOutput, type SelectionResult } from '../output/filter.js';
import {
  firstStep,
  onboardingStateOf,
  questionFor,
  setStep,
  STEP,
} from '../onboarding/onboarding.service.js';
import {
  ANSWER_ACTION,
  buildActionsReply,
  composeOf,
  feelingsOnlyReply,
  presentDump,
} from '../presenter/presenter.service.js';
import { askContextLine } from '../presenter/context-line.js';
import { mentionedIn, packContext } from '../presenter/context-pack.js';
import { loadContextFacts, markLineMentions } from '../presenter/context-pack.repo.js';
import { moodOf } from '../presenter/mood.js';
import { summarizeDump } from '../presenter/summary.js';
import { saysThanks } from '../presenter/thanks.js';
import { deadlineWords } from '../items/deadline-words.js';
import { titleUnderDayHeader, withCapital } from '../items/item-text.js';
import { showFirstReminderCard } from '../scheduler/first-reminder-card.js';
import { RETURNING_ACTION } from '../returning/returning-actions.js';
import { toShortId } from '../shared/short-id.js';
import { returningAfterPause } from '../returning/returning.service.js';
import { isQuickAdd } from '../presenter/quick-add.js';
import { reembedIfRetitled } from '../embedder/reembed.js';
import { revertRevision } from '../resolver/revisions.repo.js';
import { layoutMyTasks, renderMyTasks, SINGLE_LIMIT } from '../backlog/my-tasks.js';
import { topicsFor } from '../topics/topics.repo.js';
import { topicByThread } from '../topics/topics.service.js';
import { looksLikeHelpRequest, looksLikeUndoRequest } from './bot-words.js';
import { looksLikeDayClosing } from './day-closing.js';
import { isRecordCommand, weaveForExtraction } from './patch-in-place.js';
import type { QuestionSender } from '../presenter/telegram-sender.js';
import {
  finishStatus,
  finishWithCard,
  showStatus,
  type StatusButton,
  type StatusSender,
  type StatusTarget,
} from '../presenter/status.service.js';
import type { CardName, CardSender } from '../cards/cards.js';
import { routeIntents, type Segment } from '../router/router.service.js';
import {
  detectByMarkers,
  detectCrisis,
  type CrisisContour,
  type CrisisOutcome,
} from '../safety/crisis.js';
import { pickMain, rememberMentioned } from '../presenter/pick.service.js';
import { adoptWantedTopics } from '../topics/adopt.js';
import type { TopicGateway } from '../topics/gateway.js';
import { refreshSummaries } from '../topics/summary.service.js';
import { settleTopics } from '../topics/ensure.js';
import { outputContextOf } from '../users/state.repo.js';
import type { BatchHandler } from './pipeline.service.js';
import { applyThreadTopic } from './thread-topic.js';
import { statusTarget, transcribeBatch, type TranscribeDeps } from './transcribe.js';
import { titleWithoutDate } from '../resolver/title-date.js';
import { autoDeferReviewed, markReviewed, reviewDue } from '../review/review.service.js';
import { reviewRows } from '../scheduler/digest.js';

/**
 * Разбор выгрузки целиком: от звука до ответа человеку.
 *
 * Здесь связывается всё, что было построено по отдельности на задачах
 * 2.4–2.11: расшифровка, маршрутизатор намерений, извлечение единиц,
 * классификация, смысловые представления, сохранение, отбор действий и
 * ответ по §13.2.
 *
 * **Порядок отказов важнее порядка шагов.** На каждом шаге спрашивается
 * одно: потеряется ли текст человека, если дальше не пойдёт. Пока ответ
 * «нет» — идём дальше; как только «да» — сохраняем черновик и отвечаем
 * тем, что есть. §9 ТЗ запрещает терять сообщения, §17 разрешает
 * сохранять их неразобранными.
 *
 * **На этом этапе разбираются только новые мысли.** Правка сказанного,
 * отметка выполнения, отмена и вопрос по бэклогу требуют резолвера, а он
 * приходит на третьем этапе (§7). До тех пор такие части выгрузки
 * сохраняются черновиком и ждут: превратить «хотя нет, в пятницу» в
 * задачу «в пятницу» было бы хуже, чем не разобрать её вовсе.
 */

/** Заголовок записи: он подставляется в текст открытого вопроса (§7.3). */
async function titleOfItem(db: Database, itemId: string): Promise<string | undefined> {
  const [row] = await db.select({ text: items.text }).from(items).where(eq(items.id, itemId));
  return row?.text;
}

/** Намерения, которые этап 2 разбирает сам. */
const PARSED_INTENTS = new Set(['DUMP']);

/** Сколько строк списка называть голосом — столько же, сколько на странице кнопки «Сегодня». */
const SPOKEN_LIST_LIMIT = PAGE_SIZE;

/** Предел Telegram на подпись к фото: длиннее — итог идёт текстом. */
const CAPTION_LIMIT = 1_024;

/**
 * Намерения, с которыми работает резолвер (§7 ТЗ, задача 3.6а).
 *
 * До третьего этапа они уходили в черновик с пометкой «ждёт резолвера».
 * Резолвер появился — значит пора звать.
 *
 * `QUERY` сюда не входит: вопрос по бэклогу — не правка записи, у него
 * своя задача 3.10.
 */
const RESOLVED_INTENTS = new Set(['PATCH', 'COMPLETE', 'CANCEL']);

/**
 * Вопрос по бэклогу (§13.4, задача 3.10).
 *
 * Отвечается тем, что уже известно, и **ничего не создаёт** — ни записи,
 * ни черновика. Человек спросил, а получил три новых дела: это не ответ,
 * а встречное требование.
 */
const QUERY_INTENT = 'QUERY';

/**
 * Намерения, которые ничего не создают и ничего не ждут.
 *
 * «Привет» и «спасибо» не мысли и не дела. Черновик из них был бы мусором
 * в админке, а §13.9 требует от бота короткой реплики, а не разбора.
 */
const IGNORED_INTENTS = new Set(['SMALLTALK']);

/**
 * Ответ на уточняющий вопрос (§7.3, задача 3.6).
 *
 * Не разбирается как мысль и не уходит в черновик: это реплика про
 * открытый вопрос, а не дело. Без отдельной ветки «да, к прошлой»
 * превратилось бы в запись «да».
 */
const ANSWER_INTENT = 'ANSWER';

/**
 * Что видел конвейер на каждом этапе — для стенда набора (20.09.2026).
 *
 * Стенд шесть раз мерил не то, что работает в бою, и всякий раз потому,
 * что собирал вход для модели сам. Теперь он гонит случай через этот
 * же обработчик, а внутренности — отрезки маршрутизатора, вход
 * извлечения с единицами, сырой ответ классификации и записи после
 * правок кода — узнаёт отсюда. Наблюдатель только смотрит: ни одно
 * событие ничего не меняет, и без наблюдателя обработчик идёт как шёл.
 */
export type PipelineEvent =
  | { readonly kind: 'routed'; readonly segments: readonly Segment[] }
  | {
      readonly kind: 'extracted';
      /** Вход извлечения: отрезки `DUMP`, как их получила модель. */
      readonly dumpText: string;
      readonly units: readonly ExtractedUnits['units'][number][];
    }
  | {
      readonly kind: 'classified';
      /** Ответ модели до правок кода. */
      readonly fromModel: readonly ClassifiedItems['items'][number][];
      /** Записи после правок кода — то, что сохраняется. */
      readonly items: readonly ClassifiedItem[];
    };

export type PipelineObserver = (event: PipelineEvent) => void;

export interface DumpHandlerDeps {
  readonly speech: TranscribeDeps;
  /** Стенд набора смотрит на этапы конвейера; в бою не задаётся. */
  readonly observe?: PipelineObserver | undefined;
  /** Полная модель: извлечение, классификация, представление. */
  readonly ai: Omit<AiClientDeps, 'db'>;
  /**
   * Лёгкая модель для маршрутизатора намерений (§7.1, задача 2.4).
   *
   * Отдельный провайдер, а не подмена названия модели в запросе: имя
   * попадает в учёт расхода, и подмена сделала бы себестоимость
   * недостоверной. Если не задана, маршрутизатор идёт на полной.
   */
  readonly aiLight?: Omit<AiClientDeps, 'db'> | undefined;
  /**
   * Мягкий лимит расхода на пользователя (§10.5 ТЗ, задача 2.22).
   *
   * Задан — и при превышении извлечение с классификацией идут на лёгкой
   * модели. Человек этого не замечает (§17): ни отказа, ни
   * предупреждения, ответ приходит как обычно.
   */
  readonly spendLimit?: SpendLimit | undefined;
  /**
   * Бот сам предлагает запомнить регулярность (задача 3.8в).
   *
   * Выключено по умолчанию до калибровки на живых данных: порог «это одно
   * и то же дело» угадать нельзя, а ложное предложение раздражает.
   */
  readonly suggestRecurrence?: boolean | undefined;
  /**
   * Провайдер смысловых представлений. Без него записи сохраняются без
   * векторов: разбор дороже поиска, и терять его из-за эмбеддингов нельзя.
   */
  readonly embedder?: EmbeddingProvider | undefined;
  readonly sender?: StatusSender | undefined;
  /**
   * Бренд-карточки (ТЗ по визуалам, проджект 18.09.2026). Без них
   * сценарии те же, только текстом: карточка — украшение, не суть.
   */
  readonly cards?: CardSender | undefined;
  /**
   * Отправитель вопросов онбординга (§12.2, задача 2.13).
   *
   * Онбординг начинается здесь, а не в обработчике команд, потому что
   * §12.2 привязывает его к первой выгрузке: спрашивать до неё запрещено.
   */
  readonly onboarding?: QuestionSender | undefined;
  /**
   * Ветки личного чата (§8, задачи 2.15 и 2.16).
   *
   * Без него разбор работает целиком, только сводки тем не обновляются —
   * это и есть плоский режим §8.2. Данные от этого не страдают.
   */
  readonly topics?: TopicGateway | undefined;
  /**
   * Реестр значений — ради размера пробного периода (§15, задача 4.4).
   *
   * Нужен ровно для одного: записать вместе с моментом «пробный период
   * кончился» тот **предел**, при котором он кончился. Предел правится из
   * панели без выкладки, истории у настроек нет, и без снимка третий шаг
   * воронки сдвигался бы у всех задним числом при каждой правке.
   *
   * Читается тем же реестром, что и гейт доступа: второй читатель мимо
   * реестра разошёлся бы с первым на разборе мусора и на умолчании.
   *
   * Не задан — момент не пишется, и воронка честно говорит, что третьего
   * шага у неё нет. Так работали все проверки, писавшиеся до 4.4.
   */
  readonly settings?: SettingsRegistry | undefined;
  readonly logger?: Logger | undefined;
  readonly now?: (() => Date) | undefined;
}

/** Ответ человеку. Молча, если отправителя нет — так работают тесты. */
async function reply(
  db: Database,
  deps: DumpHandlerDeps,
  target: StatusTarget | undefined,
  text: string,
  buttons?: readonly StatusButton[],
): Promise<void> {
  if (!deps.sender || !target) return;
  await finishStatus({ db, sender: deps.sender }, target, text, buttons);
}

/** Запоминает темы записи до и после правки: перенос затрагивает обе. */
function rememberTopics(into: Set<string>, applied: Applied): void {
  for (const topic of [applied.before.topic, applied.after.topic]) {
    if (topic !== null && topic.length > 0) into.add(topic);
  }
}

/** Обновляет сводки тронутых тем, если ветки вообще есть. */
/**
 * «Отмени последнее» словами (21.09.2026, список Никиты, п. 13).
 *
 * Откатывается последняя неотменённая ревизия человека — та же, что
 * стоит за кнопкой «Отменить». Но только если она **новее последней
 * выгрузки**: после выгрузки «последнее» — новые записи, а не старая
 * правка, и откатывать её было бы подменой смысла. Тогда человеку
 * говорится, как убрать запись. Ревизий нет — «отменять нечего».
 */
async function undoLastByWords(
  db: Database,
  deps: DumpHandlerDeps,
  batch: Batch,
  context: { readonly timeZone: string; readonly textProfile: string },
): Promise<string> {
  const texts = textsFor(context.textProfile);

  const [revision] = await db
    .select()
    .from(itemRevisions)
    .where(and(eq(itemRevisions.userId, batch.userId), isNull(itemRevisions.revertedAt)))
    .orderBy(desc(itemRevisions.createdAt))
    .limit(1);

  if (revision === undefined) return texts.resolver.nothingToUndo;

  /**
   * Последняя **запись**, а не последнее сообщение: вопросы между правкой
   * и «отмени» записей не создают и последнего не меняют (бой 21.09.2026:
   * три дня вопросов после правки — и «последнее — новые записи»).
   * Текущая выгрузка — сама просьба отменить — не в счёт.
   */
  const [latest] = await db
    .select({ createdAt: items.createdAt })
    .from(items)
    .where(
      and(
        eq(items.userId, batch.userId),
        eq(items.isDraft, false),
        ne(items.sourceBatchId, batch.id),
      ),
    )
    .orderBy(desc(items.createdAt))
    .limit(1);

  if (latest !== undefined && revision.createdAt.getTime() < latest.createdAt.getTime()) {
    return texts.resolver.undoIsRecords;
  }

  const outcome = await revertRevision(db, { revisionId: revision.id, userId: batch.userId });

  if (outcome.kind !== 'reverted') {
    return {
      already: texts.resolver.alreadyUndone,
      gone: texts.resolver.undoGone,
      overtaken: texts.resolver.undoOvertaken,
    }[outcome.kind];
  }

  // Откат вернул прежний заголовок — вектор вслед, как у кнопки (A5).
  await reembedIfRetitled(
    {
      db,
      ...(deps.embedder === undefined ? {} : { provider: deps.embedder }),
      ...(deps.ai.spendGuard === undefined ? {} : { spendGuard: deps.ai.spendGuard }),
      ...(deps.ai.pricing === undefined ? {} : { pricing: deps.ai.pricing }),
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    },
    { after: outcome.item, fields: outcome.fields },
  );

  const target = await statusTarget(db, batch.id);
  await refreshTouched(
    db,
    deps,
    target,
    { userId: batch.userId, timeZone: context.timeZone, textProfile: context.textProfile },
    new Set(outcome.topics),
  );

  deps.logger?.info(
    { userId: batch.userId, revisionId: revision.id },
    'Человек отменил последнее изменение словами',
  );

  return texts.resolver.undoneOf(outcome.item.text);
}

async function refreshTouched(
  db: Database,
  deps: DumpHandlerDeps,
  target: StatusTarget | undefined,
  params: {
    readonly userId: string;
    readonly timeZone: string;
    readonly textProfile: string;
  },
  topics: ReadonlySet<string>,
): Promise<void> {
  if (!deps.topics || !target || topics.size === 0) return;

  await refreshSummaries(
    { db, gateway: deps.topics, logger: deps.logger },
    {
      userId: params.userId,
      chatId: target.chatId,
      topicNames: [...topics],
      timeZone: params.timeZone,
      profile: params.textProfile,
    },
  );
}

/**
 * Вторая и последующие реплики одного разбора — своими сообщениями.
 *
 * `reply` **правит** единственное статусное сообщение выгрузки, и для
 * первой реплики это верно: человек видит, как «Слушаю…» превращается в
 * ответ. Но второй вызов затирает первый.
 *
 * Так пропало подтверждение выполнения вместе с кнопкой отката, когда к
 * нему добавился вопрос сценария 8: человек не видел, что закрылось, и не
 * мог вернуть. Найдено ручным прогоном 31.08.2026 — тесты этого не
 * показывали, потому что фейковый отправитель копил реплики списком, а не
 * правил одну.
 */
/**
 * Разбор вчерашнего отдельным сообщением — тем, у кого утренние
 * выключены (запрос №4). См. вызов в конвейере.
 */
async function reviewAtInteraction(
  db: Database,
  deps: DumpHandlerDeps,
  userId: string,
  target: StatusTarget | undefined,
  timeZone: string,
  now: Date,
): Promise<void> {
  if (deps.onboarding === undefined || target === undefined) return;

  const [settings] = await db
    .select({ notificationsOn: userSettings.notificationsOn })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  if (settings?.notificationsOn !== false) return;

  await autoDeferReviewed(db, { userId, now, timeZone });
  const review = await reviewDue(db, { userId, now, timeZone });
  if (review === undefined) return;

  const texts = textsFor((await outputContextOf(db, userId)).textProfile);
  const lines = [
    review.since === 'yesterday' ? texts.review.headerYesterday : texts.review.headerEarlier,
    ...review.items.map((item, index) => texts.review.line(index + 1, titleWithoutDate(item.text))),
  ];

  const messageId = await deps.onboarding.ask({
    chatId: target.chatId,
    ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
    text: lines.join('\n'),
    rows: reviewRows(texts, review),
  });
  // Не ушло — не показано: покажется в следующий раз.
  if (messageId !== 0) {
    await markReviewed(
      db,
      review.items.map((item) => item.id),
      now,
    );
  }
}

async function alsoSay(
  deps: DumpHandlerDeps,
  target: StatusTarget | undefined,
  text: string,
  buttons?: readonly StatusButton[],
): Promise<void> {
  if (!deps.sender || !target) return;

  await deps.sender.send({
    chatId: target.chatId,
    ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
    text,
    ...(buttons === undefined ? {} : { buttons }),
  });
}

/**
 * Считает векторы для записей.
 *
 * Последовательно, а не разом: двадцать пять одновременных обращений к
 * провайдеру — верный способ получить отказ по частоте, а выгрузка и так
 * идёт десятки секунд.
 *
 * Отказ не роняет разбор. Запись без вектора найдётся хуже, запись
 * несохранённая не найдётся никогда, и досчитать вектор потом можно, а
 * восстановить разбор — нет.
 */
async function withEmbeddings(
  db: Database,
  deps: DumpHandlerDeps,
  batch: Batch,
  classified: readonly ClassifiedItem[],
): Promise<readonly ItemToSave[]> {
  const { embedder } = deps;
  if (!embedder) return classified;

  const result: ItemToSave[] = [];

  for (const item of classified) {
    try {
      const embedding = await embedText(
        {
          db,
          provider: embedder,
          logger: deps.logger,
          pricing: deps.ai.pricing,
          spendGuard: deps.ai.spendGuard,
        },
        { text: item.text, purpose: 'document', userId: batch.userId, batchId: batch.id },
      );
      result.push({ ...item, embedding });
    } catch (error) {
      deps.logger?.warn(
        { err: error, batchId: batch.id },
        'Вектор не посчитан, запись сохраняется без него',
      );
      result.push(item);
    }
  }

  return result;
}

export function createDumpHandler(deps: DumpHandlerDeps): BatchHandler {
  const clock = deps.now ?? ((): Date => new Date());

  return async (db, batch) => {
    const now = clock();

    // Считается всегда, а не только когда есть кому отвечать: из него
    // берётся и ветка, в которой человек написал, и чат для сводок тем.
    const target = await statusTarget(db, batch.id);
    const context = await outputContextOf(db, batch.userId);
    const texts = textsFor(context.textProfile);
    const ai = { ...deps.ai, db };
    const aiLight = { ...(deps.aiLight ?? deps.ai), db };

    const { combined, truncated } = await transcribeBatch(db, batch, deps.speech, {
      onStart: async () => {
        if (!deps.sender || !target) return;
        await showStatus({ db, sender: deps.sender }, target, texts.listening.working);
      },
      // Расшифровка затянулась — сказать, что ждать и не перезаписывать
      // (серия голосовых 18.09.2026, голос 4).
      onSlow: async () => {
        if (!deps.sender || !target) return;
        await showStatus({ db, sender: deps.sender }, target, texts.listening.slow);
      },
      slowAfterMs: deps.speech.slowAfterMs,
    });

    /**
     * Занят ли статусный слот выгрузки.
     *
     * **Статусное сообщение одно, и `finishStatus` его правит.** Значит
     * вторая реплика за одну выгрузку затирает первую — вместе с её
     * кнопками. Один раз это уже поймали ручным прогоном 31.08.2026:
     * вопрос сценария 8 съедал подтверждение выполнения с кнопкой отката.
     * Тогда починили одно место, подставив `alsoSay`.
     *
     * **А случай был общий.** В смешанной выгрузке — правка плюс новые
     * мысли — подтверждение изменения точно так же затиралось итоговым
     * ответом §13.2, и кнопка отката исчезала. Нашлось 01.09.2026, когда
     * чинили 3.24: правка внутри выгрузки наконец стала применяться, и
     * сразу выяснилось, что человек об этом всё равно не узнает.
     *
     * Поэтому решение здесь, а не в каждом месте по отдельности: первая
     * реплика забирает статусное сообщение, каждая следующая уходит
     * своим. Через `reply` больше никто не ходит — забыть это нельзя.
     */
    /**
     * Что уже случилось за эту выгрузку.
     *
     * **Одним объектом, а не четырьмя `let`, и это не косметика.** Флаги
     * ставятся внутри замыканий `tell` и `useOutcome`, а для захваченной
     * переменной TypeScript сужение теряет и считает её навсегда
     * `false` — то есть перестаёт проверять как раз то, ради чего флаг и
     * существует. У поля объекта такого не происходит.
     */
    const happened = {
      /** Сказал ли бот человеку хоть что-то по существу. */
      said: false,
      /** Задан ли вопрос: §13.9 разрешает один на обмен. */
      asked: false,
      /** Закрылось ли хоть одно дело — для вопроса §2 сценария 8. */
      closed: false,
      /** Занят ли статусный слот: вторая реплика уходит своим сообщением. */
      statusTaken: false,
      /**
       * Ушло ли что-то из сказанного в черновик (задача 3.32).
       *
       * Нужно быстрому добавлению: односложным «Записала.» нельзя
       * отвечать на выгрузку, часть которой не разобралась.
       */
      parked: false,
      /**
       * Наш сбой, из-за которого бот сейчас ответит репликой сдачи
       * (заказчица, 16.09.2026, п. 4: «ошибка системы» и «не понял
       * формулировку» — разные вещи). Ставится перед технической
       * репликой — извлечение или классификация не ответили, модель
       * резолвера молчала — и снимается записью в журнал: строка уходит
       * во «Ошибки», а не в «Не поняла». Реплика человеку та же.
       */
      fault: undefined as string | undefined,
    };

    /**
     * Что сказать о припаркованном (ревизия этапа 3, A4).
     *
     * Правка, которая не применилась, уходила в черновик молча: в
     * смешанной выгрузке обычный ответ §13.2 шёл без слова о ней, а без
     * мыслей человек получал «Я здесь. Расскажешь, что в голове?» —
     * реплику, которая читается как «не поняла». Строка подбирается по
     * исходу и произносится один раз, даже если таких правок две.
     */
    const parkedWords: string[] = [];
    const sayParked = (line: string): void => {
      if (!parkedWords.includes(line)) parkedWords.push(line);
    };
    const parkedLine = (
      said: 'unchanged' | 'refused' | 'gone' | 'absent' | 'which' | undefined,
      timeUnclear?: readonly [number, number],
    ): string =>
      said === 'refused'
        ? texts.resolver.deadlineRefused
        : said === 'unchanged'
          ? unchangedText({ timeUnclear }, texts)
          : said === 'which'
            ? texts.resolver.whichRecord
            : said === 'gone'
              ? texts.card.gone
              : said === 'absent'
                ? texts.resolver.nothingToClose
                : texts.answer.patchParked;

    const tell = async (text: string, buttons?: readonly StatusButton[]): Promise<void> => {
      /**
       * Сдача — в журнал непонятого (заказчица, 16.09.2026, панель п. 3).
       *
       * У самой отправки, а не в местах сдачи: их с десяток по конвейеру,
       * и новое однажды забыли бы записать. Реплика узнаётся по словарю с
       * правками из панели; слова человека — выгрузка целиком, ответ —
       * как ушёл. Журнал не обязан мешать ответу: не записалось — ответ
       * всё равно уходит.
       */
      const fallback = fallbackOf(text, texts);
      if (fallback !== undefined) {
        const fault = happened.fault;
        happened.fault = undefined;
        try {
          await recordMisunderstood(db, {
            userId: batch.userId,
            batchId: batch.id,
            said: combined,
            replied: text,
            reason: fault === undefined ? fallback.path : `${fallback.path}: ${fault}`,
            kind: fault === undefined ? fallback.kind : 'system',
          });
        } catch (error: unknown) {
          deps.logger?.warn({ err: error, batchId: batch.id }, 'Журнал непонятого не записался');
        }
      }

      if (happened.statusTaken) {
        await alsoSay(deps, target, text, buttons);
        return;
      }

      happened.statusTaken = true;
      await reply(db, deps, target, text, buttons);
    };

    /**
     * Обычный ответ, к которому договаривается предупреждение об обрезке
     * (§10.5 ТЗ).
     *
     * Отдельной репликой это не отправляется: одна выгрузка — один ответ.
     * И к кризисной реплике не договаривается тоже: там человеку не до
     * длины записи (§13.7).
     */
    /**
     * Карточка вместо текстового итога (ТЗ по визуалам 18.09.2026).
     *
     * Ложь — карточки нет, отправить не вышло или подпись длиннее предела
     * Telegram на подпись к фото: тогда вызывающий код говорит то же
     * текстом. Удалась — слот занят, дальнейшее уходит своими сообщениями.
     */
    const showCard = async (
      card: CardName,
      caption: string,
      buttons?: readonly StatusButton[],
    ): Promise<boolean> => {
      if (!deps.cards || !deps.sender || !target || caption.length > CAPTION_LIMIT) return false;

      const shown = await finishWithCard(
        { db, sender: deps.sender, cards: deps.cards },
        target,
        card,
        caption,
        buttons,
      );
      if (shown) happened.said = true;
      if (shown) happened.statusTaken = true;
      return shown;
    };

    const answer = async (text: string, buttons?: readonly StatusButton[]): Promise<void> => {
      const tail = `\n\n${texts.listening.tooLong}`;
      await tell(truncated ? `${text}${tail}` : text, buttons);
    };

    if (combined === '') {
      await answer(texts.listening.nothingHeard);
      return;
    }

    /**
     * §13.7, острый кризис. Первый контур считается здесь — до первого
     * обращения к модели: он ничего не стоит, а значит на настоящем
     * кризисе разбор останавливается до первой потраченной копейки.
     */
    const stopOnCrisis = async (
      outcome: CrisisOutcome,
      /** Какой контур считали: по нему в журнале видно, что именно снято. */
      contour: CrisisContour,
    ): Promise<boolean> => {
      if (!outcome.detected) {
        if (outcome.hyperbole !== undefined) {
          // Признак был и снят речевым оборотом. Это самое опасное место
          // контура: по требованию заказчицы мы гасим ложные
          // срабатывания, и надо видеть, не гасим ли лишнего. В журнал
          // идёт оборот, а не сказанное человеком.
          deps.logger?.info(
            {
              event: 'crisis_muted',
              batchId: batch.id,
              userId: batch.userId,
              contour,
              hyperbole: outcome.hyperbole,
            },
            'Признак кризиса снят речевым оборотом',
          );
        }

        return false;
      }

      // В журнал идёт факт и сработавший маркер, но не сказанное:
      // частоту ложных срабатываний оценить надо, читать чужую беду в
      // логах — нет.
      deps.logger?.warn(
        {
          event: 'crisis_detected',
          batchId: batch.id,
          userId: batch.userId,
          contour: outcome.contour ?? contour,
          marker: outcome.marker,
        },
        'Сработал контур острого кризиса, разбор остановлен',
      );

      // Ни записей, ни черновиков, ни уточняющих вопросов. Текст человека
      // при этом на месте: он сохранён до всякого разбора (инвариант 1).
      await tell(texts.safety.crisis);
      return true;
    };

    if (await stopOnCrisis(detectByMarkers(combined), 'markers')) return;

    /**
     * Закрытие дня словами (ТЗ по визуалам 18.09.2026, карточка 06):
     * «на сегодня всё», «хватит» — точка завершения, без кнопок и без
     * разбора. Считается здесь, до первой копейки модели. Карточка не
     * ушла или карточек нет — те же слова текстом.
     */
    if (looksLikeDayClosing(combined)) {
      const shown = await showCard('evening', texts.cards.evening);
      if (!shown) await answer(texts.cards.evening);
      return;
    }

    /**
     * Слова к самому боту (21.09.2026): «что ты умеешь» — текст помощи из
     * меню; «отмени последнее» — откат последнего изменения, как кнопкой
     * «Отменить». Оба — до первой копейки модели и без разбора.
     */
    if (looksLikeHelpRequest(combined)) {
      await answer(texts.menu.help);
      return;
    }

    if (looksLikeUndoRequest(combined)) {
      await answer(await undoLastByWords(db, deps, batch, context));
      return;
    }

    /**
     * §10.5: мягкий лимит расхода (задача 2.22).
     *
     * Решение принимается один раз на выгрузку, а не перед каждым
     * вызовом: расход внутри одной выгрузки лимит всё равно не догонит,
     * а разбор, у которого извлечение прошло на полной модели, а
     * классификация на лёгкой, объяснить в отчёте будет нечем.
     *
     * Считается после кризисного контура: на кризисе разбора нет вовсе,
     * и лишний запрос к учёту там не нужен.
     */
    const limited = await decideDegradation(db, {
      userId: batch.userId,
      now,
      limit: deps.spendLimit,
      logger: deps.logger,
    });

    // Полная модель или лёгкая — решается здесь и дальше не меняется.
    const heavy = limited.degrade ? aiLight : ai;

    // ── Намерения ───────────────────────────────────────────────────────
    /**
     * §7.3, задача 3.6: при открытом вопросе намерение `ANSWER`
     * проверяется первым. Без этого «в пятницу» уйдёт в `DUMP` и создаст
     * задачу без задачи — маршрутизатор не может знать, о чём спрашивал
     * бот, если ему не сказать.
     */
    const pending = await openQuestionOf(db, batch.userId, now);
    const askedAbout = pending === undefined ? undefined : await titleOfItem(db, pending.itemId);

    /**
     * **Черта оплаты — здесь, и здесь же второй заслон пробного периода.**
     *
     * Найдено ревизией четвёртого этапа. Заслон в приёме сообщений
     * спрашивает «пускать ли» в момент, когда человек говорит, а платим
     * мы минутой позже — после окна тишины и очереди. В этот разрыв
     * уходили деньги:
     *
     *  - две мысли подряд, и вторая проходила приём, пока первая ещё
     *    разбиралась: пробный период выдавал одиннадцать разборов вместо
     *    десяти;
     *  - при закрытом доступе к Yandex (05.09.2026 — случай настоящий)
     *    выгрузки копились в `queued`, приём их не видел, а когда доступ
     *    вернулся, досмотр отдал в разбор все. Оплачены были все.
     *
     * Заслон стоит **после** очереди и **до** первого обращения к
     * модели: сколько бы выгрузок ни накопилось, платных разборов будет
     * ровно столько, сколько отпущено. После обращения отказывать поздно
     * — деньги уже ушли.
     *
     * Расшифровка выше платная тоже, и в этой (редкой) развилке за неё
     * заплачено зря. Так нарочно: откажи мы до расшифровки — и при
     * закрытом доступе к модели человек терял бы бесплатные выгрузки, не
     * получив ничего. Цена выбрана меньшая из двух, и её держит суточный
     * потолок §10.5.
     */
    if (deps.settings !== undefined) {
      const may = await mayParseDump(db, {
        userId: batch.userId,
        batchId: batch.id,
        settings: deps.settings,
        now,
      });

      if (!may) {
        deps.logger?.info(
          { event: 'trial_over_at_pipeline', batchId: batch.id, userId: batch.userId },
          'Разбор остановлен на черте оплаты: доступа нет',
        );

        // Реплика из словаря, а не молчание: человек уже услышал «я
        // тебя слышу», и тишина после этого читается как поломка.
        await tell(texts.limits.trialOver);
        return;
      }
    }

    /**
     * Ответ на переспрос без кнопок (живой прогон Никиты 23.09.2026):
     * «Какое дело?» — «Забрать посылку» бот принимал за новое дело. Он
     * помнит свой переспрос четверть часа и ждёт одну реплику; похожа на
     * ответ — доделывается команда, мимо маршрутизатора: назови он ответ
     * мыслью, это и был бы дефект. Не похожа — разбор как обычно.
     */
    const clarification = await openClarification(db, batch.userId, now);
    const clarified =
      clarification === undefined
        ? undefined
        : clarifiedCommand(clarification.kind, clarification.command, combined);
    if (clarification !== undefined) {
      await closeClarification(db, clarification, clarified !== undefined);
      deps.logger?.info(
        { batchId: batch.id, kind: clarification.kind, answered: clarified !== undefined },
        'Реплика после переспроса',
      );
    }

    const routed =
      clarified !== undefined
        ? {
            segments: [{ intent: 'PATCH' as const, text: clarified }],
            crisis: false,
            promptVersion: 'уточнение',
            reordered: false,
            fallback: false,
          }
        : await routeIntents(aiLight, {
            input: combined,
            userId: batch.userId,
            batchId: batch.id,
            ...(askedAbout === undefined
              ? {}
              : pending === undefined
                ? {}
                : { openQuestion: questionText(aboutPending(pending, askedAbout), texts) }),
          });

    deps.observe?.({ kind: 'routed', segments: routed.segments });

    // Второй контур: признак от модели. Маркеры уже проверены, поэтому
    // здесь решает только он.
    if (await stopOnCrisis(detectCrisis(combined, routed.crisis), 'model')) return;

    /**
     * Сила эмоции — по всей речи, а не по отрезкам маршрутизатора
     * (заказчица, 16.09.2026, «про эмоции»): «устала» человек сказал
     * буквально, в какой бы отрезок модель его ни положила. Меняет тон
     * признания и ответ, когда разбирать оказалось нечего.
     */
    const mood = moodOf(combined);

    /**
     * Состояние опроса — до разбора, а не после (прогон 17.09.2026,
     * находка 19). Оно нужно уже ветке «разбирать нечего»: «привет»,
     * написанное до «Согласна», разбирается сразу после кнопки — поверх
     * открытого первого вопроса опроса, и отвечать на него вторым
     * вопросом нельзя (§13.9). Ниже это же состояние решает, дозадавать
     * ли опрос.
     */
    const onboarding = await onboardingStateOf(db, batch.userId);
    const onboardingOpen = onboarding.step > 0 && onboarding.step < STEP.done;

    const parsed: Segment[] = [];
    const deferred: Segment[] = [];
    const answers: string[] = [];
    /** Отрезки без содержания — но «спасибо» среди них заслуживает ответа. */
    const smalltalk: Segment[] = [];

    /**
     * Сфера ветки, в которой человек говорит (§8.1, ревизия этапа 3, F4).
     *
     * Считается до разбора правок: подбор кандидатов сужается той же
     * темой, и по той же причине — правка внутри ветки почти наверняка
     * про запись из неё. И до вопросов: вопрос внутри ветки — про её сферу.
     */
    const threadTopic =
      target?.threadId === undefined
        ? undefined
        : await topicByThread(db, batch.userId, target.threadId);

    /**
     * Вопросы отвечаются **до** раскладки отрезков, и вот почему (видео
     * заказчицы 15.09.2026). Голосовое: «…потом заказать цветы.
     * Вспомнить, когда мы последний раз договаривались с няней на
     * восьмичасовую работу. И если что обговорить с ней новые условия».
     * Маршрутизатор отдал среднее как QUERY: бот ответил «Про это у меня
     * ничего не записано», мысль про няню пропала, а «с ней» приклеилось
     * к соседнему делу.
     *
     * Правило, а не догадка: вопрос **внутри выгрузки** (рядом есть
     * мысли), на который в записях ничего нет, — это мысль. Она уходит в
     * разбор **на своём месте** среди соседей, чтобы «с ней» читалось про
     * няню, и ответа «ничего не записано» нет. Вопрос сам по себе,
     * «на сегодня пусто», «закрыто», «не смогла посмотреть» — как раньше:
     * там есть что ответить. Тот же принцип, что у ответа на уточнение:
     * всё сверх ответа — в разбор или в черновик, никогда в никуда.
     */
    const hasThought = routed.segments.some((segment) => PARSED_INTENTS.has(segment.intent));
    const questions: { readonly text: string; readonly answer: BacklogAnswer }[] = [];
    const segments: Segment[] = [];

    for (const segment of routed.segments) {
      if (segment.intent !== QUERY_INTENT) {
        segments.push(segment);
        continue;
      }

      const answer = await answerBacklogQuery(
        {
          db,
          ...(deps.embedder === undefined ? {} : { embedder: deps.embedder }),
          ...(deps.ai.pricing === undefined ? {} : { pricing: deps.ai.pricing }),
          ...(deps.logger === undefined ? {} : { logger: deps.logger }),
          // Вектор вопроса — платный вызов: под потолок его тоже (3.82).
          ...(deps.ai.spendGuard === undefined ? {} : { spendGuard: deps.ai.spendGuard }),
        },
        {
          userId: batch.userId,
          text: segment.text,
          batchId: batch.id,
          now,
          // §8.1: вопрос внутри ветки — про её сферу (F4).
          ...(threadTopic?.name === undefined ? {} : { topic: threadTopic.name }),
        },
      );

      if (hasThought && answer.kind === 'nothing') {
        deps.logger?.info(
          { batchId: batch.id },
          'Вопрос внутри выгрузки, на который ответить нечем, уходит в разбор как мысль',
        );
        segments.push({ intent: 'DUMP', text: segment.text });
        continue;
      }

      questions.push({ text: segment.text, answer });
      segments.push(segment);
    }

    /**
     * Правки, сказанные **до** первой мысли этой выгрузки.
     *
     * Такая правка относится к прошлому: «нет, в пятницу» в начале
     * выгрузки — про то, что человек говорил раньше. Разбирается до
     * сохранения, чтобы попасть в прежнюю запись, а не в свежую.
     */
    const patches: Segment[] = [];

    /**
     * Правки, сказанные **после** мысли этой же выгрузки (задача 3.24).
     *
     * «Договориться с няней, чтобы приходила в 10. Нет, лучше в 10 30» —
     * поправка к тому, что произнесено секунду назад. Разбирается после
     * сохранения и **только среди записей своей выгрузки**.
     *
     * **Порядок сегментов и есть признак.** Найдено ручным прогоном на
     * боевом 02.09.2026: без этого правку перехватывал первый проход и
     * уводил в похожую запись из прошлой выгрузки — у человека оказались
     * испорчены обе, старая и новая.
     */
    const patchesAfterThought: Segment[] = [];
    /** Инвариант 10: один вопрос в реплике, и первый его занимает. */

    /**
     * Темы, которых коснулись правки, — их сводки надо обновить.
     *
     * Обновление сводок стояло ниже и звалось только с темами **новых**
     * записей. Выгрузка из одной правки, закрытия или отмены до него не
     * доходила вовсе: поправил срок — в ветке старый, закрыл дело — в
     * ветке открыто. §8 обещает «сводка ветки обновляется редактированием».
     * Найдено ручным прогоном 31.08.2026.
     *
     * Собираются обе темы — прежняя и новая: правка могла перенести
     * запись, и тогда обновить надо и ту ветку, откуда она ушла.
     */
    const touchedTopics = new Set<string>();

    /**
     * Записи, о которых человек говорил в этой выгрузке.
     *
     * Не только заведённые сейчас: поправленное и закрытое человек тоже
     * назвал вслух, и в ответе оно должно стоять впереди старого. Ровно
     * поэтому здесь набор ключей, а не номер выгрузки, — по номеру
     * правки не найти, у поправленной записи он от прошлой выгрузки.
     */
    const mentioned = new Set<string>();

    /** Закрылось ли в этой выгрузке хоть одно дело — для вопроса §2.8. */

    /**
     * Сказал ли бот человеку хоть что-то по существу.
     *
     * Нужен ради одной реплики в самом конце. «Я здесь. Расскажешь, что
     * в голове?» существует для сообщения, из которого не вышло ничего:
     * ни записи, ни правки, ни ответа. Но условие на неё стояло только
     * «новых мыслей нет» — а новых мыслей нет и когда человек задал
     * вопрос, и когда поправил запись, и когда отметил дело сделанным.
     * Бот отвечал по существу и следом добавлял «расскажешь, что в
     * голове?», то есть выглядел так, будто не понял.
     */

    /**
     * Возвращение после паузы (§13.6 ТЗ).
     *
     * Первое, что человек видит, вернувшись через две недели: не стена
     * накопившегося, а выбор. Экран занимает единственный вопрос реплики
     * — обычный ответ на эту выгрузку придёт без своего «С чего начнём?»,
     * ровно как это уже устроено у онбординга.
     *
     * Сказанное при этом разбирается как обычно: человек вернулся и
     * что-то наговорил, терять это нельзя.
     */
    if (await returningAfterPause(db, { userId: batch.userId, batchId: batch.id, now })) {
      happened.asked = true;
      happened.said = true;
      await tell(texts.returning.greeting, [
        { label: texts.returning.buttonContinue, action: RETURNING_ACTION.keep },
        // Код выгрузки — граница «старого» для «С чистого листа» (H1).
        {
          label: texts.returning.buttonFresh,
          action: `${RETURNING_ACTION.fresh}:${toShortId(batch.id)}`,
        },
      ]);
    }

    /** Прозвучала ли в этой выгрузке мысль до текущего сегмента. */
    let thoughtSaid = false;

    for (const segment of segments) {
      if (segment.intent === ANSWER_INTENT) answers.push(segment.text);
      // QUERY уже отвечен выше — здесь ему делать нечего.
      else if (segment.intent === QUERY_INTENT) continue;
      else if (PARSED_INTENTS.has(segment.intent)) {
        parsed.push(segment);
        thoughtSaid = true;
      } else if (RESOLVED_INTENTS.has(segment.intent)) {
        (thoughtSaid ? patchesAfterThought : patches).push(segment);
      } else if (IGNORED_INTENTS.has(segment.intent)) smalltalk.push(segment);
      else deferred.push(segment);
    }

    /**
     * Судьба открытого вопроса решается до разбора мыслей.
     *
     * «Это новое» возвращает сказанное обратно в разбор — оно пойдёт
     * через то же извлечение и ту же классификацию, что и остальная
     * выгрузка, без отдельного вызова модели.
     */
    const settled = await settlePendingQuestion(db, {
      userId: batch.userId,
      batchId: batch.id,
      timeZone: context.timeZone,
      ...(answers.length === 0 ? {} : { answerText: answers.join(' ') }),
      now,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    });

    if (settled.carryOver !== undefined) {
      parsed.push({ intent: 'DUMP', text: settled.carryOver });
    }

    /**
     * В ответе были слова сверх ответа — они сохранены черновиком, и
     * человеку об этом сказано (3.44). Иначе он увидит «Перенесла…» и
     * решит, что остальное бот пропустил мимо ушей.
     */
    if (settled.leftoverSaved === true) {
      happened.said = true;
      await tell(texts.resolver.leftoverSaved);
    }

    if (settled.kind === 'applied' && settled.applied !== undefined) {
      happened.said = true;
      rememberTopics(touchedTopics, settled.applied);
      mentioned.add(settled.applied.after.id);
      // Заголовок мог смениться — вектор вслед (A5).
      await reembedIfRetitled(
        {
          db,
          ...(deps.embedder === undefined ? {} : { provider: deps.embedder }),
          ...(deps.ai.spendGuard === undefined ? {} : { spendGuard: deps.ai.spendGuard }),
          ...(deps.ai.pricing === undefined ? {} : { pricing: deps.ai.pricing }),
          ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        },
        settled.applied,
      );
      // §7.3: показать, что именно изменилось, и дать кнопку отмены.
      await tell(
        describeChange(settled.applied, texts, context.timeZone),
        // Те же кнопки, что у правки голосом без вопроса (23.09.2026).
        changeButtons(settled.applied, texts),
      );
    } else if (settled.kind === 'nothingToApply') {
      // «Добавила к прошлой» здесь было ложью на все три исхода (A3).
      happened.said = true;
      if (settled.timeUnclear !== undefined && pending !== undefined) {
        await saveDraft(db, {
          userId: batch.userId,
          batchId: batch.id,
          text: pending.segment,
          reason: CLARIFY_REASON.time,
        });
      }
      await tell(
        settled.why === 'refused'
          ? texts.resolver.deadlineRefused
          : settled.why === 'gone'
            ? texts.card.gone
            : unchangedText(settled, texts),
      );
    } else if (settled.kind === 'unclear') {
      happened.said = true;
      await tell(texts.resolver.answerUnclear);
    }

    /**
     * Правки разбираются по одной и до разбора новых мыслей.
     *
     * По одной, потому что у каждой свои кандидаты и своё решение: пачкой
     * их не рассудить. До мыслей — потому что «нет, в пятницу» относится
     * к тому, что было сказано раньше, и должно попасть в ту запись, а не
     * в новую, которая появится через секунду.
     *
     * **У этого порядка есть цена, и она обнаружилась в бою** (задача
     * 3.24): правка к сказанному **в этой же выгрузке** цели не находит —
     * записи ещё нет. Поэтому такие правки не уходят в черновик сразу, а
     * ждут второго прохода, ниже.
     */

    /** Правки, которые надо перебрать среди записей своей выгрузки. */
    const searchOwnBatch: Segment[] = [...patchesAfterThought];

    /** Правки, которым не хватило и своей выгрузки: ищем по всему. */
    const searchEverywhere: Segment[] = [];

    /**
     * Мысли, принятые за правку после первой мысли (ревизия этапа 3,
     * A4-средняя): резолвер, глядя на записи, сказал «это новая мысль»,
     * а разбор выгрузки уже прошёл. Им — свой проход, ниже.
     */
    const lateThoughts: Segment[] = [];

    /**
     * Что делать с исходом разбора правки.
     *
     * Отдельной функцией потому, что проходов два и обработка у них
     * одна: разъехавшись, они дали бы правку, которая на втором проходе
     * применяется молча, без реплики человеку.
     */
    const useOutcome = async (
      segment: Segment,
      outcome: SegmentResult,
      /**
       * Какой это проход. От него зависит, куда девать «цель не нашлась»:
       * `before` — до сохранения, `ownBatch` — среди своей выгрузки,
       * `wide` — последний, по всем записям.
       */
      stage: 'before' | 'ownBatch' | 'wide',
    ): Promise<void> => {
      if (outcome.kind === 'applied') {
        happened.said = true;
        rememberTopics(touchedTopics, outcome.applied);
        mentioned.add(outcome.applied.after.id);
        if (outcome.applied.action === 'complete') happened.closed = true;
        /**
         * Сказанное человеком идёт в реплику (задача 3.28).
         *
         * По нему видно, говорил ли он о **замене**. Если говорил, а
         * модель разобрала дополнением и нового заголовка не дала, —
         * реплика скажет, что заголовок остался прежним, и даст кнопку
         * его поправить. Молчать об этом значило бы отпустить человека
         * с ощущением, что его поняли, при том что запись противоречит
         * сказанному.
         */
        await tell(
          describeChange(outcome.applied, texts, context.timeZone, segment.text),
          changeButtons(outcome.applied, texts, segment.text),
        );
        return;
      }

      if (outcome.kind === 'asked') {
        /**
         * Второй вопрос за обмен задавать нельзя (§13.9): два вопроса
         * подряд — это допрос. Резолвер получает `questionTaken` и при
         * занятом вопросе паркует правку сам, не заводя второй в базе
         * (ревизия этапа 3, A2) — сюда приходит только первый.
         */
        happened.asked = true;
        happened.said = true;
        // §7.3: один короткий вопрос с двумя кнопками и заголовком
        // найденной записи в тексте; у приказа о переносе — вопрос о
        // переносе (живой прогон Никиты 23.09.2026).
        const about = {
          title: outcome.itemTitle,
          segment: segment.text,
          action: outcome.action,
          changes: { deadline: outcome.deadline },
        };
        await tell(questionText(about, texts), questionButtons(outcome.questionId, texts, about));
        return;
      }

      if (outcome.kind === 'newThought') {
        /**
         * Распоряжение о записи мыслью не становится (задача 3.67).
         *
         * **Найдено живым прогоном проджекта 04.09.2026.** Он прислал
         * отдельным сообщением «Перенеси дело с собакой на вторник».
         * Резолвер цели не нашёл — у человека три дела про собаку — и
         * вернул «это новая мысль». Мысль уходит в разбор, и распоряжение
         * стало **делом** «Перенеси дело с собакой на вторник» со сроком
         * на вторник. В списке дел человек увидел свою же команду.
         *
         * Резолвер тут не виноват: он честно сказал «цели не нашёл».
         * Виновата развилка — «не правка» у нас означало «значит мысль», а
         * третьего исхода не было. Теперь он есть: сказанное сохраняется
         * как есть (§16 — ничего не теряется), и человеку говорится, что
         * цель не найдена.
         *
         * Проверяются только приказы о записи, без существительного
         * «дело»: «надо доделать дело с налогами» — настоящая мысль.
         */
        if (isRecordCommand(segment.text)) {
          happened.parked = true;
          happened.said = true;

          await saveDraft(db, {
            userId: batch.userId,
            batchId: batch.id,
            text: segment.text,
            reason: 'распоряжение о записи, но цель не нашлась',
          });

          await tell(texts.resolver.targetNotFound);
          return;
        }

        /**
         * На первом проходе это ещё мысль: она идёт в общий разбор. На
         * втором и третьем извлечение и сохранение уже прошли, и в них
         * её не вставить — она ждёт своего прохода (`absorbLateThoughts`),
         * а не ложится черновиком, как было до ревизии этапа 3 (A4).
         */
        if (stage === 'before') {
          parsed.push(segment);
          return;
        }

        lateThoughts.push(segment);
        return;
      }

      /**
       * «Такого дела не было» есть смысл проверять ещё раз, только если в
       * этой выгрузке появятся новые записи — цель могла быть сказана
       * здесь же. Без них повтор ничего не найдёт, а слив отложенных
       * ответил бы общим «правку применить не вышло» вместо честного слова.
       */
      const worthRetrying = outcome.said !== 'absent' || parsed.length > 0;
      if (outcome.retryAfterSave === true && stage !== 'wide' && worthRetrying) {
        (stage === 'before' ? searchOwnBatch : searchEverywhere).push(segment);
        return;
      }

      happened.parked = true;
      // Разговор был о деле, даже если правка не легла: «удали это»
      // следом должно найти его (бой 23.09.2026).
      if (outcome.itemId !== undefined) mentioned.add(outcome.itemId);
      // Модель резолвера молчала — это сбой, а не непонятая правка (п. 4).
      if (outcome.fault !== undefined) happened.fault = outcome.fault;
      sayParked(parkedLine(outcome.said, outcome.timeUnclear));
      await saveDraft(db, {
        userId: batch.userId,
        batchId: batch.id,
        text: segment.text,
        // Переспрос помечен: следующая реплика может быть ответом на него.
        reason: outcome.clarify === undefined ? outcome.reason : CLARIFY_REASON[outcome.clarify],
      });
    };

    /**
     * Слить отложенные правки в черновики (задача 3.82).
     *
     * **Зачем.** Правка к сказанному в этой же выгрузке ждёт второго
     * прохода — тех двух циклов в самом низу. Но между откладыванием и
     * вторым проходом есть четыре выхода: разбирать нечего, извлечение
     * не удалось, единиц ноль, классификация не удалась. На любом из них
     * список отложенных просто перестаёт существовать вместе с областью
     * видимости: ни записи, ни черновика, ни слова человеку. А человек в
     * двух из четырёх случаев читает «ничего не потерялось».
     *
     * Поэтому у каждого выхода — слив: слова уходят в черновик, и
     * обещание становится правдой. Возвращает число слитых, чтобы выход,
     * который иначе ответил бы «расскажешь, что в голове?», не спрашивал
     * этого у человека, только что сказавшего своё.
     */
    const parkPending = async (reason: string): Promise<number> => {
      const pending = [...searchOwnBatch, ...searchEverywhere];
      if (pending.length === 0) return 0;

      // Очистка до записи: повторный вызов ниже не должен положить то же
      // дважды, а выходы стоят на четырёх разных путях.
      searchOwnBatch.length = 0;
      searchEverywhere.length = 0;

      for (const segment of pending) {
        happened.parked = true;
        sayParked(texts.answer.patchParked);
        await saveDraft(db, {
          userId: batch.userId,
          batchId: batch.id,
          text: segment.text,
          reason,
        });
      }

      return pending.length;
    };

    /**
     * Разбор одной правки.
     *
     * `ownBatchOnly` ставит второй проход: он ищет цель только среди
     * записей этой выгрузки. Первый проход уже искал по всему и не
     * нашёл — значит цель либо здесь, либо её нет вовсе.
     */
    const resolveOne = async (segment: Segment, ownBatchOnly = false): Promise<SegmentResult> =>
      await resolvePatchSegment(
        {
          db,
          ai: heavy,
          ...(deps.embedder === undefined ? {} : { embedder: deps.embedder }),
          ...(deps.ai.pricing === undefined ? {} : { pricing: deps.ai.pricing }),
          ...(deps.logger === undefined ? {} : { logger: deps.logger }),
          // Пороги резолвера правятся в панели без выкладки (§15), и
          // до ревизии четвёртого этапа этот проброс отсутствовал: поля
          // в панели были, читателя не было.
          ...(deps.settings === undefined ? {} : { settings: deps.settings }),
        },
        {
          userId: batch.userId,
          batchId: batch.id,
          text: segment.text,
          timeZone: context.timeZone,
          ...(threadTopic?.name === undefined ? {} : { topic: threadTopic.name }),
          ...(ownBatchOnly ? { onlyOwnBatch: true } : {}),
          // Приветствие §13.6 и первая правка ставят `happened.asked`;
          // резолвер читает его в момент вызова — правки идут по одной.
          questionTaken: happened.asked,
          // Закрытие и отмена без записи не становятся мыслью (находка 5).
          intent: segment.intent,
          now,
        },
      );

    for (const segment of patches) {
      await useOutcome(segment, await resolveOne(segment), 'before');
    }

    for (const [order, segment] of deferred.entries()) {
      // Текст не теряется и виден в админке: разберёт его резолвер на
      // третьем этапе, когда появится, к чему применять правку.
      //
      // Порядок внутри выгрузки сохраняется: без него черновики одной
      // выгрузки лежали бы в случайном порядке — время создания у них
      // совпадает.
      await saveDraft(db, {
        userId: batch.userId,
        batchId: batch.id,
        text: segment.text,
        reason: `намерение ${segment.intent} — ждёт резолвера (этап 3)`,
        order,
      });
    }

    for (const { text: asked, answer } of questions) {
      happened.said = true;

      /**
       * Живой ответ на вопрос (слой B, 22.09.2026; §13.4 ТЗ — прозой, не
       * списком). Записи нашёл код выше; модель говорит о найденном по
       * закрытому списку фактов (`questionFacts`) под стражем
       * (`askLiveAnswer`). Не прошёл, пусто или выключено в панели —
       * словарный ответ, как раньше. Списки по дню и сферам — всегда код.
       */
      const liveKind =
        answer.kind === 'about' ||
        answer.kind === 'aboutClosed' ||
        answer.kind === 'project' ||
        answer.kind === 'nothing';
      const wantsLive = liveKind && ((await deps.settings?.number('liveAnswers')) ?? 1) !== 0;
      const liveAnswer = async (project?: ProjectContext): Promise<string | undefined> => {
        if (!wantsLive) return undefined;
        const facts = questionFacts({
          question: asked,
          now,
          timeZone: context.timeZone,
          texts,
          answer,
          project,
          // Ничего не нашлось — обзор открытых дел: «как всё успеть».
          overview: answer.kind === 'nothing' ? await openItemsFor(db, batch.userId) : undefined,
        });
        return (await askLiveAnswer(ai, { facts, userId: batch.userId, batchId: batch.id })).line;
      };

      /**
       * Про большую цель отвечаем контекстом, а не строкой списка (3.13).
       *
       * Разложение случается здесь же, лениво: человек спросил — значит
       * цель ему интересна, и платить за разбор уже не жалко.
       * Раскладывать при создании значило бы платить за все проекты, к
       * которым никто не вернётся, а таких большинство.
       */
      if (answer.kind === 'project') {
        await decomposeIfNeeded(
          { db, ai: { db, ...deps.ai } },
          { item: answer.item, userId: batch.userId, batchId: batch.id },
        );

        const context = await contextOf(db, answer.item.id);

        /**
         * И кнопка ближайшему шагу (задача 3.82). Без неё §21 п.6 обещал
         * показать «что уже решено», а закрыть шаг было нечем: раздел
         * «Сделано» не мог наполниться никогда.
         */
        const prose = await liveAnswer(context);
        await tell(
          prose ?? describeProject(answer.item, context, texts),
          stepButtons(context.next, texts),
        );

        continue;
      }

      if (answer.kind === 'nothing') {
        const prose = await liveAnswer();
        if (prose !== undefined) {
          await tell(prose);
          continue;
        }
      }
      const aboutProse =
        answer.kind === 'about' || answer.kind === 'aboutClosed' ? await liveAnswer() : undefined;

      /**
       * «С чего начать» словами — тот же выбор главного, что у кнопки
       * (21.09.2026): без кода выгрузки, потому что спросили не под
       * разбором, а отдельно.
       */
      if (answer.kind === 'pick') {
        const picked = await pickMain(db, {
          userId: batch.userId,
          now,
          timeZone: context.timeZone,
          texts,
        });
        const reply = buildActionsReply({ texts, ...picked });
        await tell(reply.text, reply.buttons.length === 0 ? undefined : reply.buttons);
        continue;
      }

      /** «Сколько у меня дел» — одной строкой с раскладкой. */
      if (answer.kind === 'count') {
        await tell(
          answer.open === 0
            ? texts.backlog.countEmpty
            : texts.backlog.count(
                texts.backlog.tasksCount(answer.open),
                answer.today,
                answer.overdue,
                answer.later,
              ),
        );
        continue;
      }

      /**
       * Список по признаку (21.09.2026): шапка из текстов, строки как у
       * остальных списков голосом, тот же предел на длину. Пустой список
       * — одна шапка: «Просроченного нет» — тоже ответ.
       */
      if (answer.kind === 'listed') {
        const shownItems = answer.items.slice(0, SPOKEN_LIST_LIMIT);
        const rest = answer.items.length - shownItems.length;
        const lines = shownItems.map((item) => texts.backlog.line(item.text));
        if (rest > 0) lines.push(texts.backlog.more(rest));
        await tell(
          [listHeader(answer.question, answer.items.length === 0, texts.backlog), ...lines].join(
            '\n',
          ),
        );
        continue;
      }

      /**
       * «Не смогла посмотреть» — своя шапка и пустое тело.
       *
       * Ветка отдельная, потому что «ничего не нашлось» и «не сумели
       * поискать» выглядят одинаково пустыми, а значат противоположное:
       * первое человек примет за факт о своих делах и не переспросит.
       */
      const header =
        answer.kind === 'today'
          ? texts.backlog.today
          : answer.kind === 'todayEmpty'
            ? texts.menu.todayEmpty
            : answer.kind === 'period'
              ? texts.backlog.period(periodLabel(answer.period, texts.backlog))
              : answer.kind === 'periodEmpty'
                ? texts.backlog.periodEmpty(periodLabel(answer.period, texts.backlog))
                : answer.kind === 'about'
                  ? (aboutProse ?? texts.backlog.about)
                  : answer.kind === 'all'
                    ? texts.backlog.all
                    : answer.kind === 'allEmpty'
                      ? texts.backlog.allEmpty
                      : answer.kind === 'aboutClosed'
                        ? (aboutProse ?? texts.backlog.aboutClosed)
                        : answer.kind === 'unavailable'
                          ? texts.backlog.unavailable
                          : texts.backlog.nothing;

      /**
       * Шапка называет день — значит вчерашнее «завтра» в строке лишнее
       * (задача 3.78). Срезается только у дела, чей срок и есть сегодня.
       *
       * Условие по видам с записями, а не «кроме пустого»: при строгих
       * типах компилятор сам приводит сюда за руку, когда видов
       * прибавляется.
       */
      /**
       * Список голосом — не длиннее страницы кнопки «Сегодня» (ревизия
       * этапа 3, E12). Без предела при сотне просроченных текст пробивал
       * 4096 знаков, Telegram отказывал, и человек получал тишину.
       */
      /**
       * Обо всём — по сферам с иконками, только непустые, с предложением и
       * двумя кнопками (макет заказчицы 16.09.2026, вариант 2). Предел
       * строк тот же, что у остальных списков голосом.
       */
      if (answer.kind === 'all') {
        /**
         * «Мои дела» — полный список по ТЗ проджекта 17.09.2026 (2.4):
         * раскладка и ярусы — в `backlog/my-tasks.ts`, одна на голос и
         * на кнопку меню. Первое сообщение — в статусный слот, остальные
         * следом; кнопки — под последним. Карточка «всё накопившееся» —
         * при 15+ делах, перед списком (визуал 05).
         */
        const day = { now, timeZone: context.timeZone };
        const layout = layoutMyTasks(answer.items, day);
        const view = renderMyTasks(layout, day, texts);
        if (layout.total >= SINGLE_LIMIT) {
          await showCard('all', texts.cards.all(texts.backlog.tasksCount(layout.total)));
        }
        for (const [index, message] of view.messages.entries()) {
          const last = index === view.messages.length - 1;
          await tell(message, last && view.buttons.length > 0 ? view.buttons : undefined);
        }
        continue;
      }

      /**
       * Проза про одну-две записи идёт без списка под ней (бой
       * 22.09.2026): «Что там со стоматологом?» → «Ты хотела записаться
       * к стоматологу…» и следом строка «— Записаться к стоматологу» —
       * то же самое дважды. От трёх записей список полезен: проза
       * называет главное, список — остальное.
       */
      const proseCoversAll =
        aboutProse !== undefined && answer.kind !== 'today' && answer.kind !== 'period';
      const listed =
        answer.kind === 'today' ||
        answer.kind === 'about' ||
        answer.kind === 'period' ||
        answer.kind === 'aboutClosed'
          ? proseCoversAll && answer.items.length <= 2
            ? []
            : answer.items
          : [];
      const shownItems = listed.slice(0, SPOKEN_LIST_LIMIT);
      const rest = listed.length - shownItems.length;

      const body =
        answer.kind === 'today' || answer.kind === 'about' || answer.kind === 'period'
          ? (await withNextSteps(db, shownItems)).map((item) =>
              answer.kind === 'period' &&
              item.deadlineAt !== null &&
              item.deadlineAccuracy !== 'day'
                ? // Неточный срок в списке периода — словами карточки, чтобы
                  // «на неделе с 21.09» не читалось как точный день.
                  texts.summary.lineWithDate(
                    item.text,
                    deadlineWords(
                      { ...item, deadlineAt: item.deadlineAt },
                      context.timeZone,
                      texts,
                    ),
                  )
                : texts.backlog.line(
                    answer.kind === 'today'
                      ? titleUnderDayHeader(item, { now, timeZone: context.timeZone })
                      : item.text,
                  ),
            )
          : answer.kind === 'aboutClosed'
            ? shownItems.map((item) =>
                texts.backlog.closedLine(
                  item.text,
                  item.backgroundedAt !== null
                    ? texts.backlog.inBackground
                    : texts.card.statusName(item.status),
                ),
              )
            : [];
      if (rest > 0) body.push(texts.backlog.more(rest));

      /**
       * На сегодня пусто, а дела есть — сказать сколько и дать выход к
       * ним (находка 21): «Все задачи» / «Выбрать главное». Без дел
       * вовсе — как было.
       */
      if (answer.kind === 'todayEmpty' && answer.open > 0) {
        await tell([header, texts.menu.todayEmptyOpen(String(answer.open))].join('\n'), [
          { label: texts.menu.buttonAll, action: ANSWER_ACTION.all },
          { label: texts.answer.buttonPick, action: ANSWER_ACTION.pick },
        ]);
        continue;
      }

      /**
       * Неделя — карточкой (ТЗ по визуалам 18.09.2026, карточка 03):
       * подпись, список в ней же и кнопки «Выбрать главное · Мои дела».
       * Не ушла — тот же список текстом, как раньше.
       */
      if (answer.kind === 'period' && answer.period === 'week') {
        const shown = await showCard('week', [texts.cards.week, ...body].join('\n'), [
          { label: texts.answer.buttonPick, action: ANSWER_ACTION.pick },
          { label: texts.cards.buttonMyTasks, action: ANSWER_ACTION.all },
        ]);
        if (shown) continue;
      }

      await tell([header, ...body].join('\n'));
    }

    if (parsed.length === 0) {
      // Отложенные правки второго прохода не дождутся: ниже этой ветки
      // обработка не идёт. Их слова — в черновики.
      const parkedHere = await parkPending(
        'правка ждала разбора выгрузки, а разбирать было нечего',
      );

      // О каких делах шёл разговор — и в выгрузке из одних правок: иначе
      // «удали это» следом не найдёт, о чём речь (бой 23.09.2026).
      if (mentioned.size > 0) await rememberMentioned(db, batch.id, [...mentioned]);

      // Правки без новых мыслей тоже меняют ветки — обновить надо здесь,
      // потому что ниже этой ветки обработка уже не идёт.
      await refreshTouched(
        db,
        deps,
        target,
        { userId: batch.userId, timeZone: context.timeZone, textProfile: context.textProfile },
        touchedTopics,
      );

      /**
       * Отложенное подтверждаем всегда: человек должен знать, что
       * сказанное сохранено, даже если мы уже ответили о другом.
       */
      if (deferred.length > 0) await answer(texts.answer.savedUnparsed);

      /**
       * Сценарий 8 §2: закрыв запись, бот спрашивает, продолжаем или на
       * сегодня достаточно.
       *
       * **Здесь, а не после каждого закрытого дела.** §13.9 не даёт двух
       * вопросов в реплике, а три закрытых дела подряд дали бы три
       * вопроса — продукт про выдох превратился бы в опрос. И только
       * когда разбирать больше нечего: если в выгрузке были новые мысли,
       * обычный ответ и так заканчивается «С чего начнём?», и второй
       * вопрос был бы лишним.
       *
       * Только у выполнения. У отмены §13.5 требует «подтверждение в одну
       * строку» и вопроса не хочет: человек, отказавшийся от дела, не
       * ждёт, что его спросят, чем он займётся дальше.
       */
      if (happened.closed && !happened.asked) {
        // Своим сообщением, а не правкой статусного: иначе затрёт
        // подтверждение выполнения вместе с кнопкой отката.
        await tell(texts.resolver.goOn, [
          { label: texts.resolver.buttonGoOn, action: ANSWER_ACTION.now },
          { label: texts.resolver.buttonEnough, action: ANSWER_ACTION.later },
        ]);
      } else if (parkedHere > 0 || parkedWords.length > 0) {
        /**
         * Слова сохранены — так и говорим, и по исходу (A4). «Расскажешь,
         * что в голове?» человеку, который только что сказал своё,
         * читается как «я тебя не услышала».
         */
        await answer(parkedWords.length > 0 ? parkedWords.join('\n') : texts.answer.savedUnparsed);
      } else if (deferred.length === 0 && !happened.said) {
        /**
         * «Я здесь. Расскажешь, что в голове?» — только когда сказать
         * больше нечего. После ответа на вопрос или после правки эта
         * реплика читается как «я тебя не поняла».
         */
        // «Спасибо» — «Пожалуйста 🤍 Я всё помню.», а не «расскажешь, что
        // в голове?» (заказчица, 16.09.2026). Слово — по закрытому списку.
        const thanked = smalltalk.some((segment) => saysThanks(segment.text));
        // Состояние без дел — её реплика по силе («вымоталась» → про
        // батарейку 😮‍💨; «в панике» → спокойно), а не «расскажешь, что в
        // голове?»: «не нужно насильно превращать это в дело».
        // Вопрос уже открыт (опрос или уточнение) — второго не задаём:
        // «Я здесь.» без «?» (находка 19).
        const questionOpen = onboardingOpen || happened.asked;

        /**
         * Последняя попытка — моделью (22.09.2026, экран заказчицы
         * 21.09): «Напиши мне все, что накопилось» → «Я здесь.
         * Расскажешь, что в голове?». Слово добавили в рамку вопроса в
         * тот же вечер, но так чинится по одной фразе, а женщина
         * формулирует как придётся. Общий слой: сказать нечего — даём
         * модели её слова и обзор открытых дел (тот же путь, что у
         * ответа на вопрос). Не про дела — пустая строка, и реплика
         * словаря остаётся.
         *
         * Не зовётся, когда ответ и так есть: «спасибо», состояние,
         * пустой список дел.
         */
        const lastTry = !thanked && mood === undefined && (await openItemsFor(db, batch.userId));
        const spokenHere = combined.trim();
        const rescue =
          lastTry !== false && lastTry.length > 0 && spokenHere !== ''
            ? (
                await askLiveAnswer(ai, {
                  facts: questionFacts({
                    question: spokenHere,
                    now,
                    timeZone: context.timeZone,
                    texts,
                    answer: { kind: 'nothing' },
                    overview: lastTry,
                  }),
                  userId: batch.userId,
                  batchId: batch.id,
                })
              ).line
            : undefined;

        await answer(
          thanked
            ? texts.answer.thanks
            : mood !== undefined
              ? feelingsOnlyReply(texts, mood)
              : (rescue ??
                (questionOpen ? texts.answer.nothingToParseQuiet : texts.answer.nothingToParse)),
        );
      }

      return;
    }

    const dumpText = parsed.map((segment) => segment.text).join('\n');

    /**
     * Разбору — речь с правками на своих местах (задача 3.57).
     *
     * Отдельно от `dumpText`: тот идёт в промпт классификации под словами
     * «человек сказал так» и в презентацию, и менять его — другая задача с
     * другим замером. Условия вплетения — в `patch-in-place.ts`.
     */
    const forExtraction = weaveForExtraction(parsed, segments);

    // ── Единицы ─────────────────────────────────────────────────────────
    const extracted = await extractUnits(heavy, {
      input: forExtraction,
      userId: batch.userId,
      batchId: batch.id,
    });

    if (extracted.ok) deps.observe?.({ kind: 'extracted', dumpText, units: extracted.units });

    if (!extracted.ok) {
      await parkPending('правка ждала разбора выгрузки, а извлечение не удалось');
      await saveDraft(db, {
        userId: batch.userId,
        batchId: batch.id,
        text: dumpText,
        reason: `извлечение не удалось: ${extracted.problem}`,
      });
      happened.fault = `извлечение не удалось: ${extracted.problem}`;
      await answer(texts.answer.savedUnparsed);
      return;
    }

    if (extracted.units.length === 0) {
      const parkedHere = await parkPending(
        'правка ждала разбора выгрузки, а единиц в ней не нашлось',
      );

      // Сказанное сохранено — обещание правдиво; иначе — по состоянию,
      // если человек его назвал, или прежняя реплика.
      await answer(
        parkedHere > 0
          ? texts.answer.savedUnparsed
          : mood !== undefined
            ? feelingsOnlyReply(texts, mood)
            : onboardingOpen || happened.asked
              ? texts.answer.nothingToParseQuiet
              : texts.answer.nothingToParse,
      );
      return;
    }

    // ── Классификация ───────────────────────────────────────────────────
    /**
     * Сферы — только под записи (заказчица, 16.09.2026).
     *
     * С задачи 3.43 первая разобранная выгрузка заводила базовый набор
     * из пяти сфер и все пять веток разом. Заказчица по видео: «он
     * сразу насоздавал много тем… кто не в теме — зачем это?». Базовые
     * имена теперь только подсказка модели (`topicsFor` отдаёт их, пока
     * своих тем нет); темы и ветки появляются вместе с первой записью в
     * них — `settleTopics` ниже, после раскладки.
     */
    const topics = await topicsFor(db, batch.userId);

    const classified = await classifyUnits(heavy, {
      units: extracted.units,
      // §3.8б: «запомни» живёт в сказанном, а не в единицах.
      spoken: dumpText,
      /**
       * А правилам дня — речь целиком (задача 3.56). Маршрутизатор
       * убирает из `dumpText` отрезки с намерением `PATCH`, и вместе с
       * ними уходит отмена дня: «Хотя нет, давай мойку лучше в пятницу».
       */
      speech: combined,
      topics: topics.names,
      defaultTopic: threadTopic?.name ?? topics.defaultName,
      timeZone: context.timeZone,
      now,
      userId: batch.userId,
      batchId: batch.id,
    });

    if (classified.ok) {
      deps.observe?.({
        kind: 'classified',
        fromModel: classified.fromModel,
        items: classified.items,
      });
    }

    if (!classified.ok) {
      await parkPending('правка ждала разбора выгрузки, а классификация не удалась');
      await saveDraft(db, {
        userId: batch.userId,
        batchId: batch.id,
        text: dumpText,
        reason: `классификация не удалась: ${classified.problem}`,
      });
      happened.fault = `классификация не удалась: ${classified.problem}`;
      await answer(texts.answer.savedUnparsed);
      return;
    }

    /**
     * Сферы по содержанию (правка заказчицы 14.09.2026, п. 1.1): модель
     * назвала сферу не из списка — бот заводит её сам, в пределах
     * настройки и не возвращая выключенных человеком.
     *
     * **Не из ветки.** Написав в ветку «здоровье», человек уже выбрал
     * сферу сам; догадка модели о новой сфере его выбор не перебивает —
     * «если не уверен — лучше без новой сферы» (её слова). В общем чате
     * контекста нет, и названное моделью — единственное указание.
     */
    /**
     * Эхо самопоправки — не запись (стенд 21.09.2026, `live-14`): из
     * «хотя нет к врачу лучше в пятницу» извлечение делает отдельную
     * единицу, а день у «отвезти дочку к врачу» уже перенесён. Условия —
     * в `retraction-echo.ts`; считается по текстам единиц после
     * классификации, вход модели не меняется.
     */
    const echoes = retractionEchoes(
      classified.items.map((item) => item.text),
      combined,
    );
    const kept = classified.items.filter((_, index) => !echoes.has(index));

    if (echoes.size > 0) {
      deps.logger?.info(
        { batchId: batch.id, count: echoes.size },
        'Эхо самопоправки среди единиц: записью не становится',
      );
    }

    const adopted =
      threadTopic === undefined
        ? await adoptWantedTopics(db, {
            userId: batch.userId,
            units: kept,
            maxTopics: await deps.settings?.number('maxTopics'),
            logger: deps.logger,
          })
        : { units: kept };

    /**
     * §8.1: тема ветки — умолчание, а не приказ.
     *
     * Классификация уже получила её параметром `defaultTopic`, но тот
     * срабатывает только на теме, которой у человека нет, — то есть в
     * бою никогда. Подстановка живёт здесь: см. thread-topic.ts.
     */
    const placed = applyThreadTopic(adopted.units, {
      threadTopic: threadTopic?.name,
      catchAllTopic: topics.defaultName,
    });

    // Темы под записи: заводятся те, куда что-то легло, под пределом из
    // настроек; не поместившееся — в тему по умолчанию (`ensure.ts`).
    const withTopics = await settleTopics(db, {
      userId: batch.userId,
      units: placed,
      defaultTopic: topics.defaultName,
      maxTopics: await deps.settings?.number('maxTopics'),
    });
    // Изменяемый список: поздние мысли дописываются в него ниже.
    const units = [...withTopics.units];

    // ── Сохранение ──────────────────────────────────────────────────────
    /**
     * Повтор той же выгрузки не заводит вторую запись (см. same-text.ts).
     *
     * Открытые записи всё равно читаются ниже для отбора — но читать их
     * надо **до** вставки, иначе только что вставленное само себе
     * покажется повтором.
     *
     * Сверка идёт по трёмстам свежайшим открытым записям — потолку
     * `openItemsFor`. Повтор того, что человек говорил триста записей
     * назад, пройдёт незамеченным, и это осознанный предел: тянуть в
     * память весь бэклог ради редкого случая дороже одной лишней строки.
     */
    const before = await openItemsFor(db, batch.userId);
    const split = splitKnown(units, knownByText(before));

    /**
     * Вектор — только тому, что будет сохранено, и потому **после**
     * отсева, а не до.
     *
     * Ревизия этапов 1–2, дефект 32: вектор считался по всем единицам, а
     * отсев шёл следующей строкой. Повтору запись не нужна — значит не
     * нужен и вектор: свежий никуда не записывался (в строку он попадает
     * только у новой записи), а у существующей он посчитан при создании
     * или досчитывается отдельно (`backfill-embeddings`) — отсюда ему
     * взяться неоткуда. Тот самый боевой случай, ради которого отсев и
     * появился, — одно голосовое трижды — оплачивал векторы трижды. Учёт
     * при этом был верен, деньги просто уходили в никуда. Платит
     * отправка, а не результат: где черта оплаты, там и граница отсева.
     */
    const toSave = await withEmbeddings(db, deps, batch, split.fresh);

    const saved = await saveItems(db, {
      userId: batch.userId,
      batchId: batch.id,
      items: toSave,
    });

    for (const item of [...saved, ...split.known]) mentioned.add(item.id);

    /**
     * Второй проход по правкам, чья цель не нашлась (задача 3.24).
     *
     * **Найдено на боевом 01.09.2026.** Человек в одной выгрузке сказал
     * «…приходила не в 11, а в 9», и сразу «Нет, лучше не в 9, а в 9 30».
     * Первая фраза стала записью, вторая — правкой, но правки разбираются
     * до сохранения, и цели для неё в базе ещё не было. Поправка ушла в
     * невидимый черновик, а в записи осталось промежуточное значение — 9
     * вместо 9:30. Человек об этом не узнал.
     *
     * Теперь записи сохранены, и та же правка находит цель среди них.
     *
     * **Почему второй проход, а не перестановка шагов.** Разбирать правки
     * после сохранения целиком нельзя: «нет, в пятницу» тогда попадало бы
     * в свежую запись вместо прежней — ровно то, от чего порядок и
     * защищает. Второй проход платит лишним вызовом резолвера только
     * там, где первый не справился.
     *
     * Стоит он ноль, когда таких правок нет, — а это обычный случай.
     */
    for (const segment of searchOwnBatch) {
      await useOutcome(segment, await resolveOne(segment, true), 'ownBatch');
    }

    /**
     * Последняя попытка — по всем записям человека.
     *
     * Сюда попадает правка, которая шла после мысли (а значит выглядела
     * поправкой к ней), но в своей выгрузке цели не нашла. Значит человек
     * всё-таки говорил о прошлом — например, вспомнил о старом деле в
     * середине потока.
     */
    for (const segment of searchEverywhere) {
      await useOutcome(segment, await resolveOne(segment), 'wide');
    }

    // ── Поздние мысли ───────────────────────────────────────────────────
    /**
     * Мысль, принятая за правку после первой мысли (ревизия этапа 3,
     * A4-средняя).
     *
     * Правка после мысли разбирается уже после извлечения и сохранения.
     * Если резолвер, глядя на записи, говорит «это новая мысль», в
     * прошедший разбор её не вставить — прежде слова ложились черновиком
     * с «Сохранила целиком», и обещание маршрутизатора «запись всё равно
     * появится» после первой мысли было неправдой. Теперь такие слова
     * получают свой проход: извлечение и классификация только их, дальше
     * — тот же путь, что у остальных единиц: отсев повторов, вектор,
     * сохранение, отбор и ответ.
     *
     * Цена — два вызова модели, и только в этом случае: у обычной
     * выгрузки поздних мыслей нет, и проход не стоит ничего. Не вышло —
     * извлечение не удалось или единиц не нашло — прежний путь: черновик
     * и слово человеку. «Хотя нет, в пятницу», которое резолвер по ошибке
     * назвал мыслью, задачей так не станет: настоящее извлечение из
     * обрывка единиц не даёт.
     */
    const absorbLateThoughts = async (): Promise<{
      readonly units: readonly ClassifiedItem[];
      readonly saved: readonly Item[];
      readonly known: readonly Item[];
      /** Единицы, которых у человека ещё не было: их и называет признание. */
      readonly fresh: readonly ClassifiedItem[];
    }> => {
      const nothing = { units: [], saved: [], known: [], fresh: [] };
      if (lateThoughts.length === 0) return nothing;

      const spokenLate = lateThoughts.map((segment) => segment.text).join('\n');

      const park = async (reason: string, fault = false): Promise<typeof nothing> => {
        // Сбой модели — во «Ошибки», а не в «Не поняла» (п. 4).
        if (fault) happened.fault = reason;
        for (const segment of lateThoughts) {
          happened.parked = true;
          sayParked(texts.answer.savedUnparsed);
          await saveDraft(db, {
            userId: batch.userId,
            batchId: batch.id,
            text: segment.text,
            reason,
          });
        }

        return nothing;
      };

      const lateExtracted = await extractUnits(heavy, {
        input: spokenLate,
        userId: batch.userId,
        batchId: batch.id,
      });

      if (!lateExtracted.ok) {
        return await park(`поздняя мысль: извлечение не удалось: ${lateExtracted.problem}`, true);
      }

      deps.observe?.({ kind: 'extracted', dumpText: spokenLate, units: lateExtracted.units });

      if (lateExtracted.units.length === 0) {
        return await park('поздняя мысль: извлечение не нашло в ней единиц');
      }

      const lateClassified = await classifyUnits(heavy, {
        units: lateExtracted.units,
        spoken: spokenLate,
        // Правилам дня — речь целиком, как и у основного прохода.
        speech: combined,
        // …и слова записей основного прохода — человека (единицы) и
        // модели: их день — не поздней мысли («записать сына к врачу в
        // четверг, купить молоко», 17.09.2026). Единицы обязательны:
        // заголовок со сроком уже без своего дня.
        siblings: [
          ...extracted.units.map((unit) => unit.text),
          ...classified.items.map((item) => item.text),
        ],
        topics: topics.names,
        defaultTopic: threadTopic?.name ?? topics.defaultName,
        timeZone: context.timeZone,
        now,
        userId: batch.userId,
        batchId: batch.id,
      });

      if (!lateClassified.ok) {
        return await park(
          `поздняя мысль: классификация не удалась: ${lateClassified.problem}`,
          true,
        );
      }

      deps.observe?.({
        kind: 'classified',
        fromModel: lateClassified.fromModel,
        items: lateClassified.items,
      });

      // Сферы по содержанию — и у поздней записи (п. 1.1), тем же путём
      // и с той же оговоркой про ветку.
      const lateAdopted =
        threadTopic === undefined
          ? await adoptWantedTopics(db, {
              userId: batch.userId,
              units: lateClassified.items,
              maxTopics: await deps.settings?.number('maxTopics'),
              logger: deps.logger,
            })
          : { units: lateClassified.items };
      const latePlaced = applyThreadTopic(lateAdopted.units, {
        threadTopic: threadTopic?.name,
        catchAllTopic: topics.defaultName,
      });
      const { units: lateUnits } = await settleTopics(db, {
        userId: batch.userId,
        units: latePlaced,
        defaultTopic: topics.defaultName,
        maxTopics: await deps.settings?.number('maxTopics'),
      });

      // Повторы — против всех открытых записей, включая только что
      // сохранённые основным проходом.
      const lateSplit = splitKnown(lateUnits, knownByText(await openItemsFor(db, batch.userId)));
      const lateSaved = await saveItems(db, {
        userId: batch.userId,
        batchId: batch.id,
        items: await withEmbeddings(db, deps, batch, lateSplit.fresh),
      });

      return { units: lateUnits, saved: lateSaved, known: lateSplit.known, fresh: lateSplit.fresh };
    };

    const late = await absorbLateThoughts();
    units.push(...late.units);
    saved.push(...late.saved);
    for (const item of [...late.saved, ...late.known]) mentioned.add(item.id);

    // ── Отбор и ответ ───────────────────────────────────────────────────
    /**
     * Признание называет только новое (живой прогон Никиты 23.09.2026):
     * «Забрать посылку», уже записанная, получала «Записала 1 дело…
     * Посылку ты уже записывала — вторую не завела»: одна строка
     * противоречила другой. Уже имеющееся называет живая строка, счёт и
     * сферы — только заведённое сейчас.
     */
    const freshUnits = [...split.fresh, ...late.fresh];
    const composition = composeOf(units);
    const recorded = composeOf(freshUnits);
    /**
     * Одни чувства — старые дела не вытаскивать (решение заказчицы
     * 13.09.2026, ответ 1.4; ревизия этапа 3, E19), а ответ — одно
     * признание без вопроса и кнопок (правка 14.09.2026, п. 1.5).
     *
     * §13.2 её ТЗ на монолог без дел подставлял три дела из бэклога. Она
     * это отменила: человек поделился состоянием, а получил задачи — это
     * давление. Выдача тогда пустая; форму ответа по признаку решает
     * презентация. Кризис сюда не доходит — он остановлен раньше своим
     * сценарием.
     */
    const feelingsOnly =
      units.length > 0 &&
      composition.tasks + composition.desires + composition.ideas + composition.infos === 0;

    const open = await openItemsFor(db, batch.userId);
    const selection: SelectionResult = feelingsOnly
      ? { shown: [], hidden: open.length }
      : /**
         * Уровня сил больше нет (правка заказчицы 14.09.2026, п. 1.2):
         * ни «сил нет вовсе» с одним делом (§13.7, §21 п.7 её ТЗ), ни
         * сохранённого на день состояния. Дел — до трёх всегда; короткая
         * форма при эмоции остаётся в презентации.
         */
        selectForOutput(open, { now, timeZone: context.timeZone, mentioned });

    /**
     * §12.2: онбординг идёт после первой выгрузки. Начинается он, когда
     * разбор действительно состоялся: спрашивать сферы жизни у человека,
     * чья первая выгрузка оказалась «привет», рано.
     *
     * Свой вопрос ответ при этом не задаёт: его место занимает первый
     * вопрос онбординга, иначе у человека окажется два открытых вопроса
     * подряд, чего §13.9 не допускает.
     *
     * Пока опрос идёт, разбор своего вопроса не задаёт. Человек мог
     * наговорить ещё раз, не ответив на предыдущий вопрос онбординга. Тот
     * вопрос никуда не делся, и добавить к нему второй значит нарушить
     * §13.9 — пусть и двумя репликами, а не одной. Состояние
     * (`onboarding`, `onboardingOpen`) прочитано в начале разбора.
     */

    /**
     * Застрявший опрос дозадаётся, а не только начинается (задача 3.43).
     *
     * Прежде вопрос уходил только с нуля. Кто не ответил и стал говорить
     * дальше, оставался на своём шаге навсегда: 2.13 обещала, что
     * «незаданные вопросы дождутся своей очереди», а очередь не
     * наступала. Так проджект заказчицы простоял сутки на вопросе про
     * вечер — и без последнего шага у него не появилось ни одной сферы.
     *
     * Один вопрос на реплику при этом соблюдён: свой вопрос разбор в
     * это время не задаёт (см. выше), место занимает вопрос опроса.
     */
    const startOnboarding =
      deps.onboarding !== undefined &&
      target !== undefined &&
      (onboarding.step === 0 || onboardingOpen)
        ? {
            sender: deps.onboarding,
            target,
            step: onboarding.step === 0 ? firstStep(onboarding.name) : onboarding.step,
          }
        : undefined;

    /**
     * §13.3: короткое добавление не порождает выдачу действий.
     *
     * Решается здесь, а не в промпте: правило, живущее в промпте, плавает
     * от версии к версии, и «Записала» приходило бы через раз. К форме
     * ответа человек привыкает быстрее, чем к чему бы то ни было ещё.
     */
    const quickAdd = isQuickAdd({
      /**
       * Во время онбординга режим не включается.
       *
       * §13.3 просит не открывать разговор, а онбординг — это разговор,
       * который уже идёт: его вопрос приходит вместе с этой же репликой.
       * «Записала.» проглотило бы контекст, и человек получил бы вопрос
       * про сферы жизни без всякого повода. Поймали два старых теста.
       */
      asked: happened.asked || startOnboarding !== undefined || onboardingOpen,
      /**
       * Часть сказанного не разобралась — значит не быстрое добавление
       * (задача 3.32, найдено живым прогоном через Telegram 02.09.2026).
       *
       * Человек повторил выгрузку целиком: одно дело узналось как уже
       * имеющееся, а поправка к нему ушла в черновик. Осталась одна
       * запись и маркер «ещё» в тексте — и бот ответил «Записала.» на то,
       * чего не записывал, промолчав о неразобранном.
       *
       * §13.3 задумано для «добавь ещё X» — короткой просьбы и ничего
       * больше. Если в выгрузке осталось непонятое, короткой репликой
       * отвечать нельзя: она делает вид, что всё в порядке.
       */
      parked: happened.parked,
      /**
       * Считается всё, что вышло из выгрузки, а не только заведённое.
       *
       * Отсев повторов не должен менять **разговор** — только базу. Иначе
       * «добавь ещё купить витамины» на уже имеющемся деле переставало бы
       * быть быстрым добавлением и отвечало полным разбором: человек
       * сказал одно дело, а получил список.
       */
      created: saved.length + split.known.length + late.known.length,
      hidden: selection.hidden,
      emotions: composition.emotions,
      spoken: dumpText,
    });

    /**
     * Реплика быстрого добавления называет записанное (проджект, бой
     * 21.09.2026): «Поймала. Разберём, когда дойдём» не показывало, что
     * именно записано. Запись при быстром добавлении одна — считается
     * выше, — и она берётся из тех же трёх источников, что и счёт.
     */
    const added = quickAdd ? [...saved, ...split.known, ...late.known][0] : undefined;
    const quickAdded =
      added === undefined
        ? undefined
        : {
            // Тема у записи всегда есть — без своей она ложится в тему по
            // умолчанию; пустота здесь только на бумаге схемы.
            topic: withCapital(added.topic ?? topics.defaultName),
            title: withCapital(added.text),
          };

    /**
     * Пробный период тратит разобранная выгрузка (§14, задача 4.3).
     *
     * **Здесь, а не в конвейере при статусе «done».** До этой строки
     * стоят четыре выхода: разбирать нечего, извлечение не удалось,
     * единиц ноль, классификация не удалась. Ни один из них права
     * человека тратить не должен — он не виноват ни в нашей поломке, ни
     * в том, что сказал «привет». Статус «done» их не различает.
     *
     * **И быстрое добавление тоже тратит — это правка ревизии.** План
     * 4.3 требовал обратного («быстрые добавления не считаются») и
     * обосновывал так: «полсекунды не равны разбору». Обоснование
     * держалось на неверном факте: признак `quickAdd` вычисляется
     * **после** маршрутизатора, извлечения, классификации и векторов —
     * из платных этапов быстрое добавление пропускает единственный,
     * презентацию. Заплачено четыре из пяти. Человек, формулирующий
     * мысли как «добавь ещё …», не кончал пробный период никогда, а в
     * карточке панели это выглядело как «потрачено 0» при десятках
     * разобранных выгрузок. Требование плана исправлено вместе с кодом.
     *
     * Отметка идемпотентна: повторная обработка той же выгрузки — а она
     * бывает, конвейер возвращает выгрузку в очередь при временном
     * сбое — период дважды не тратит.
     */
    {
      /**
       * Предел читается **здесь**, а не внутри отметки.
       *
       * Отметка — запись в базу, и тащить в неё реестр настроек значило
       * бы дать ей второго читателя настроек. Читаем один раз и передаём
       * значением: тогда момент «пробный кончился» хранит именно то
       * число, которое действовало в эту секунду.
       */
      const trialLimit = await deps.settings?.number('trialDumps');

      await markTrialSpent(db, {
        batchId: batch.id,
        now,
        ...(trialLimit === undefined ? {} : { trialLimit }),
      });
    }

    /**
     * §13.2: большая цель урезается до посильного первого шага.
     *
     * В выдаче проект занимает одну строку, и это должна быть строка
     * шага, а не заголовок цели. «Спланировать годовщину родителей» в
     * ответ на «что сегодня» — это не действие, а напоминание о горе.
     *
     * Раскладывать здесь не станем: разложение ленивое и случается при
     * обращении к проекту. Неразложенный проект показывается как есть —
     * так же, как показывался до третьего этапа.
     */
    const actions = (await withNextSteps(db, selection.shown)).map((item) => item.text);

    /**
     * Живая строка (слой A, 22.09.2026): одна-две фразы от модели о том,
     * что бот помнит, — поверх ответа, который собирает код. Факты ей
     * даёт код закрытым списком (`context-pack.ts`), строку проверяет
     * страж (`context-line.ts`); не прошла или модель молчит — ответ как
     * прежде. Не зовётся: при одних чувствах (там её слова из словаря),
     * при быстром добавлении (одна строка по §13.3), без дел и желаний
     * (не о чем), и при выключателе в панели — тогда и расхода нет.
     */
    const hasRecorded = units.some((unit) => unit.type === 'TASK' || unit.type === 'DESIRE');
    const wantsLine =
      hasRecorded &&
      !feelingsOnly &&
      quickAdded === undefined &&
      ((await deps.settings?.number('contextLine')) ?? 1) !== 0;
    let contextLine: string | undefined;
    if (wantsLine) {
      const pack = packContext({
        now,
        timeZone: context.timeZone,
        texts,
        batchId: batch.id,
        units,
        known: [...split.known, ...late.known].map((item) => item.text),
        // Открытые дела — прочитанные до вставки: своё новое не «прежнее».
        openItems: before,
        mood,
        ...(await loadContextFacts(db, { userId: batch.userId, batchId: batch.id, now })),
      });
      contextLine = (await askContextLine(ai, { userId: batch.userId, batchId: batch.id, pack }))
        .line;
      // О ком сказала — три дня не повод: один и тот же «про отчёт помню»
      // в каждой выгрузке подряд снова читался бы шаблоном.
      if (contextLine !== undefined) {
        await markLineMentions(db, {
          userId: batch.userId,
          itemIds: mentionedIn(contextLine, pack.candidates ?? []),
          now,
        });
      }
    }

    const presented = presentDump({
      composition,
      recorded,
      actions,
      contextLine,
      // «Сделать сейчас» ведёт к первому из показанных (E2).
      firstItemId: selection.shown[0]?.id,
      hidden: selection.hidden,
      profile: context.textProfile,
      userId: batch.userId,
      batchId: batch.id,
      /**
       * Вопрос уже занят — своего ответ не задаёт.
       *
       * Так было у онбординга; с §13.6 сюда добавился экран возвращения.
       * Инвариант «один вопрос» продукт понимает как один на обмен, а не
       * на реплику: два вопроса подряд разными сообщениями — тот же
       * допрос.
       */
      omitQuestion: happened.asked || startOnboarding !== undefined || onboardingOpen,
      feelingsOnly,
      mood,
      quickAdd: quickAdded,
      // Раскладка по сферам и «на сегодня / на завтра» — по разобранным
      // единицам этой выгрузки (заказчица, 16.09.2026, п. 3).
      summary: summarizeDump(freshUnits, { now, timeZone: context.timeZone }),
    });
    /**
     * Под признанием кнопки «Оставить как есть» / «Выбрать главное»
     * (решение заказчицы 15.09.2026); список дел — по кнопке, из
     * `pickMain`, в момент нажатия. Чтобы сказанное сейчас шло там первым
     * (3.24), упомянутое запоминается в выгрузке: по `sourceBatchId` его
     * не восстановить — повтор дела остаётся в своей первой выгрузке.
     * Выдача выше по-прежнему считается: она идёт модели как состав
     * того, что предложится, — вход презентера не менялся.
     */
    await rememberMentioned(db, batch.id, [...mentioned]);

    deps.logger?.info(
      {
        batchId: batch.id,
        segments: routed.segments.length,
        deferred: deferred.length,
        units: extracted.units.length,
        saved: split.fresh.length,
        known: split.known.length,
        late: late.saved.length,
        shown: selection.shown.length,
        hidden: selection.hidden,
        corrections: classified.corrections,
      },
      'Выгрузка разобрана',
    );

    // §13.2: под разбором три кнопки, и одна из них ведёт к остальным
    // делам. Без неё человек не знал, куда они делись.
    // Припаркованная правка — строкой под ответом, а не молча (A4).
    await answer(
      parkedWords.length > 0
        ? `${presented.reply.text}\n\n${parkedWords.join('\n')}`
        : presented.reply.text,
      presented.reply.buttons,
    );

    /**
     * Карточка 04 при первом деле с часом (ТЗ по визуалам 18.09.2026):
     * после ответа, своим сообщением, один раз на человека. Дальше дела
     * с часом идут без картинки — визуалы редкие.
     */
    const withHour = saved.find((item) => item.deadlineTime !== null);
    if (withHour !== undefined && deps.cards !== undefined && target !== undefined) {
      await showFirstReminderCard(
        { db, cards: deps.cards, logger: deps.logger },
        {
          userId: batch.userId,
          chatId: target.chatId,
          threadId: target.threadId,
          itemId: withHour.id,
          texts,
          now,
        },
      );
    }

    /**
     * Разбор вчерашнего при следующем обращении (запрос на изменение №4,
     * решение заказчицы 13.09.2026): утренние выключены — просроченное
     * разбирается здесь, отдельным сообщением после ответа, один раз;
     * включены — его место утром, и здесь ничего не показывается.
     * Нетронутое с прошлого показа перед этим уходит в «Позже» — то же
     * правило, что у утреннего. Отправитель с рядами кнопок — тот же,
     * что задаёт вопросы опроса.
     */
    await reviewAtInteraction(db, deps, batch.userId, target, context.timeZone, now);

    /**
     * §8.2: сводка темы обновляется правкой закреплённого сообщения.
     *
     * **После ответа человеку, а не до.** Обновление сводок — это до трёх
     * обращений к Telegram с паузами между ними, и заставлять человека
     * ждать их, чтобы увидеть свой разбор, — значит перепутать главное с
     * подсобным. Ответ уходит первым.
     *
     * Обновляются только затронутые темы: трогать девять веток из-за
     * одной новой записи значит без нужды упираться в ограничение частоты.
     *
     * Отказ здесь разбор не роняет: сводка — удобство, записи — суть.
     */
    if (deps.topics && target) {
      await refreshSummaries(
        { db, gateway: deps.topics, logger: deps.logger },
        {
          userId: batch.userId,
          chatId: target.chatId,
          /**
           * Сферы только что появились — ветки создаются **все**, включая
           * пустые: человек должен увидеть свою структуру целиком, а не
           * только те сферы, куда что-то попало. То же правило, что на
           * онбординге. Дальше — только затронутые.
           *
           * Темы берутся по всем разобранным единицам (`units`), а не
           * только по сохранённым: повтор запись не заводит, но человек о
           * ней сейчас говорил, и её тема тоже считается затронутой.
           */
          topicNames: [...new Set([...units.map((item) => item.topic), ...touchedTopics])],
          timeZone: context.timeZone,
          profile: context.textProfile,
        },
      );
    }

    /**
     * Бот замечает повторяемость (задача 3.8в).
     *
     * **Предложение конкурирует за единственный вопрос и проигрывает.**
     * Инвариант 10: один вопрос в реплике. Уточняющий вопрос резолвера
     * всегда важнее — там цена ошибки выше, там портится существующая
     * запись. Если он уже задан, предложение не задаётся вовсе и не
     * встаёт в очередь: дело регулярное, оно повторится, и случай
     * представится снова.
     *
     * Вопрос онбординга занимает то же единственное место, поэтому блок
     * стоит после него, а не до: иначе человек получил бы два вопроса в
     * одном обмене, чего §13.9 не допускает.
     */
    if (deps.suggestRecurrence === true && !happened.asked && !startOnboarding && !onboardingOpen) {
      for (const item of saved) {
        const suggestion = await suggestRecurrence(
          { db, ...(deps.logger === undefined ? {} : { logger: deps.logger }) },
          { userId: batch.userId, item, now },
        );

        if (suggestion === undefined) continue;

        await tell(
          texts.resolver.noticed(
            suggestion.title,
            datesInWords(suggestion.dates, context.timeZone),
            rhythmInWords(suggestion.rhythm),
          ),
          suggestButtons(suggestion.suggestionId, texts),
        );

        // Одно предложение на выгрузку, даже если совпадений несколько.
        break;
      }
    }

    if (startOnboarding) {
      const question = questionFor(startOnboarding.step, { texts, name: onboarding.name });

      if (question) {
        await setStep(db, batch.userId, startOnboarding.step);
        await startOnboarding.sender.ask({
          chatId: startOnboarding.target.chatId,
          threadId: startOnboarding.target.threadId,
          text: question.text,
          rows: question.rows,
        });
      }
    }
  };
}
