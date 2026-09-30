import { sql } from 'drizzle-orm';

import type { Item, ProjectStep } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { requestStructured, type AiClientDeps } from '../ai/client.js';
import type { DecomposedSteps } from '../ai/schemas/index.js';
import { renameItem, type RenameDeps } from '../items/title-edit.js';
import { shortTitleFrom } from './project-title.js';
import { saveSteps, stepsOf } from './projects.service.js';

/**
 * Разложение проекта на шаги (§5 ТЗ, задача 3.12).
 *
 * **Когда.** Сразу при записи (заказчица, 30.09.2026: «чтобы большие цели
 * мы могли по шагам разложить, чтобы бот нам в этом помог»; решение Никиты
 * — все цели, а не только с перечислением). Прежде разложение было
 * ленивым — при первом вопросе о цели — ради денег: около 0,5 ₽ за цель, а
 * целей мало. Ленивое осталось запасным путём: для целей, записанных до
 * 30.09.2026, и если при записи модель не ответила (`decomposeIfNeeded`).
 *
 * **Повторно не раскладываем.** Шаги, однажды записанные, — это состояние
 * человека: он их закрывал, к ним привык. Второе разложение стёрло бы
 * прогресс и подсунуло другой список, потому что модель нестабильна.
 */

export interface DecomposeDeps {
  readonly db: Database;
  readonly ai: AiClientDeps;
}

/** Шаги цели и её короткое название — если модель укоротила, а код принял. */
export interface StepPlan {
  readonly title?: string | undefined;
  readonly steps: readonly string[];
}

/**
 * Шаги для цели — без записи в базу; не вышло — пусто.
 *
 * Сбой модели здесь не ошибка выгрузки: цель остаётся обычной записью, а
 * человек ничего не теряет. Поэтому и исключение не уходит наверх —
 * сохранить сказанное важнее, чем разложить.
 */
export async function planSteps(
  ai: AiClientDeps,
  params: {
    readonly text: string;
    readonly body?: string | null | undefined;
    readonly userId: string;
    readonly batchId?: string | undefined;
  },
): Promise<StepPlan> {
  let outcome;
  try {
    outcome = await requestStructured<DecomposedSteps>(ai, {
      stage: 'decomposer',
      input: buildInput(params.text, params.body),
      userId: params.userId,
      batchId: params.batchId,
    });
  } catch (error) {
    ai.logger?.warn({ err: error }, 'Цель не разложилась: модель недоступна, останется как есть');
    return { steps: [] };
  }

  if (!outcome.ok) {
    ai.logger?.warn(
      { promptVersion: outcome.promptVersion, problem: outcome.problem },
      'Проект не разложился, останется обычной записью',
    );
    return { steps: [] };
  }

  const steps = outcome.value.steps.map((step) => step.trim()).filter((step) => step.length > 0);
  if (steps.length === 0) return { steps: [] };

  const title = shortTitleFrom(params.text, outcome.value.title, steps);
  if (title === undefined && outcome.value.title !== undefined) {
    const offered = outcome.value.title.trim();
    if (offered !== '' && offered.toLowerCase() !== params.text.trim().toLowerCase()) {
      ai.logger?.info(
        { promptVersion: outcome.promptVersion },
        'Короткое название цели не принято: не её слова, не по перечислению или части нет в шагах',
      );
    }
  }

  return title === undefined ? { steps } : { title, steps };
}

export interface DecomposeParams {
  readonly item: Item;
  readonly userId: string;
  readonly batchId?: string | undefined;
}

/**
 * Раскладывает проект, если он ещё не разложен.
 *
 * Возвращает шаги — существующие или только что созданные — и короткое
 * название, если оно получилось: переименовать запись — дело вызывающего
 * (вектор, сводка ветки, правка в истории). Пустой список означает, что
 * разложить не вышло: проект останется обычной записью.
 */
export async function decomposeIfNeeded(
  deps: DecomposeDeps,
  params: DecomposeParams,
): Promise<{
  readonly steps: Awaited<ReturnType<typeof stepsOf>>;
  readonly title?: string | undefined;
}> {
  const existing = await stepsOf(deps.db, params.item.id);
  if (existing.length > 0) return { steps: existing };

  // Не проект — раскладывать нечего.
  if (!params.item.isProject) return { steps: [] };

  const plan = await planSteps(deps.ai, {
    text: params.item.text,
    body: params.item.body,
    userId: params.userId,
    batchId: params.batchId,
  });
  if (plan.steps.length === 0) return { steps: [] };

  /**
   * Два открытия подряд (двойное нажатие в меню) раскладывают дважды, и
   * без замка шаги двух ответов смешались бы: уникальность по месту шага
   * пропустит «лишние» места длинного списка. Под замком по цели второй
   * видит шаги первого и своих не пишет.
   */
  return await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${params.item.id}))`);
    const already = await stepsOf(tx, params.item.id);
    if (already.length > 0) return { steps: already };

    const steps = await saveSteps(tx, {
      itemId: params.item.id,
      userId: params.userId,
      texts: plan.steps,
    });
    return plan.title === undefined ? { steps } : { steps, title: plan.title };
  });
}

/**
 * Разложить уже записанную цель и, если название укоротилось, переписать
 * его — тем же путём, что правка из карточки: история, вектор, сводка
 * ветки. Один путь на меню и на вопрос в чате, иначе они разойдутся.
 */
export async function decomposeGoal(
  deps: DecomposeDeps & { readonly rename: RenameDeps },
  params: DecomposeParams & {
    readonly timeZone: string;
    readonly textProfile: string | null;
    readonly chatId?: number | undefined;
  },
): Promise<{ readonly steps: readonly ProjectStep[]; readonly item: Item }> {
  const planned = await decomposeIfNeeded(deps, params);
  if (planned.title === undefined) return { steps: planned.steps, item: params.item };

  const renamed = await renameItem(deps.rename, {
    userId: params.userId,
    itemId: params.item.id,
    title: planned.title,
    spoken: params.item.text,
    timeZone: params.timeZone,
    textProfile: params.textProfile,
    chatId: params.chatId,
    reason: 'цель разложена на шаги: части из названия ушли в шаги',
    changedBy: 'resolver',
  });

  return {
    steps: planned.steps,
    item: renamed.kind === 'applied' ? renamed.applied.after : params.item,
  };
}

/**
 * Что видит модель.
 *
 * Заголовок и подробности, если человек их дописал (§7.4): «взять карту
 * прививок» меняет разложение поездки к врачу сильнее, чем сам заголовок.
 */
function buildInput(text: string, body: string | null | undefined): string {
  const lines = [text];
  if (body !== null && body !== undefined && body.length > 0) {
    lines.push('', 'Подробности:', body);
  }

  return lines.join('\n');
}
