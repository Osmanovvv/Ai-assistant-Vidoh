import type { Logger } from 'pino';

import type { Batch, EnergyLevelValue } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { textsFor } from '../../texts/index.js';
import type { AiClientDeps } from '../ai/client.js';
import { decideDegradation, type SpendLimit } from '../metering/limits.js';
import { classifyUnits, type ClassifiedItem } from '../classifier/classifier.service.js';
import { embedText } from '../embedder/embedder.service.js';
import type { EmbeddingProvider } from '../embedder/providers/types.js';
import { extractUnits } from '../extractor/extractor.service.js';
import { openItemsFor, saveDraft, saveItems, type ItemToSave } from '../items/items.repo.js';
import { effectiveEnergy, selectForOutput } from '../output/filter.js';
import {
  firstStep,
  onboardingStateOf,
  questionFor,
  setStep,
  STEP,
} from '../onboarding/onboarding.service.js';
import { composeOf, presentDump } from '../presenter/presenter.service.js';
import type { QuestionSender } from '../presenter/telegram-sender.js';
import {
  finishStatus,
  showStatus,
  type StatusSender,
  type StatusTarget,
} from '../presenter/status.service.js';
import { routeIntents, type Segment } from '../router/router.service.js';
import { detectByMarkers, detectCrisis, type CrisisOutcome } from '../safety/crisis.js';
import type { TopicGateway } from '../topics/gateway.js';
import { refreshSummaries } from '../topics/summary.service.js';
import { topicsFor } from '../topics/topics.repo.js';
import { topicByThread } from '../topics/topics.service.js';
import { lowerEnergy, outputContextOf } from '../users/state.repo.js';
import type { BatchHandler } from './pipeline.service.js';
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

/** Намерения, которые этап 2 разбирает сам. */
const PARSED_INTENTS = new Set(['DUMP']);

/**
 * Намерения, которые ничего не создают и ничего не ждут.
 *
 * «Привет» и «спасибо» не мысли и не дела. Черновик из них был бы мусором
 * в админке, а §13.9 требует от бота короткой реплики, а не разбора.
 */
const IGNORED_INTENTS = new Set(['SMALLTALK']);

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
): Promise<void> {
  if (!deps.sender || !target) return;
  await finishStatus({ db, sender: deps.sender }, target, text);
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

    const { combined } = await transcribeBatch(db, batch, deps.speech, {
      onStart: async () => {
        if (!deps.sender || !target) return;
        await showStatus({ db, sender: deps.sender }, target, texts.listening.working);
      },
    });

    if (combined === '') {
      await reply(db, deps, target, texts.listening.nothingHeard);
      return;
    }

    /**
     * §13.7, острый кризис. Первый контур считается здесь — до первого
     * обращения к модели: он ничего не стоит, а значит на настоящем
     * кризисе разбор останавливается до первой потраченной копейки.
     */
    const stopOnCrisis = async (outcome: CrisisOutcome): Promise<boolean> => {
      if (!outcome.detected) return false;

      // В журнал идёт факт и сработавший маркер, но не сказанное:
      // частоту ложных срабатываний оценить надо, читать чужую беду в
      // логах — нет.
      deps.logger?.warn(
        {
          event: 'crisis_detected',
          batchId: batch.id,
          userId: batch.userId,
          contour: outcome.contour,
          marker: outcome.marker,
        },
        'Сработал контур острого кризиса, разбор остановлен',
      );

      // Ни записей, ни черновиков, ни уточняющих вопросов. Текст человека
      // при этом на месте: он сохранён до всякого разбора (инвариант 1).
      await reply(db, deps, target, texts.safety.crisis);
      return true;
    };

    if (await stopOnCrisis(detectByMarkers(combined))) return;

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
    const routed = await routeIntents(aiLight, {
      input: combined,
      userId: batch.userId,
      batchId: batch.id,
    });

    // Второй контур: признак от модели. Маркеры уже проверены, поэтому
    // здесь решает только он.
    if (await stopOnCrisis(detectCrisis(combined, routed.crisis))) return;

    const parsed: Segment[] = [];
    const deferred: Segment[] = [];

    for (const segment of routed.segments) {
      if (PARSED_INTENTS.has(segment.intent)) parsed.push(segment);
      else if (!IGNORED_INTENTS.has(segment.intent)) deferred.push(segment);
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

    if (parsed.length === 0) {
      await reply(
        db,
        deps,
        target,
        deferred.length > 0 ? texts.answer.savedUnparsed : texts.answer.nothingToParse,
      );
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
      await reply(db, deps, target, texts.answer.savedUnparsed);
      return;
    }

    if (extracted.units.length === 0) {
      await reply(db, deps, target, texts.answer.nothingToParse);
      return;
    }

    // ── Классификация ───────────────────────────────────────────────────
    const topics = await topicsFor(db, batch.userId);

    /**
     * §8.1: сообщение внутри ветки обрабатывается в контексте её темы.
     *
     * Тема ветки становится темой по умолчанию — то есть тем, куда уйдёт
     * запись, не попавшая ни в одну тему явно. Женщина, написавшая в
     * ветку «здоровье», не должна получать своё дело в «личном» только
     * потому, что не назвала сферу словами.
     */
    const threadTopic =
      target?.threadId === undefined
        ? undefined
        : await topicByThread(db, batch.userId, target.threadId);

    const classified = await classifyUnits(heavy, {
      units: extracted.units,
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
      await reply(db, deps, target, texts.answer.savedUnparsed);
      return;
    }

    // ── Сохранение ──────────────────────────────────────────────────────
    const toSave = await withEmbeddings(db, deps, batch, classified.items);
    await saveItems(db, { userId: batch.userId, batchId: batch.id, items: toSave });

    // ── Отбор и ответ ───────────────────────────────────────────────────
    const composition = composeOf(classified.items);
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

    const presented = await presentDump(ai, {
      composition,
      actions: selection.shown.map((item) => item.text),
      hidden: selection.hidden,
      profile: context.textProfile,
      userId: batch.userId,
      batchId: batch.id,
      omitQuestion: startOnboarding !== undefined || onboardingOpen,
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

    await reply(db, deps, target, presented.reply.text);

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
