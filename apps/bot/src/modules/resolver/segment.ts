import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import type { AiClientDeps } from '../ai/client.js';
import { embedText } from '../embedder/embedder.service.js';
import type { EmbeddingProvider } from '../embedder/providers/types.js';
import type { ModelPricing } from '../metering/pricing.js';
import { collectCandidates } from './candidates.js';
import { applyDecision, type Applied } from './patch.js';
import { mentionedPeriod } from './period.js';
import { askQuestion } from './questions.repo.js';
import { resolveSegment } from './resolver.service.js';

/**
 * Разбор одной правки: от сегмента до последствия (§7 ТЗ, задача 3.6а).
 *
 * **Задачи с таким номером в плане нет, и это дыра плана.** 3.1 собирает
 * кандидатов, 3.2 принимает решение, 3.3–3.5 применяют его, откатывают и
 * спрашивают — а вызвать всё это некому. До сих пор сегменты с
 * намерением `PATCH` уходили в черновик с пометкой «ждёт резолвера», и
 * ждали бы вечно.
 *
 * Здесь та самая недостающая склейка:
 *
 * 1. из текста вынимается упомянутый день — дёшево, без модели;
 * 2. считается вектор сегмента для смыслового поиска;
 * 3. собираются кандидаты из трёх источников (§7.2);
 * 4. резолвер решает: применить, спросить или создать (§7.3);
 * 5. решение исполняется.
 *
 * **Вектор считается, но его отсутствие не останавливает разбор.** У
 * поправки два других источника кандидатов, и терять правку из-за
 * недоступного эмбеддера было бы обидно.
 */

/** Пустые изменения: модель промолчала, а поля нужны всем. */
const EMPTY_CHANGES = {
  note: '',
  text: '',
  deadline: '',
  deadlineAccuracy: 'none',
  recurrenceKind: 'none',
  recurrenceInterval: 0,
  recurrenceText: '',
} as const;

export interface ResolveDeps {
  readonly db: Database;
  readonly ai: AiClientDeps;
  readonly embedder?: EmbeddingProvider | undefined;
  readonly pricing?: Readonly<Record<string, ModelPricing>> | undefined;
  readonly logger?: Logger | undefined;
}

export interface ResolveSegmentParams {
  readonly userId: string;
  readonly batchId: string;
  readonly text: string;
  readonly timeZone: string;
  /** §8.1: сообщение внутри ветки сужает поиск до её темы. */
  readonly topic?: string | undefined;
  readonly now?: Date | undefined;
}

export type SegmentResult =
  /** Изменение применено, есть что отменять. */
  | { readonly kind: 'applied'; readonly applied: Applied }
  /** Задан уточняющий вопрос: его надо показать человеку. */
  | { readonly kind: 'asked'; readonly questionId: string; readonly itemTitle: string }
  /** Сказанное — новая мысль: пусть идёт в обычный разбор. */
  | { readonly kind: 'newThought' }
  /** Ни то, ни другое: сохранить черновиком, чтобы не потерять. */
  | {
      readonly kind: 'parked';
      readonly reason: string;
      /**
       * Стоит ли попробовать ещё раз после сохранения новых записей
       * (задача 3.24).
       *
       * Цель могла не найтись по двум разным причинам, и путать их
       * нельзя. Либо её действительно нет — тогда черновик и есть верный
       * исход. Либо она **сказана в этой же выгрузке** и ещё не
       * сохранена: правки разбираются до новых мыслей, и в базе её пока
       * не существует.
       *
       * Второй случай найден на боевом 01.09.2026: «...не в 11, а в 9»,
       * сразу «Нет, лучше не в 9, а в 9 30» — и поправка ушла в
       * черновик, а в записи осталось промежуточное значение.
       */
      readonly retryAfterSave?: boolean | undefined;
    };

/** Вектор сегмента. Не посчитался — работаем без смыслового поиска. */
async function vectorOf(
  deps: ResolveDeps,
  params: ResolveSegmentParams,
): Promise<readonly number[] | undefined> {
  if (deps.embedder === undefined) return undefined;

  try {
    return await embedText(
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
        batchId: params.batchId,
      },
    );
  } catch (error) {
    deps.logger?.warn({ err: error }, 'Вектор правки не посчитан, ищу без смыслового поиска');
    return undefined;
  }
}

export async function resolvePatchSegment(
  deps: ResolveDeps,
  params: ResolveSegmentParams,
): Promise<SegmentResult> {
  const now = params.now ?? new Date();

  const period = mentionedPeriod(params.text, { now, timeZone: params.timeZone });
  const vector = await vectorOf(deps, params);

  const candidates = await collectCandidates(deps.db, {
    userId: params.userId,
    now,
    ...(vector === undefined ? {} : { vector }),
    ...(period === undefined ? {} : { period }),
    ...(params.topic === undefined ? {} : { topic: params.topic }),
  });

  const resolved = await resolveSegment(deps.ai, {
    segment: params.text,
    candidates,
    timeZone: params.timeZone,
    now,
    userId: params.userId,
    batchId: params.batchId,
  });

  const decision = resolved.decision;

  deps.logger?.info(
    {
      userId: params.userId,
      batchId: params.batchId,
      candidates: candidates.length,
      kind: decision.kind,
      why: decision.why,
      confidence: resolved.confidence,
    },
    'Резолвер разобрал правку',
  );

  if (decision.kind === 'create') {
    /**
     * «Новая мысль» и «не разобрались» — разные исходы.
     *
     * Первое сказала модель, глядя на записи человека: значит из
     * сказанного выйдет запись. Второе означает, что цели не нашлось, и
     * записью «нет, в пятницу» становиться не должно — получится задача
     * «в пятницу», а это хуже, чем не разобрать вовсе.
     */
    return decision.newThought
      ? { kind: 'newThought' }
      : {
          kind: 'parked',
          reason: `резолвер не нашёл цели: ${decision.why}`,
          // Цель могла быть названа в этой же выгрузке и ещё не
          // сохранена — конвейер попробует снова после сохранения.
          retryAfterSave: true,
        };
  }

  const candidate = decision.candidate;
  if (candidate === undefined) return { kind: 'parked', reason: 'решение без записи' };

  if (decision.kind === 'ask') {
    const question = await askQuestion(deps.db, {
      userId: params.userId,
      itemId: candidate.id,
      batchId: params.batchId,
      segment: params.text,
      action: decision.action,
      changes: resolved.changes ?? EMPTY_CHANGES,
      now,
    });

    return { kind: 'asked', questionId: question.id, itemTitle: candidate.text };
  }

  const applied = await applyDecision(deps.db, {
    userId: params.userId,
    itemId: candidate.id,
    action: decision.action === 'new' ? 'update' : decision.action,
    ...(resolved.mode === undefined ? {} : { mode: resolved.mode }),
    changes: resolved.changes ?? EMPTY_CHANGES,
    // §3.8б: «запомни» видно только в сказанном.
    spoken: params.text,
    timeZone: params.timeZone,
    now,
    reason: decision.why,
    changedBy: 'resolver',
  });

  // Менять нечего — запись уже в этом состоянии. Ни ревизии, ни реплики:
  // сообщение о том, чего не было, доверия не прибавляет.
  return applied === undefined
    ? { kind: 'parked', reason: 'запись уже в нужном состоянии' }
    : { kind: 'applied', applied };
}
