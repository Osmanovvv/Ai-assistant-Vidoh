import type { Logger } from 'pino';

import { classifierSchema, toJsonSchema } from '../modules/ai/schemas/index.js';
import type { LlmProvider } from '../modules/ai/providers/types.js';
import { correctItems, type ClassifiedItem } from '../modules/classifier/classifier.service.js';
import { describeNow } from '../modules/classifier/dates.js';
import { detectByMarkers, detectCrisis } from '../modules/safety/crisis.js';
import type { EvalCase } from './dataset.js';
import { match, type MatchResult } from './matcher.js';
import type { CaseOutcome } from './runner.js';

/**
 * Объединённый разбор: одним вызовом вместо двух (задача 2.20, §10.1).
 *
 * §10.1 разрешает объединить извлечение и классификацию ради экономии, но
 * та же задача оговаривает условие: принимается, **только если
 * контрольный набор не ухудшился**, и замером, а не на глаз. Этот файл —
 * и есть замер.
 *
 * **Схема ответа та же, что у классификации.** Объединение не меняет
 * форму ответа: на вход вместо готовых единиц идёт склеенный текст, на
 * выходе те же записи с типом, важностью, темой, сроком и повторением.
 * Поэтому и поправки за моделью те же — они вынесены в `correctItems`,
 * иначе сравнение было бы нечестным: один путь с правилами §6.2 и §6.3,
 * другой без.
 *
 * **Расход в учёт не пишется, и это намеренно.** Учёт разложен по этапам
 * из справочника `ai_stage`, а объединённого этапа там нет и не появится
 * до того, как эксперимент примут: значение перечисления в Postgres
 * добавляется навсегда, удалить его нельзя. Токены берутся прямо из
 * ответа провайдера — для сравнения этого достаточно.
 *
 * **Маршрутизатор остаётся отдельным вызовом.** §10.1 говорит про
 * извлечение и классификацию; кризисный контур и разделение по намерениям
 * решают, надо ли вообще разбирать, — их объединять с разбором значило бы
 * платить за разбор того, что разбирать не нужно.
 */

export interface MergedDeps {
  readonly provider: LlmProvider;
  /**
   * Текст промпта, а не путь к файлу: чтение файла — забота вызывающего.
   * Иначе модуль нельзя проверить без папки `docs`, которой в репозитории
   * нет, и проверять его перестали бы вовсе.
   */
  readonly prompt: string;
  readonly logger?: Logger | undefined;
}

export interface MergedOutcome extends CaseOutcome {
  readonly tokensIn: number;
  readonly tokensOut: number;
}

/** Что отправляем модели: дата, темы и весь текст выгрузки целиком. */
function buildInput(item: EvalCase, now: Date): string {
  return [
    describeNow(now, item.timeZone),
    '',
    `Доступные темы: ${item.topics.join(', ')}.`,
    '',
    'Текст:',
    item.text,
  ].join('\n');
}

function stopped(item: EvalCase, version: string): MergedOutcome {
  return {
    id: item.id,
    note: item.note,
    result: { matched: [], missed: [...item.expected.units], extra: [], ambiguous: [] },
    crisis: { detected: true, expected: item.expected.crisis },
    promptVersions: { classifier: version },
    tokensIn: 0,
    tokensOut: 0,
  };
}

function failed(
  item: EvalCase,
  version: string,
  problem: string,
  used: MergedUsage,
): MergedOutcome {
  return {
    id: item.id,
    note: item.note,
    result: { matched: [], missed: [...item.expected.units], extra: [], ambiguous: [] },
    crisis: { detected: false, expected: item.expected.crisis },
    failed: problem,
    promptVersions: { classifier: version },
    tokensIn: used.tokensIn,
    tokensOut: used.tokensOut,
  };
}

interface MergedUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
}

/**
 * Прогоняет один случай объединённым путём.
 *
 * Кризисный контур по маркерам — до модели, как в бою: свойство «на
 * настоящем кризисе не тратим ни копейки» не должно зависеть от того,
 * сколько вызовов в разборе.
 */
export async function runMergedCase(
  deps: MergedDeps,
  item: EvalCase,
  version: string,
): Promise<MergedOutcome> {
  const now = new Date(item.now);

  if (detectByMarkers(item.text).detected) return stopped(item, version);

  let usage: MergedUsage = { tokensIn: 0, tokensOut: 0 };

  try {
    const completion = await deps.provider.complete({
      prompt: deps.prompt,
      input: buildInput(item, now),
      jsonSchema: toJsonSchema(classifierSchema),
      temperature: 0,
    });

    usage = { tokensIn: completion.tokensIn, tokensOut: completion.tokensOut };

    let payload: unknown;
    try {
      payload = JSON.parse(completion.text);
    } catch {
      return failed(item, version, 'ответ не разбирается как JSON', usage);
    }

    const parsed = classifierSchema.safeParse(payload);
    if (!parsed.success) {
      return failed(item, version, 'ответ не прошёл схему', usage);
    }

    /**
     * Кризис по флагу модели проверить нечем: объединённая схема его не
     * возвращает — она возвращает записи. Значит объединение теряет
     * второй контур, и это не мелочь, а довод против него. Здесь
     * учитывается только контур по маркерам.
     */
    const { items } = correctItems(parsed.data, {
      topics: item.topics,
      defaultTopic: item.defaultTopic,
      timeZone: item.timeZone,
      now,
      promptVersion: version,
      logger: deps.logger,
    });

    return {
      id: item.id,
      note: item.note,
      result: matchItems(item, items),
      crisis: { detected: detectCrisis(item.text, false).detected, expected: item.expected.crisis },
      promptVersions: { classifier: version },
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
    };
  } catch (error) {
    deps.logger?.error({ err: error, id: item.id }, 'Случай не прогнался объединённым путём');
    return failed(
      item,
      version,
      error instanceof Error ? error.message : 'неизвестный отказ',
      usage,
    );
  }
}

function matchItems(item: EvalCase, items: readonly ClassifiedItem[]): MatchResult {
  return match(item.expected.units, items);
}

export async function runMergedDataset(
  deps: MergedDeps,
  cases: readonly EvalCase[],
  version: string,
): Promise<MergedOutcome[]> {
  const outcomes: MergedOutcome[] = [];

  // Последовательно, как и обычный прогон: параллельный упёрся бы в
  // ограничение частоты у провайдера.
  for (const item of cases) {
    outcomes.push(await runMergedCase(deps, item, version));
  }

  return outcomes;
}
