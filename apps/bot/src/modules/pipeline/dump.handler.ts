import type { Logger } from 'pino';

import type { Batch, EnergyLevelValue } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { textsFor } from '../../texts/index.js';
import type { AiClientDeps } from '../ai/client.js';
import { classifyUnits, type ClassifiedItem } from '../classifier/classifier.service.js';
import { embedText } from '../embedder/embedder.service.js';
import type { EmbeddingProvider } from '../embedder/providers/types.js';
import { extractUnits } from '../extractor/extractor.service.js';
import { openItemsFor, saveDraft, saveItems, type ItemToSave } from '../items/items.repo.js';
import { effectiveEnergy, selectForOutput } from '../output/filter.js';
import { composeOf, presentDump } from '../presenter/presenter.service.js';
import {
  finishStatus,
  showStatus,
  type StatusSender,
  type StatusTarget,
} from '../presenter/status.service.js';
import { routeIntents, type Segment } from '../router/router.service.js';
import { detectByMarkers, detectCrisis, type CrisisOutcome } from '../safety/crisis.js';
import { topicsFor } from '../topics/topics.repo.js';
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
   * Провайдер смысловых представлений. Без него записи сохраняются без
   * векторов: разбор дороже поиска, и терять его из-за эмбеддингов нельзя.
   */
  readonly embedder?: EmbeddingProvider | undefined;
  readonly sender?: StatusSender | undefined;
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
    const target = deps.sender ? await statusTarget(db, batch.id) : undefined;
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

    for (const segment of deferred) {
      // Текст не теряется и виден в админке: разберёт его резолвер на
      // третьем этапе, когда появится, к чему применять правку.
      await saveDraft(db, {
        userId: batch.userId,
        batchId: batch.id,
        text: segment.text,
        reason: `намерение ${segment.intent} — ждёт резолвера (этап 3)`,
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
    const extracted = await extractUnits(ai, {
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
    const classified = await classifyUnits(ai, {
      units: extracted.units,
      topics: topics.names,
      defaultTopic: topics.defaultName,
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

    const presented = await presentDump(ai, {
      composition,
      actions: selection.shown.map((item) => item.text),
      hidden: selection.hidden,
      profile: context.textProfile,
      userId: batch.userId,
      batchId: batch.id,
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
  };
}
