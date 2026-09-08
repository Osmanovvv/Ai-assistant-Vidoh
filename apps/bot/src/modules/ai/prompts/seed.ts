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

/**
 * Правка из панели узнаётся по имени версии.
 *
 * `prompt_versions` не хранит признака «правка из панели», а имя ей даёт
 * `createHotfix`: `<предок>-hotfix-<время>`. То же имя — причина, по
 * которой её не видит заливка из файлов: файла у неё нет.
 */
export function isHotfix(version: string): boolean {
  return version.includes('-hotfix-');
}

/**
 * Включить **файловую** версию, не погасив молча правку из панели.
 *
 * **Найдено ревизией четвёртого этапа.** `--activate` гасил активную
 * версию этапа безоговорочно, а горячая правка живёт только в базе:
 * файла у неё нет, значит цикл по папке её не видит и включает файлового
 * предка. Правку, сделанную по живому инциденту, снимало обычное
 * разворачивание — молча, без строки в выводе. Дальше её никто не искал:
 * в панели версия выглядит как была, активна другая.
 *
 * Решение живёт здесь, а не в скрипте, чтобы его можно было проверить:
 * скрипт — верхний уровень с побочными действиями, и проверка его не
 * позовёт.
 */
export async function activateFromFile(
  db: Database,
  params: {
    readonly stage: AiStage;
    readonly version: string;
    /**
     * Погасить правку из панели — только если этого хотят прямо.
     *
     * В скрипте это `--over-hotfix`, а не `--force`: тем именем в
     * `ops/seed-prompts.sh` уже названо другое разрешение — обойти
     * заслон §10.3. Одно имя на два разрешения однажды даст не то, о чём
     * просили.
     */
    readonly force?: boolean | undefined;
  },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly hotfix: string }> {
  const [live] = await db
    .select({ version: promptVersions.version })
    .from(promptVersions)
    .where(and(eq(promptVersions.stage, params.stage), eq(promptVersions.isActive, true)))
    .limit(1);

  const hotfix = live !== undefined && isHotfix(live.version) ? live.version : undefined;

  if (hotfix !== undefined && params.force !== true) return { ok: false, hotfix };

  if (hotfix !== undefined) {
    // Погашенная правка остаётся названной в примечании: иначе через
    // месяц никто не вспомнит, куда девалась правка по инциденту.
    await db
      .update(promptVersions)
      .set({ note: `погашена заливкой ${params.version}` })
      .where(and(eq(promptVersions.stage, params.stage), eq(promptVersions.version, hotfix)));
  }

  await activatePrompt(db, params.stage, params.version);

  return { ok: true };
}
