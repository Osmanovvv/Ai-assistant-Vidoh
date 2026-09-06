import { and, desc, eq } from 'drizzle-orm';

import { promptVersions, type AiStage } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import {
  evalFreshness,
  MEASURED_STAGES,
  type FreshnessProblem,
  type FreshnessVerdict,
} from '../../eval/freshness.js';
import { findSchema, toJsonSchema } from '../ai/schemas/index.js';
import { activatePrompt } from '../ai/prompts/seed.js';

/**
 * Промпты в админ-панели (§15 ТЗ, задача 4.8).
 *
 * §15: «Просмотр версий, включение версии, откат. Изменение промпта без
 * выкладки новой версии приложения». Источник истины — таблица
 * `prompt_versions` (решение задачи 2.1): репозиторий публичный, а
 * промпты — основное ноу-хау продукта, и в открытый доступ они не
 * попадают.
 *
 * **Опубликованная версия неизменна.** Правка текста создаёт **новую**
 * версию, а не подменяет старую. Иначе жалоба «неделю назад бот отвечал
 * лучше» становится непроверяемой: той версии больше не существует, а в
 * учёте вызовов на неё ссылаются тысячи строк.
 *
 * **Включение без прогона набора запрещено, и это главное здесь.** §10.3
 * требует прогонять набор на любом изменении промпта; §15 разрешает
 * менять промпт без выкладки. Вместе это значит, что панель — теперь
 * единственная дверь, через которую регрессия может дойти до людей,
 * минуя все заслоны. 28.08.2026 такое уже случилось: выложили `router@3`
 * и `router@4` без прогона, и промпт терял три единицы из сорока трёх —
 * семь процентов сказанного человеком не превращалось в записи.
 *
 * Поэтому включение непроверенной версии не «предупреждает», а
 * **отказывает**; обойти отказ можно только явным признанием, и оно
 * записывается в версию навсегда. Предупреждение, которое можно
 * прокликать не читая, не защищает ни от чего.
 */

export interface PromptSummary {
  readonly stage: AiStage;
  readonly version: string;
  readonly isActive: boolean;
  readonly note: string | null;
  readonly schemaName: string;
  /** Длина текста: список показывает размер, но не сам промпт. */
  readonly length: number;
  readonly createdAt: Date;
}

export interface PromptsView {
  readonly versions: readonly PromptSummary[];
  /** Прогнан ли набор на том, что включено **сейчас**. */
  readonly freshness: FreshnessVerdict;
}

/**
 * Список версий — без текстов.
 *
 * Тексты промптов не едут в список нарочно: это самое ценное, что есть в
 * продукте, и возить его целиком на каждое открытие страницы незачем.
 * Текст отдаётся по отдельному запросу, на конкретную версию.
 */
export async function promptsView(db: Executor, evalDir: string): Promise<PromptsView> {
  const rows = await db
    .select()
    .from(promptVersions)
    .orderBy(promptVersions.stage, desc(promptVersions.createdAt));

  const active = new Map<string, string>();
  for (const row of rows) {
    if (row.isActive) active.set(row.stage, row.version);
  }

  return {
    versions: rows.map((row) => ({
      stage: row.stage,
      version: row.version,
      isActive: row.isActive,
      note: row.note,
      schemaName: row.schemaName,
      length: row.prompt.length,
      createdAt: row.createdAt,
    })),
    freshness: await evalFreshness({ evalDir, activating: active }),
  };
}

/** Что включено сейчас: стадия → версия. */
async function activeVersions(db: Executor): Promise<ReadonlyMap<AiStage, string>> {
  const rows = await db
    .select({ stage: promptVersions.stage, version: promptVersions.version })
    .from(promptVersions)
    .where(eq(promptVersions.isActive, true));

  return new Map(rows.map((row) => [row.stage, row.version]));
}

/** Текст одной версии. Отдельным запросом — см. пояснение выше. */
export async function promptText(
  db: Executor,
  params: { readonly stage: AiStage; readonly version: string },
): Promise<{ readonly prompt: string; readonly schemaName: string } | undefined> {
  const [row] = await db
    .select({ prompt: promptVersions.prompt, schemaName: promptVersions.schemaName })
    .from(promptVersions)
    .where(and(eq(promptVersions.stage, params.stage), eq(promptVersions.version, params.version)))
    .limit(1);

  return row;
}

export class PromptExistsError extends Error {
  constructor(stage: string, version: string) {
    super(`Версия ${version} этапа «${stage}» уже есть: опубликованное не переписывают`);
    this.name = 'PromptExistsError';
  }
}

/**
 * Новая версия из панели — «горячая правка».
 *
 * Имя версии получает суффикс `-hotfix`, и это не украшение: имя едет в
 * `ai_calls.prompt_version` при каждом вызове модели. Через месяц в
 * отчёте по расходу и в карточке человека будет видно, что эти разборы
 * сделаны правкой из панели, а не выложенной версией. Без суффикса
 * пришлось бы поднимать дату создания версии, чтобы это понять.
 *
 * Пометка `hotfix` уходит и в примечание — по правилу задачи 2.1.
 *
 * Схема берётся у **основы**: горячая правка меняет текст, а не формат
 * ответа. Менять схему из панели нельзя вовсе — валидатор живёт в коде,
 * и версия со схемой, которой в коде нет, не поднимется (см.
 * `SchemaMismatchError` в реестре). Это не ограничение панели, а защита
 * от версии, которая молча ломает разбор ответа.
 */
export async function createHotfix(
  db: Executor,
  params: {
    readonly stage: AiStage;
    /** Версия, от которой правим: у неё берётся схема. */
    readonly basedOn: string;
    readonly prompt: string;
    readonly by: string;
    readonly now?: Date | undefined;
  },
): Promise<{ readonly version: string }> {
  const base = await promptText(db, { stage: params.stage, version: params.basedOn });

  if (base === undefined) {
    throw new Error(`Основы ${params.basedOn} этапа «${params.stage}» нет в базе`);
  }

  if (params.prompt.trim() === '') {
    // Пустой промпт — это не «версия без текста», это сломанный разбор.
    throw new Error('Пустой промпт');
  }

  /**
   * Имя версии: основа плюс метка правки и время **до секунды**.
   *
   * Время в имени нужно, чтобы две правки одной основы не столкнулись:
   * `prompt_versions` держит уникальность пары «этап, версия», и вторая
   * правка упёрлась бы в отказ базы. Минуты для этого мало: правку
   * пробуют, смотрят, правят снова — и всё это укладывается в минуту, а
   * человек получал бы вместо новой версии невнятный отказ.
   */
  const stamp = (params.now ?? new Date()).toISOString().slice(0, 19).replace(/[-:T]/gu, '');
  const version = `${params.basedOn}-hotfix-${stamp}`;

  const [existing] = await db
    .select({ id: promptVersions.id })
    .from(promptVersions)
    .where(and(eq(promptVersions.stage, params.stage), eq(promptVersions.version, version)))
    .limit(1);

  if (existing !== undefined) throw new PromptExistsError(params.stage, version);

  await db.insert(promptVersions).values({
    stage: params.stage,
    version,
    prompt: params.prompt,
    schemaName: base.schemaName,
    // Схема пересчитывается из кода по имени, а не копируется из
    // основы: если код с тех пор поменялся, копия была бы устаревшей и
    // версия не поднялась бы.
    schemaJson: toJsonSchema(findSchema(base.schemaName)),
    note: `hotfix из панели, основана на ${params.basedOn}, автор ${params.by}`,
  });

  return { version };
}

export type ActivationOutcome =
  | { readonly ok: true; readonly freshness: FreshnessVerdict }
  /**
   * Набор на этой версии не прогнан. Включать нельзя без признания.
   *
   * Тип отказа — именно неудачный вердикт, а не любой: у отказа всегда
   * есть причины, и вызывающий вправе их показать, не проверяя заново.
   */
  | { readonly ok: false; readonly refused: FreshnessProblem };

/**
 * Включить версию — с заслоном по §10.3.
 *
 * `acknowledged` — явное признание «включаю непроверенное». Без него
 * непроверенная версия не включается вовсе. С ним включается, но
 * признание **записывается в примечание версии навсегда**: через месяц
 * при разборе «почему стало хуже» будет видно, что версию включили,
 * зная, что набор не прогнан.
 */
export async function activateVersion(
  db: Executor,
  params: {
    readonly stage: AiStage;
    readonly version: string;
    readonly evalDir: string;
    readonly by: string;
    readonly acknowledged?: boolean | undefined;
    readonly now?: Date | undefined;
  },
): Promise<ActivationOutcome> {
  /**
   * Сверяется **сочетание, которое станет активным**, а не одна
   * включаемая версия.
   *
   * 28.08.2026 подвело именно сочетание: стадии мерили порознь, а
   * включали вместе. Прогон, где эта версия стояла рядом с другим
   * маршрутизатором, ничего не говорит о том, что получится сейчас.
   *
   * **Но сочетание берётся внутри своего набора.** Общий набор мерит
   * разбор, у резолвера набор свой. Требовать прогона разбора ради
   * правки резолвера значило бы заставлять платить за измерение того,
   * что не менялось, — а такой заслон обходят не думая.
   */
  const activating = new Map<string, string>();

  if ((MEASURED_STAGES as readonly string[]).includes(params.stage)) {
    for (const [stage, version] of await activeVersions(db)) {
      if ((MEASURED_STAGES as readonly string[]).includes(stage)) activating.set(stage, version);
    }
  }

  activating.set(params.stage, params.version);

  const freshness = await evalFreshness({ evalDir: params.evalDir, activating });

  if (!freshness.ok && params.acknowledged !== true) {
    return { ok: false, refused: freshness };
  }

  await activatePrompt(db, params.stage, params.version);

  if (!freshness.ok) {
    const at = (params.now ?? new Date()).toISOString().slice(0, 10);
    const mark = `включена ${at} без прогона набора: ${params.by}`;

    const [row] = await db
      .select({ note: promptVersions.note })
      .from(promptVersions)
      .where(
        and(eq(promptVersions.stage, params.stage), eq(promptVersions.version, params.version)),
      )
      .limit(1);

    // Откатились и включили обратно тем же днём — пометка та же, и
    // дописывать её второй раз незачем: примечание должно оставаться
    // читаемым, иначе его перестанут читать.
    if (row?.note?.includes(mark) !== true) {
      await db
        .update(promptVersions)
        .set({
          note: [row?.note, mark]
            .filter((one) => one !== null && one !== undefined && one !== '')
            .join('; '),
        })
        .where(
          and(eq(promptVersions.stage, params.stage), eq(promptVersions.version, params.version)),
        );
    }
  }

  return { ok: true, freshness };
}
