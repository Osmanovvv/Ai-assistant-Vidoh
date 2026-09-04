import type { Logger } from 'pino';

import { batches } from '../db/schema.js';

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
  /** Пояс человека: без него дату срока не с чем сравнивать. */
  readonly timeZone: string;
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
  /**
   * Пользователь, от имени которого идёт прогон.
   *
   * Задан — и каждый случай получает свою выгрузку в базе, а расход
   * ложится в учёт так же, как в бою: с привязкой к выгрузке. Без этого
   * себестоимость выгрузки (2.21) из учёта не собрать — вызовы есть, а
   * чьи они, неизвестно. Поймано отчётом себестоимости: «выгрузок: 0».
   */
  readonly owner?: string | undefined;
}

/** Выгрузка под один случай набора: к ней привяжется расход. */
async function openBatch(deps: RunnerDeps, item: EvalCase): Promise<string | undefined> {
  if (deps.owner === undefined) return undefined;

  const [row] = await deps.ai.db
    .insert(batches)
    .values({
      userId: deps.owner,
      status: 'processing',
      combinedText: item.text,
      messageCount: 1,
    })
    .returning({ id: batches.id });

  return row?.id;
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
  const batchId = await openBatch(deps, item);
  const owner = { userId: deps.owner, batchId };

  /** §13.7: при срабатывании кризисного контура разбор прекращается. */
  const stopped = (): CaseOutcome => ({
    id: item.id,
    note: item.note,
    timeZone: item.timeZone,
    result: {
      matched: [],
      missed: [...item.expected.units],
      extra: [],
      ambiguous: [],
      retracted: [],
    },
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

    const routed = await routeIntents(deps.aiLight ?? deps.ai, { input: item.text, ...owner });
    versions.router = routed.promptVersion;

    if (detectCrisis(item.text, routed.crisis).detected) return stopped();

    const dumpText = routed.segments
      .filter((segment) => segment.intent === 'DUMP')
      .map((segment) => segment.text)
      .join('\n');

    const extracted = await extractUnits(deps.ai, {
      input: dumpText === '' ? item.text : dumpText,
      ...owner,
    });
    versions.extractor = extracted.promptVersion;

    if (!extracted.ok) {
      return {
        id: item.id,
        note: item.note,
        timeZone: item.timeZone,
        result: {
          matched: [],
          missed: [...item.expected.units],
          extra: [],
          ambiguous: [],
          retracted: [],
        },
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
      /**
       * Исходная речь передаётся, как и в бою — **и это `dumpText`, а не
       * текст случая.**
       *
       * **Сперва не передавалась вовсе**, и набор не видел ни одной
       * потерянной даты, показывая точность срока 100%. Починили,
       * передав текст случая, — и это было **второе** расхождение,
       * тоньше первого: бой подаёт сюда не речь человека, а пересобранную
       * маршрутизатором выгрузку, только отрезки с намерением `DUMP`,
       * склеенные переводами строк.
       *
       * **Разница не косметическая.** 04.09.2026 маршрутизатор отнёс
       * «Хотя нет, давай мойку лучше в пятницу, вот в пятницу тогда надо
       * помыть машину, ещё позвонить стоматологу, записаться на следующую
       * неделю» к намерению `PATCH`. Этот отрезок в `dumpText` **не
       * попадает вовсе** — 169 знаков речи, включая два новых дела и
       * единственное «на следующую неделю». Набор же получал полный текст
       * и потому показывал, что правила дня работают, тогда как в бою им
       * нечего было читать.
       *
       * Правило простое и стоило трёх суток: сюда идёт **то же значение,
       * что собирает бой**, а не то, из чего бой его собирает.
       */
      spoken: dumpText,
      /**
       * И речь целиком, как в бою: там это `combined`, до отбора по
       * намерениям, здесь — текст случая (задача 3.56).
       */
      speech: item.text,
      now,
      ...owner,
    });
    versions.classifier = classified.promptVersion;

    if (!classified.ok) {
      return {
        id: item.id,
        note: item.note,
        timeZone: item.timeZone,
        result: {
          matched: [],
          missed: [...item.expected.units],
          extra: [],
          ambiguous: [],
          retracted: [],
        },
        crisis: { detected: false, expected: item.expected.crisis },
        failed: `классификация: ${classified.problem}`,
        promptVersions: versions,
      };
    }

    return {
      id: item.id,
      note: item.note,
      timeZone: item.timeZone,
      result: match(item.expected.units, classified.items, item.expected.retracted),
      crisis: { detected: false, expected: item.expected.crisis },
      promptVersions: versions,
    };
  } catch (error) {
    deps.logger?.error({ err: error, id: item.id }, 'Случай не прогнался');

    return {
      id: item.id,
      note: item.note,
      timeZone: item.timeZone,
      result: {
        matched: [],
        missed: [...item.expected.units],
        extra: [],
        ambiguous: [],
        retracted: [],
      },
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
