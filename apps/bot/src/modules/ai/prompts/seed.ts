import { and, eq, ne } from 'drizzle-orm';

import { promptVersions, type AiStage } from '../../../db/schema.js';
import type { Database } from '../../../infra/db.js';
import { findSchema, toJsonSchema } from '../schemas/index.js';

/**
 * Заливка версий промптов в базу (задача 2.1).
 *
 * Тексты промптов в репозиторий не попадают: он публичный, а промпты —
 * основное ноу-хау продукта. Они живут в `docs/` и заливаются отсюда.
 *
 * Опубликованная версия неизменна. Правка текста — это новая версия, а не
 * тихая подмена старой: иначе жалоба «неделю назад бот отвечал лучше»
 * становится непроверяемой, потому что «та» версия больше не существует.
 */

export interface PromptDefinition {
  readonly stage: AiStage;
  /** Читаемая метка: extractor@1. */
  readonly version: string;
  readonly prompt: string;
  readonly schemaName: string;
  readonly note?: string;
}

export class PromptVersionConflictError extends Error {
  constructor(stage: AiStage, version: string) {
    super(
      `Версия ${version} этапа «${stage}» уже есть в базе, но её текст отличается. ` +
        'Опубликованная версия неизменна: заведите новую, а не правьте эту.',
    );
    this.name = 'PromptVersionConflictError';
  }
}

export interface SeedResult {
  readonly created: boolean;
}

/**
 * Заливает версию, если её ещё нет. Совпадающую пропускает молча,
 * расходящуюся — отвергает.
 */
export async function seedPrompt(db: Database, definition: PromptDefinition): Promise<SeedResult> {
  // Схема ищется в коде: заливать версию, валидатора для которой нет,
  // бессмысленно — она не поднимется при загрузке.
  const schemaJson = toJsonSchema(findSchema(definition.schemaName));

  const [existing] = await db
    .select()
    .from(promptVersions)
    .where(
      and(
        eq(promptVersions.stage, definition.stage),
        eq(promptVersions.version, definition.version),
      ),
    )
    .limit(1);

  if (existing) {
    if (existing.prompt !== definition.prompt || existing.schemaName !== definition.schemaName) {
      throw new PromptVersionConflictError(definition.stage, definition.version);
    }
    return { created: false };
  }

  await db.insert(promptVersions).values({
    stage: definition.stage,
    version: definition.version,
    prompt: definition.prompt,
    schemaName: definition.schemaName,
    schemaJson,
    note: definition.note ?? null,
  });

  return { created: true };
}

/**
 * Делает версию активной, снимая признак с прежней.
 *
 * Одной транзакцией: частичный уникальный индекс не даст существовать
 * двум активным версиям одного этапа, и снимать признак надо раньше, чем
 * ставить новый.
 */
export async function activatePrompt(db: Database, stage: AiStage, version: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: promptVersions.id })
      .from(promptVersions)
      .where(and(eq(promptVersions.stage, stage), eq(promptVersions.version, version)))
      .limit(1);

    if (!target) {
      throw new Error(`Версии ${version} этапа «${stage}» нет в базе`);
    }

    await tx
      .update(promptVersions)
      .set({ isActive: false })
      .where(and(eq(promptVersions.stage, stage), ne(promptVersions.id, target.id)));

    await tx.update(promptVersions).set({ isActive: true }).where(eq(promptVersions.id, target.id));
  });
}
