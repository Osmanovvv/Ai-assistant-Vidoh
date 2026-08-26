import type { Logger } from 'pino';

import type { AiClientDeps } from '../modules/ai/client.js';
import { classifyUnits } from '../modules/classifier/classifier.service.js';
import { extractUnits } from '../modules/extractor/extractor.service.js';
import { detectByMarkers, detectCrisis } from '../modules/safety/crisis.js';
import { routeIntents } from '../modules/router/router.service.js';
import type { EvalCase } from './dataset.js';
import { match, type MatchResult } from './matcher.js';

/**
 * Прогон контрольного набора (задача 2.19).
 *
 * Гоняется тот же путь, которым идёт настоящий разбор: маршрутизатор,
 * извлечение, классификация, кризисный контур. Не весь конвейер — без
 * расшифровки, сохранения и ответа человеку: они к качеству разбора
 * отношения не имеют, а их подмена в стенде только добавляла бы мест,
 * где стенд может врать.
 *
 * **Расход пишется в учёт, как у настоящих вызовов.** Прогон стоит денег,
 * и знать сколько надо: §10.5. Поэтому стенду нужна база — но не боевая,
 * иначе прогоны исказят себестоимость выгрузки.
 */

export interface CaseOutcome {
  readonly id: string;
  readonly note: string;
  readonly result: MatchResult;
  /** §13.7: сработал ли кризисный контур и ожидалось ли это. */
  readonly crisis: { readonly detected: boolean; readonly expected: boolean };
  /** Разбор не удался целиком — считается отдельно от промахов. */
  readonly failed?: string | undefined;
  readonly promptVersions: {
    readonly router?: string | undefined;
    readonly extractor?: string | undefined;
    readonly classifier?: string | undefined;
  };
}

export interface RunnerDeps {
  readonly ai: AiClientDeps;
  /** Лёгкая модель для маршрутизатора, если она отличается (задача 2.4). */
  readonly aiLight?: AiClientDeps | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * Прогоняет один случай.
 *
 * Отказ разбора не роняет прогон: набор из десяти случаев не должен
 * останавливаться на первом сбое сети, иначе мерить придётся по
 * настроению провайдера.
 */
export async function runCase(deps: RunnerDeps, item: EvalCase): Promise<CaseOutcome> {
  const now = new Date(item.now);
  const versions: { router?: string; extractor?: string; classifier?: string } = {};

  /** §13.7: при срабатывании кризисного контура разбор прекращается. */
  const stopped = (): CaseOutcome => ({
    id: item.id,
    note: item.note,
    result: { matched: [], missed: [...item.expected.units], extra: [], ambiguous: [] },
    crisis: { detected: true, expected: item.expected.crisis },
    promptVersions: versions,
  });

  try {
    /**
     * Первый контур считается до обращения к модели — как в бою.
     *
     * Порядок здесь не косметика. Спроси стенд модель прежде, чем
     * проверить маркеры, — и он перестанет мерить то, что происходит на
     * самом деле: свойство «на настоящем кризисе не тратим ни копейки»
     * осталось бы непроверенным. Поймано тестом стенда, а не рассуждением.
     */
    if (detectByMarkers(item.text).detected) return stopped();

    const routed = await routeIntents(deps.aiLight ?? deps.ai, { input: item.text });
    versions.router = routed.promptVersion;

    if (detectCrisis(item.text, routed.crisis).detected) return stopped();

    const dumpText = routed.segments
      .filter((segment) => segment.intent === 'DUMP')
      .map((segment) => segment.text)
      .join('\n');

    const extracted = await extractUnits(deps.ai, {
      input: dumpText === '' ? item.text : dumpText,
    });
    versions.extractor = extracted.promptVersion;

    if (!extracted.ok) {
      return {
        id: item.id,
        note: item.note,
        result: { matched: [], missed: [...item.expected.units], extra: [], ambiguous: [] },
        crisis: { detected: false, expected: item.expected.crisis },
        failed: `извлечение: ${extracted.problem}`,
        promptVersions: versions,
      };
    }

    const classified = await classifyUnits(deps.ai, {
      units: extracted.units,
      topics: item.topics,
      defaultTopic: item.defaultTopic,
      timeZone: item.timeZone,
      now,
    });
    versions.classifier = classified.promptVersion;

    if (!classified.ok) {
      return {
        id: item.id,
        note: item.note,
        result: { matched: [], missed: [...item.expected.units], extra: [], ambiguous: [] },
        crisis: { detected: false, expected: item.expected.crisis },
        failed: `классификация: ${classified.problem}`,
        promptVersions: versions,
      };
    }

    return {
      id: item.id,
      note: item.note,
      result: match(item.expected.units, classified.items),
      crisis: { detected: false, expected: item.expected.crisis },
      promptVersions: versions,
    };
  } catch (error) {
    deps.logger?.error({ err: error, id: item.id }, 'Случай не прогнался');

    return {
      id: item.id,
      note: item.note,
      result: { matched: [], missed: [...item.expected.units], extra: [], ambiguous: [] },
      crisis: { detected: false, expected: item.expected.crisis },
      failed: error instanceof Error ? error.message : 'неизвестный отказ',
      promptVersions: versions,
    };
  }
}

export async function runDataset(
  deps: RunnerDeps,
  cases: readonly EvalCase[],
): Promise<CaseOutcome[]> {
  const outcomes: CaseOutcome[] = [];

  // Последовательно: параллельный прогон упёрся бы в ограничение частоты
  // у провайдера, и часть случаев считалась бы сбойной без причины.
  for (const item of cases) {
    outcomes.push(await runCase(deps, item));
  }

  return outcomes;
}
