import { requestStructured, type AiClientDeps } from '../ai/client.js';
import type { ExtractedUnits } from '../ai/schemas/index.js';

/**
 * Извлечение атомарных единиц (задача 2.5).
 *
 * §6.1 ТЗ: перечисление разбивается на отдельные единицы, составная цель
 * помечается признаком проекта и не разбивается, повторы схлопываются,
 * оценочные реплики выделяются как эмоция, обращения к боту в единицы
 * не попадают.
 *
 * Тип, приоритет, тема и срок здесь не определяются: это классификация,
 * задача 2.6. §10.1 разрешает объединить оба шага в один вызов ради
 * экономии, но только после того, как контрольный набор покажет, что
 * качество не падает.
 *
 * При неудаче замену не выдумываем. У маршрутизатора есть безопасная
 * замена — считать всё одной мыслью, — а здесь выдумать нечего: любая
 * подстановка означала бы записи, которых человек не говорил. Поэтому
 * честный отказ с сырым ответом, а вызывающий код сохранит черновик.
 */

export interface ExtractParams {
  /** Текст сегмента или всей выгрузки. */
  readonly input: string;
  readonly userId?: string | undefined;
  readonly batchId?: string | undefined;
}

export interface ExtractedUnit {
  readonly text: string;
  /** Составная цель: внутри много дел, но дробить её нельзя. */
  readonly isProject: boolean;
  /** Оценочная реплика, а не дело. §6.3 запрещает делать из неё задачу. */
  readonly isEmotion: boolean;
}

interface ExtractSuccess {
  readonly ok: true;
  readonly units: readonly ExtractedUnit[];
  readonly promptVersion: string;
  /** Сколько дословных повторов схлопнулось. Ненулевое — повод к промпту. */
  readonly collapsed: number;
}

interface ExtractFailure {
  readonly ok: false;
  readonly promptVersion: string;
  /** Сырой ответ модели: пойдёт в черновик для разбора руками. */
  readonly raw: string;
  readonly problem: string;
}

export type ExtractResult = ExtractSuccess | ExtractFailure;

function normalize(text: string): string {
  return (
    text
      .toLowerCase()
      // «ё» и «е» считаем одной буквой. Распознавание речи возвращает
      // «еще», а не «ещё» — это видно в живых расшифровках, — а модель
      // в своём ответе может написать и так и так. Без этого «успеть всё»
      // и «успеть все» окажутся разными делами.
      .replace(/ё/gu, 'е')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  );
}

/**
 * Схлопывает дословные повторы.
 *
 * §6.1 требует этого от промпта, но полагаться только на промпт нельзя:
 * человек в живой речи повторяет одно и то же по три раза («успеть все
 * законспектировать марафон, успеть все»), и модель иногда возвращает
 * две одинаковые единицы. Две записи об одном деле человек воспримет
 * как ошибку бота, и будет прав.
 *
 * Сравнение по нормализованному тексту: «Купить кофе» и «купить кофе.» —
 * одно и то же дело.
 */
export function collapseRepeats(units: readonly ExtractedUnit[]): {
  readonly units: readonly ExtractedUnit[];
  readonly collapsed: number;
} {
  const seen = new Set<string>();
  const kept: ExtractedUnit[] = [];

  for (const unit of units) {
    const key = normalize(unit.text);
    if (key === '' || seen.has(key)) continue;

    seen.add(key);
    kept.push(unit);
  }

  return { units: kept, collapsed: units.length - kept.length };
}

export async function extractUnits(
  deps: AiClientDeps,
  params: ExtractParams,
): Promise<ExtractResult> {
  const outcome = await requestStructured<ExtractedUnits>(deps, {
    stage: 'extractor',
    input: params.input,
    userId: params.userId,
    batchId: params.batchId,
  });

  if (!outcome.ok) {
    deps.logger?.warn(
      { promptVersion: outcome.promptVersion, problem: outcome.problem },
      'Извлечение единиц не удалось, текст пойдёт в черновик',
    );

    return {
      ok: false,
      promptVersion: outcome.promptVersion,
      raw: outcome.raw,
      problem: outcome.problem,
    };
  }

  const { units, collapsed } = collapseRepeats(outcome.value.units);

  if (collapsed > 0) {
    deps.logger?.info(
      { promptVersion: outcome.promptVersion, collapsed },
      'Схлопнуты дословные повторы среди единиц',
    );
  }

  return { ok: true, units, promptVersion: outcome.promptVersion, collapsed };
}
