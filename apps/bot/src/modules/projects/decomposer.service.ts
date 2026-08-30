import type { Item } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { requestStructured, type AiClientDeps } from '../ai/client.js';
import type { DecomposedSteps } from '../ai/schemas/index.js';
import { saveSteps, stepsOf } from './projects.service.js';

/**
 * Разложение проекта на шаги (§5 ТЗ, задача 3.12).
 *
 * **Момент вызова в ТЗ не определён, и это решение стоит денег.** Раскладывать
 * при создании значило бы платить за каждый проект, к которому человек
 * никогда не вернётся, — а таких большинство: «спланировать годовщину
 * родителей» живёт в списке месяцами. Поэтому разложение **ленивое**: оно
 * случается при первом обращении к проекту, когда человек уже показал,
 * что цель ему интересна.
 *
 * **Повторно не раскладываем.** Шаги, однажды записанные, — это состояние
 * человека: он их закрывал, к ним привык. Второе разложение стёрло бы
 * прогресс и подсунуло другой список, потому что модель нестабильна.
 */

export interface DecomposeDeps {
  readonly db: Database;
  readonly ai: AiClientDeps;
}

export interface DecomposeParams {
  readonly item: Item;
  readonly userId: string;
  readonly batchId?: string | undefined;
}

/**
 * Раскладывает проект, если он ещё не разложен.
 *
 * Возвращает шаги — существующие или только что созданные. Пустой список
 * означает, что разложить не вышло: это не ошибка, проект останется
 * обычной записью, а человек ничего не заметит.
 */
export async function decomposeIfNeeded(
  deps: DecomposeDeps,
  params: DecomposeParams,
): Promise<Awaited<ReturnType<typeof stepsOf>>> {
  const existing = await stepsOf(deps.db, params.item.id);
  if (existing.length > 0) return existing;

  // Не проект — раскладывать нечего.
  if (!params.item.isProject) return [];

  const outcome = await requestStructured<DecomposedSteps>(deps.ai, {
    stage: 'decomposer',
    input: buildInput(params.item),
    userId: params.userId,
    batchId: params.batchId,
  });

  if (!outcome.ok) {
    deps.ai.logger?.warn(
      { promptVersion: outcome.promptVersion, problem: outcome.problem },
      'Проект не разложился, останется обычной записью',
    );
    return [];
  }

  const texts = outcome.value.steps.map((step) => step.trim()).filter((step) => step.length > 0);
  if (texts.length === 0) return [];

  return await saveSteps(deps.db, { itemId: params.item.id, userId: params.userId, texts });
}

/**
 * Что видит модель.
 *
 * Заголовок и подробности, если человек их дописал (§7.4): «взять карту
 * прививок» меняет разложение поездки к врачу сильнее, чем сам заголовок.
 */
function buildInput(item: Item): string {
  const lines = [item.text];
  if (item.body !== null && item.body.length > 0) lines.push('', 'Подробности:', item.body);

  return lines.join('\n');
}
