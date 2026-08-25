import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';

import { promptVersions, type AiStage } from '../../../db/schema.js';
import type { Executor } from '../../../infra/db.js';
import { canonicalJson, findSchema, toJsonSchema } from '../schemas/index.js';

/**
 * Активная версия промпта (задача 2.1).
 *
 * Источник истины — таблица `prompt_versions`, а не файлы в репозитории:
 * репозиторий публичный, а промпты и есть основное ноу-хау продукта.
 * §10.4 требует версионирования, §15 — правки без выкладки; таблица даёт
 * и то и другое, а на этапе 4 её правит админка.
 *
 * Каждый вызов модели помечается версией, которой он сделан, — иначе
 * жалобу «бот стал хуже» не с чем сопоставить.
 */

export interface ActivePrompt {
  readonly stage: AiStage;
  readonly version: string;
  readonly prompt: string;
  readonly schemaName: string;
  /** То, что отправляется модели. */
  readonly jsonSchema: Record<string, unknown>;
  /** То, чем проверяется ответ. Живёт в коде, найдено по имени схемы. */
  readonly schema: z.ZodType;
}

export class PromptNotFoundError extends Error {
  constructor(stage: AiStage) {
    super(`Нет активной версии промпта для этапа «${stage}». Залейте промпты (seed).`);
    this.name = 'PromptNotFoundError';
  }
}

/**
 * Схема в базе разошлась со схемой в коде.
 *
 * Ровно тот случай, о котором предупреждает задача 2.2: промпт откатили
 * на прошлую версию, а схему ответа — нет. Разбор ответа при этом
 * сломается, но не сразу и невнятно. Лучше не подняться вовсе.
 */
export class SchemaMismatchError extends Error {
  constructor(stage: AiStage, version: string, schemaName: string) {
    super(
      `Схема «${schemaName}» в коде не совпадает с той, что записана ` +
        `в версии ${version} этапа «${stage}». Похоже, промпт откатили, а схему нет.`,
    );
    this.name = 'SchemaMismatchError';
  }
}

export async function loadActivePrompt(db: Executor, stage: AiStage): Promise<ActivePrompt> {
  const [row] = await db
    .select()
    .from(promptVersions)
    .where(and(eq(promptVersions.stage, stage), eq(promptVersions.isActive, true)))
    .limit(1);

  if (!row) throw new PromptNotFoundError(stage);

  // Валидатор в базе не сохранить, поэтому он ищется в коде по имени.
  // Незнакомое имя — это выкладка, которая не знает про свою же версию
  // промпта, и работать так нельзя.
  const schema = findSchema(row.schemaName);
  const derived = toJsonSchema(schema);

  if (canonicalJson(derived) !== canonicalJson(row.schemaJson)) {
    throw new SchemaMismatchError(stage, row.version, row.schemaName);
  }

  return {
    stage,
    version: row.version,
    prompt: row.prompt,
    schemaName: row.schemaName,
    jsonSchema: derived,
    schema,
  };
}

/**
 * Кэш активных промптов на время работы процесса.
 *
 * Промпт читается на каждой выгрузке, а меняется раз в неделю. Но кэш
 * обязан сбрасываться: §15 требует правки без выкладки, а с бессрочным
 * кэшем «без выкладки» превратилось бы в «после перезапуска».
 */
export class PromptRegistry {
  private readonly cache = new Map<AiStage, ActivePrompt>();

  constructor(
    private readonly db: Executor,
    private readonly ttlMs = 60_000,
  ) {}

  private readonly loadedAt = new Map<AiStage, number>();

  async get(stage: AiStage, now = Date.now()): Promise<ActivePrompt> {
    const cached = this.cache.get(stage);
    const loaded = this.loadedAt.get(stage) ?? 0;

    if (cached && now - loaded < this.ttlMs) return cached;

    const fresh = await loadActivePrompt(this.db, stage);
    this.cache.set(stage, fresh);
    this.loadedAt.set(stage, now);
    return fresh;
  }

  /** Сброс кэша. Нужен админке после правки промпта и тестам. */
  forget(stage?: AiStage): void {
    if (stage === undefined) {
      this.cache.clear();
      this.loadedAt.clear();
      return;
    }
    this.cache.delete(stage);
    this.loadedAt.delete(stage);
  }
}
