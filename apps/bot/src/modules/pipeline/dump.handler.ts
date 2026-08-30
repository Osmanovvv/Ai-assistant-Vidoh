import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import { items, type Batch, type EnergyLevelValue } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { textsFor } from '../../texts/index.js';
import type { AiClientDeps } from '../ai/client.js';
import { decideDegradation, type SpendLimit } from '../metering/limits.js';
import { classifyUnits, type ClassifiedItem } from '../classifier/classifier.service.js';
import { embedText } from '../embedder/embedder.service.js';
import type { EmbeddingProvider } from '../embedder/providers/types.js';
import { extractUnits } from '../extractor/extractor.service.js';
import { answerBacklogQuery } from '../backlog/query.service.js';
import { openItemsFor, saveDraft, saveItems, type ItemToSave } from '../items/items.repo.js';
import { describeChange, questionButtons, undoButtons } from '../resolver/change-text.js';
import { settlePendingQuestion } from '../resolver/pending.js';
import { datesInWords, rhythmInWords, suggestButtons } from '../recurrence/suggest-text.js';
import { suggestRecurrence } from '../recurrence/suggest.service.js';
import { openQuestionOf } from '../resolver/questions.repo.js';
import { resolvePatchSegment } from '../resolver/segment.js';
import { effectiveEnergy, selectForOutput } from '../output/filter.js';
import {
  firstStep,
  onboardingStateOf,
  questionFor,
  setStep,
  STEP,
} from '../onboarding/onboarding.service.js';
import { composeOf, presentDump } from '../presenter/presenter.service.js';
import { isQuickAdd } from '../presenter/quick-add.js';
import type { QuestionSender } from '../presenter/telegram-sender.js';
import {
  finishStatus,
  showStatus,
  type StatusButton,
  type StatusSender,
  type StatusTarget,
} from '../presenter/status.service.js';
import { routeIntents, type Segment } from '../router/router.service.js';
import {
  detectByMarkers,
  detectCrisis,
  type CrisisContour,
  type CrisisOutcome,
} from '../safety/crisis.js';
import type { TopicGateway } from '../topics/gateway.js';
import { refreshSummaries } from '../topics/summary.service.js';
import { topicsFor } from '../topics/topics.repo.js';
import { topicByThread } from '../topics/topics.service.js';
import { lowerEnergy, outputContextOf } from '../users/state.repo.js';
import type { BatchHandler } from './pipeline.service.js';
import { applyThreadTopic } from './thread-topic.js';
import { statusTarget, transcribeBatch, type TranscribeDeps } from './transcribe.js';

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

export interface DumpHandlerDeps {
  readonly speech: TranscribeDeps;
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
        { db, provider: embedder, logger: deps.logger, pricing: deps.ai.pricing },
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

/** §13.7: высказанное состояние уменьшает объём выдачи и больше ничего. */
async function applyEmotion(
  db: Database,
  deps: DumpHandlerDeps,
  userId: string,
  hasEmotion: boolean,
  current: EnergyLevelValue,
  now: Date,
): Promise<EnergyLevelValue> {
  if (!hasEmotion) return current;

  const lowered = await lowerEnergy(db, userId, 'low', { at: now, current });
  if (lowered) {
    deps.logger?.debug({ userId }, 'Уровень сил снижен: в выгрузке было состояние');
    return 'low';
  }

  return current;
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
    });

    /**
     * Обычный ответ, к которому договаривается предупреждение об обрезке
     * (§10.5 ТЗ).
     *
     * Отдельной репликой это не отправляется: одна выгрузка — один ответ.
     * И к кризисной реплике не договаривается тоже: там человеку не до
     * длины записи (§13.7).
     */
    const answer = async (text: string, buttons?: readonly StatusButton[]): Promise<void> => {
      const tail = `\n\n${texts.listening.tooLong}`;
      await reply(db, deps, target, truncated ? `${text}${tail}` : text, buttons);
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
      await reply(db, deps, target, texts.safety.crisis);
      return true;
    };

    if (await stopOnCrisis(detectByMarkers(combined), 'markers')) return;

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

    const routed = await routeIntents(aiLight, {
      input: combined,
      userId: batch.userId,
      batchId: batch.id,
      ...(askedAbout === undefined ? {} : { openQuestion: texts.resolver.question(askedAbout) }),
    });

    // Второй контур: признак от модели. Маркеры уже проверены, поэтому
    // здесь решает только он.
    if (await stopOnCrisis(detectCrisis(combined, routed.crisis), 'model')) return;

    const parsed: Segment[] = [];
    const deferred: Segment[] = [];
    const answers: string[] = [];
    const questions: string[] = [];

    const patches: Segment[] = [];
    /** Инвариант 10: один вопрос в реплике, и первый его занимает. */
    let askedSomething = false;

    for (const segment of routed.segments) {
      if (segment.intent === ANSWER_INTENT) answers.push(segment.text);
      else if (segment.intent === QUERY_INTENT) questions.push(segment.text);
      else if (PARSED_INTENTS.has(segment.intent)) parsed.push(segment);
      else if (RESOLVED_INTENTS.has(segment.intent)) patches.push(segment);
      else if (!IGNORED_INTENTS.has(segment.intent)) deferred.push(segment);
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

    if (settled.kind === 'applied' && settled.applied !== undefined) {
      // §7.3: показать, что именно изменилось, и дать кнопку отмены.
      await reply(
        db,
        deps,
        target,
        describeChange(settled.applied, texts, context.timeZone),
        undoButtons(settled.applied.revisionId, texts),
      );
    } else if (settled.kind === 'nothingToApply') {
      await reply(db, deps, target, texts.resolver.attached);
    } else if (settled.kind === 'unclear') {
      await reply(db, deps, target, texts.resolver.answerUnclear);
    }

    /**
     * §8.1: сообщение внутри ветки обрабатывается в контексте её темы.
     *
     * Тема ветки становится темой по умолчанию — то есть тем, куда уйдёт
     * запись, не попавшая ни в одну тему явно. Женщина, написавшая в
     * ветку «здоровье», не должна получать своё дело в «личном» только
     * потому, что не назвала сферу словами.
     *
     * Считается до разбора правок: подбор кандидатов сужается той же
     * темой, и по той же причине — правка внутри ветки почти наверняка
     * про запись из неё.
     */
    const threadTopic =
      target?.threadId === undefined
        ? undefined
        : await topicByThread(db, batch.userId, target.threadId);

    /**
     * Правки разбираются по одной и до разбора новых мыслей.
     *
     * По одной, потому что у каждой свои кандидаты и своё решение: пачкой
     * их не рассудить. До мыслей — потому что «нет, в пятницу» относится
     * к тому, что было сказано раньше, и должно попасть в ту запись, а не
     * в новую, которая появится через секунду.
     */
    for (const segment of patches) {
      const outcome = await resolvePatchSegment(
        {
          db,
          ai: heavy,
          ...(deps.embedder === undefined ? {} : { embedder: deps.embedder }),
          ...(deps.ai.pricing === undefined ? {} : { pricing: deps.ai.pricing }),
          ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        },
        {
          userId: batch.userId,
          batchId: batch.id,
          text: segment.text,
          timeZone: context.timeZone,
          ...(threadTopic?.name === undefined ? {} : { topic: threadTopic.name }),
          now,
        },
      );

      if (outcome.kind === 'applied') {
        await reply(
          db,
          deps,
          target,
          describeChange(outcome.applied, texts, context.timeZone),
          undoButtons(outcome.applied.revisionId, texts),
        );
      } else if (outcome.kind === 'asked') {
        askedSomething = true;
        // §7.3: один короткий вопрос с двумя кнопками и заголовком
        // найденной записи в тексте.
        await reply(
          db,
          deps,
          target,
          texts.resolver.question(outcome.itemTitle),
          questionButtons(outcome.questionId, texts),
        );
      } else if (outcome.kind === 'newThought') {
        parsed.push(segment);
      } else {
        await saveDraft(db, {
          userId: batch.userId,
          batchId: batch.id,
          text: segment.text,
          reason: outcome.reason,
        });
      }
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

    for (const question of questions) {
      const answer = await answerBacklogQuery(
        {
          db,
          ...(deps.embedder === undefined ? {} : { embedder: deps.embedder }),
          ...(deps.ai.pricing === undefined ? {} : { pricing: deps.ai.pricing }),
          ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        },
        { userId: batch.userId, text: question, batchId: batch.id, now },
      );

      const header =
        answer.kind === 'today'
          ? texts.backlog.today
          : answer.kind === 'about'
            ? texts.backlog.about
            : texts.backlog.nothing;

      const body =
        answer.kind === 'nothing' ? [] : answer.items.map((item) => texts.backlog.line(item.text));

      await reply(db, deps, target, [header, ...body].join('\n'));
    }

    if (parsed.length === 0) {
      await answer(deferred.length > 0 ? texts.answer.savedUnparsed : texts.answer.nothingToParse);
      return;
    }

    const dumpText = parsed.map((segment) => segment.text).join('\n');

    // ── Единицы ─────────────────────────────────────────────────────────
    const extracted = await extractUnits(heavy, {
      input: dumpText,
      userId: batch.userId,
      batchId: batch.id,
    });

    if (!extracted.ok) {
      await saveDraft(db, {
        userId: batch.userId,
        batchId: batch.id,
        text: dumpText,
        reason: `извлечение не удалось: ${extracted.problem}`,
      });
      await answer(texts.answer.savedUnparsed);
      return;
    }

    if (extracted.units.length === 0) {
      await answer(texts.answer.nothingToParse);
      return;
    }

    // ── Классификация ───────────────────────────────────────────────────
    const topics = await topicsFor(db, batch.userId);

    const classified = await classifyUnits(heavy, {
      units: extracted.units,
      // §3.8б: «запомни» живёт в сказанном, а не в единицах.
      spoken: dumpText,
      topics: topics.names,
      defaultTopic: threadTopic?.name ?? topics.defaultName,
      timeZone: context.timeZone,
      now,
      userId: batch.userId,
      batchId: batch.id,
    });

    if (!classified.ok) {
      await saveDraft(db, {
        userId: batch.userId,
        batchId: batch.id,
        text: dumpText,
        reason: `классификация не удалась: ${classified.problem}`,
      });
      await answer(texts.answer.savedUnparsed);
      return;
    }

    /**
     * §8.1: тема ветки — умолчание, а не приказ.
     *
     * Классификация уже получила её параметром `defaultTopic`, но тот
     * срабатывает только на теме, которой у человека нет, — то есть в
     * бою никогда. Подстановка живёт здесь: см. thread-topic.ts.
     */
    const units = applyThreadTopic(classified.items, {
      threadTopic: threadTopic?.name,
      catchAllTopic: topics.defaultName,
    });

    // ── Сохранение ──────────────────────────────────────────────────────
    const toSave = await withEmbeddings(db, deps, batch, units);
    const saved = await saveItems(db, { userId: batch.userId, batchId: batch.id, items: toSave });

    // ── Отбор и ответ ───────────────────────────────────────────────────
    const composition = composeOf(units);
    const energyNow = await applyEmotion(
      db,
      deps,
      batch.userId,
      composition.emotions > 0,
      effectiveEnergy(context.state, context.energyDefault, { now, timeZone: context.timeZone }),
      now,
    );

    const selection = selectForOutput(await openItemsFor(db, batch.userId), {
      energy: energyNow,
      now,
      timeZone: context.timeZone,
      /**
       * §13.7 и §21 п.7: если человек сказал о своём состоянии, действие
       * в ответе ровно одно — «короткое признание, сокращение объёма,
       * одно действие». Не два, как даёт уровень «сил мало»: два дела
       * человеку, который только что сказал «сил нет», — это спор с ним.
       */
      ...(composition.emotions > 0 ? { cap: 1 } : {}),
    });

    /**
     * §12.2: онбординг идёт после первой выгрузки. Начинается он, когда
     * разбор действительно состоялся: спрашивать сферы жизни у человека,
     * чья первая выгрузка оказалась «привет», рано.
     *
     * Свой вопрос ответ при этом не задаёт: его место занимает первый
     * вопрос онбординга, иначе у человека окажется два открытых вопроса
     * подряд, чего §13.9 не допускает.
     */
    const onboarding = await onboardingStateOf(db, batch.userId);

    // Отправитель и адресат забираются сразу вместе: разбирать их по
    // отдельности ниже пришлось бы второй раз, и проверка задвоилась бы.
    const startOnboarding =
      onboarding.step === 0 && deps.onboarding !== undefined && target !== undefined
        ? { sender: deps.onboarding, target, step: firstStep(onboarding.name) }
        : undefined;

    /**
     * Пока опрос идёт, разбор своего вопроса не задаёт.
     *
     * Человек мог наговорить ещё раз, не ответив на предыдущий вопрос
     * онбординга. Тот вопрос никуда не делся, и добавить к нему второй
     * значит нарушить §13.9 — пусть и двумя репликами, а не одной.
     */
    const onboardingOpen = onboarding.step > 0 && onboarding.step < STEP.done;

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
      asked: askedSomething || startOnboarding !== undefined || onboardingOpen,
      created: saved.length,
      hidden: selection.hidden,
      emotions: composition.emotions,
      spoken: dumpText,
    });

    const presented = await presentDump(ai, {
      composition,
      actions: selection.shown.map((item) => item.text),
      hidden: selection.hidden,
      profile: context.textProfile,
      userId: batch.userId,
      batchId: batch.id,
      omitQuestion: startOnboarding !== undefined || onboardingOpen,
      quickAdd,
    });

    deps.logger?.info(
      {
        batchId: batch.id,
        segments: routed.segments.length,
        deferred: deferred.length,
        units: extracted.units.length,
        saved: toSave.length,
        shown: selection.shown.length,
        hidden: selection.hidden,
        corrections: classified.corrections,
        acknowledgementReplaced: presented.replaced,
      },
      'Выгрузка разобрана',
    );

    // §13.2: под разбором три кнопки, и одна из них ведёт к остальным
    // делам. Без неё человек не знал, куда они делись.
    await answer(presented.reply.text, presented.reply.buttons);

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
          topicNames: toSave.map((item) => item.topic),
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
    if (deps.suggestRecurrence === true && !askedSomething && !startOnboarding && !onboardingOpen) {
      for (const item of saved) {
        const suggestion = await suggestRecurrence(
          { db, ...(deps.logger === undefined ? {} : { logger: deps.logger }) },
          { userId: batch.userId, item, now },
        );

        if (suggestion === undefined) continue;

        await reply(
          db,
          deps,
          target,
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
