import type { Logger } from 'pino';

import { requestStructured, type AiClientDeps } from '../ai/client.js';
import type {
  ClassifiedItems,
  DeadlineAccuracy,
  ItemType,
  Priority,
} from '../ai/schemas/classifier.js';
import type { ExtractedUnit } from '../extractor/extractor.service.js';
import { resolveRecurrence, type ResolvedRecurrence } from '../recurrence/recurrence.js';
import { describeNow, resolveDeadline, type ResolvedDeadline } from './dates.js';

/**
 * Классификация записей (задача 2.6).
 *
 * §6.2 ТЗ задаёт признаки типов, §6.3 — приоритеты, §6.4 — темы, задача
 * 2.7 — сроки. Всё это один вызов модели: типы и приоритеты связаны, и
 * разносить их по разным вызовам значило бы платить дважды за одно
 * рассуждение.
 *
 * Три правила проверяются в коде, а не только в промпте. Промпт — это
 * просьба, а не гарантия, и на трёх вещах цена ошибки слишком велика:
 *
 * 1. **Желание не становится задачей.** §6.2 прямо называет это правилом,
 *    которое модели нарушают чаще всего. Приоритет у не-TASK принудительно
 *    `NONE` — тогда такая запись не попадёт в выдачу даже если модель
 *    поставила ей `NOW`.
 * 2. **Тема — только из списка человека.** §6.4 запрещает создавать темы
 *    без спроса, поэтому незнакомая тема заменяется темой по умолчанию.
 * 3. **Срок проверяется и привязывается к поясу.** Неверный срок хуже
 *    отсутствующего: напоминание, пришедшее не вовремя, хуже
 *    не пришедшего.
 */

export interface ClassifyParams {
  /** Единицы, полученные извлечением (задача 2.5). */
  readonly units: readonly ExtractedUnit[];
  /** Темы человека. §6.4: они создаются на онбординге по его ответам. */
  readonly topics: readonly string[];
  /** Куда девать запись, не попавшую ни в одну тему (§6.4). */
  readonly defaultTopic: string;
  readonly timeZone: string;
  readonly now?: Date | undefined;
  readonly userId?: string | undefined;
  readonly batchId?: string | undefined;
}

export interface ClassifiedItem {
  readonly text: string;
  readonly type: ItemType;
  readonly priority: Priority;
  readonly topic: string;
  readonly isProject: boolean;
  readonly deadline?: ResolvedDeadline | undefined;
  /** Регулярность (задача 2.18а). Поле у `TASK`, как и признак проекта. */
  readonly recurrence?: ResolvedRecurrence | undefined;
}

/** Что пришлось поправить за моделью. Ненулевое — повод к промпту. */
export interface Corrections {
  /** Приоритет у не-TASK, который модель поставила не `NONE`. */
  readonly priority: number;
  /** Тема не из списка человека. */
  readonly topic: number;
  /** Срок не прошёл проверку и был отброшен. */
  readonly deadline: number;
  /** Признак проекта у записи, которая не задача. */
  readonly project: number;
  /** Регулярность у записи, которая не задача, либо без правила. */
  readonly recurrence: number;
}

interface ClassifySuccess {
  readonly ok: true;
  readonly items: readonly ClassifiedItem[];
  readonly promptVersion: string;
  readonly corrections: Corrections;
}

interface ClassifyFailure {
  readonly ok: false;
  readonly promptVersion: string;
  readonly raw: string;
  readonly problem: string;
}

export type ClassifyResult = ClassifySuccess | ClassifyFailure;

/** §6.3 ТЗ: важность бывает только у задачи. */
function isActionable(type: ItemType): boolean {
  return type === 'TASK';
}

function normalizeTopic(text: string): string {
  return text.toLowerCase().replace(/ё/gu, 'е').trim();
}

/** Что отправляем модели: единицы, темы и сегодняшняя дата. */
function buildInput(params: ClassifyParams, now: Date): string {
  const units = params.units.map((unit, index) => `${String(index + 1)}. ${unit.text}`).join('\n');

  return [
    describeNow(now, params.timeZone),
    '',
    `Доступные темы: ${params.topics.join(', ')}.`,
    '',
    'Мысли:',
    units,
  ].join('\n');
}

/** Что нужно поправкам, кроме самого ответа модели. */
export interface CorrectionContext {
  readonly topics: readonly string[];
  readonly defaultTopic: string;
  readonly timeZone: string;
  readonly now: Date;
  /** Идёт в предупреждения: без версии непонятно, какой промпт виноват. */
  readonly promptVersion: string;
  readonly logger?: Logger | undefined;
}

/**
 * Поправки за моделью — отдельной функцией, а не внутри вызова.
 *
 * Понадобилось на 2.20: §10.1 разрешает объединить извлечение и
 * классификацию в один вызов, но сравнивать пути можно только при
 * одинаковых правилах после модели. Правила §6.2, §6.3, §5.1 и §6.4 не
 * зависят от того, одним вызовом получен ответ или двумя, — значит и код
 * не должен от этого зависеть.
 */
export function correctItems(
  raw: ClassifiedItems,
  ctx: CorrectionContext,
): { readonly items: readonly ClassifiedItem[]; readonly corrections: Corrections } {
  const { now, promptVersion, logger } = ctx;

  // Сверка тем идёт по нормализованному виду, а возвращается название из
  // списка человека: в базе должно лежать ровно то, что он видит.
  const byNormalized = new Map(ctx.topics.map((topic) => [normalizeTopic(topic), topic]));

  const corrections: { -readonly [K in keyof Corrections]: Corrections[K] } = {
    priority: 0,
    topic: 0,
    deadline: 0,
    project: 0,
    recurrence: 0,
  };

  const items: ClassifiedItem[] = [];

  for (const item of raw.items) {
    const type = item.type;

    // §6.3 ТЗ и §6.2: желание, идея, информация и эмоция в выдачу не
    // попадают. Это то самое правило, которое модели нарушают чаще всего.
    let priority: Priority = item.priority;
    if (!isActionable(type) && priority !== 'NONE') {
      priority = 'NONE';
      corrections.priority++;
    }

    // §5.1 ТЗ: проект — поле у TASK. У остальных типов оно не значит ничего.
    let isProject = item.isProject;
    if (isProject && !isActionable(type)) {
      isProject = false;
      corrections.project++;
    }

    // §6.4 ТЗ: создавать темы без спроса запрещено.
    const topic = byNormalized.get(normalizeTopic(item.topic));
    if (topic === undefined) corrections.topic++;

    const accuracy: DeadlineAccuracy = item.deadlineAccuracy;
    const resolved = resolveDeadline(
      { deadline: item.deadline, accuracy },
      { now, timeZone: ctx.timeZone },
    );

    let deadline: ResolvedDeadline | undefined;
    if (resolved.ok) {
      deadline = resolved.deadline;
    } else {
      corrections.deadline++;
      logger?.warn(
        { promptVersion, reason: resolved.reason },
        'Срок не прошёл проверку, запись сохраняется без срока',
      );
    }

    /**
     * §5.1 и задача 2.18а: регулярность — поле у `TASK`. У желания,
     * идеи, факта и эмоции она не значит ничего, и база это же запрещает
     * ограничением — но полагаться на то, что до базы дойдёт правильное,
     * нельзя: отказ вставки уронил бы всю выгрузку из-за одной записи.
     */
    let recurrence: ResolvedRecurrence | undefined;
    if (isActionable(type)) {
      const resolvedRecurrence = resolveRecurrence({
        kind: item.recurrenceKind,
        interval: item.recurrenceInterval,
        text: item.recurrenceText,
        deadline: item.deadline,
      });

      if (resolvedRecurrence.text !== undefined) recurrence = resolvedRecurrence;

      if (resolvedRecurrence.problem !== undefined) {
        corrections.recurrence++;
        logger?.warn(
          { promptVersion, reason: resolvedRecurrence.problem },
          'Регулярность названа, но правило не получилось — сохраняю фразой',
        );
      }
    } else if (item.recurrenceKind !== 'none') {
      corrections.recurrence++;
    }

    items.push({
      text: item.text,
      type,
      priority,
      topic: topic ?? ctx.defaultTopic,
      isProject,
      deadline,
      recurrence,
    });
  }

  const total =
    corrections.priority +
    corrections.topic +
    corrections.deadline +
    corrections.project +
    corrections.recurrence;
  if (total > 0) {
    logger?.info({ promptVersion, ...corrections }, 'Ответ классификации пришлось поправить');
  }

  return { items, corrections };
}

export async function classifyUnits(
  deps: AiClientDeps,
  params: ClassifyParams,
): Promise<ClassifyResult> {
  const now = params.now ?? new Date();

  const outcome = await requestStructured<ClassifiedItems>(deps, {
    stage: 'classifier',
    input: buildInput(params, now),
    userId: params.userId,
    batchId: params.batchId,
  });

  if (!outcome.ok) {
    deps.logger?.warn(
      { promptVersion: outcome.promptVersion, problem: outcome.problem },
      'Классификация не удалась, записи пойдут в черновик',
    );

    return {
      ok: false,
      promptVersion: outcome.promptVersion,
      raw: outcome.raw,
      problem: outcome.problem,
    };
  }

  const { items, corrections } = correctItems(outcome.value, {
    topics: params.topics,
    defaultTopic: params.defaultTopic,
    timeZone: params.timeZone,
    now,
    promptVersion: outcome.promptVersion,
    logger: deps.logger,
  });

  return { ok: true, items, promptVersion: outcome.promptVersion, corrections };
}
