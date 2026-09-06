import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { checkThreshold, type EvalReport } from './report.js';
import { checkResolverThreshold, type ResolverReport } from './resolver-report.js';

/**
 * Прогнан ли контрольный набор на этих версиях промптов (§10.3 ТЗ).
 *
 * §10.3 дословно: «Любое изменение промпта прогоняется по контрольному
 * набору. **Выкладка только при отсутствии ухудшения.**»
 *
 * **Это правило уже нарушалось, и дорого.** 28.08.2026 выложили
 * `router@3`, потом `router@4`, не прогнав набор. Регрессия дошла до
 * боевого и жила там, пока не попросили перемерить приёмку: промпт терял
 * три единицы из сорока трёх — семь процентов сказанного человеком не
 * превращалось в записи.
 *
 * **Вынесено сюда из скрипта заливки, потому что читателей стало два.**
 * Второй — админ-панель (задача 4.8): §15 разрешает менять промпт без
 * выкладки, и без этой проверки «без выкладки» превращается в способ
 * уронить качество молча, минуя единственный заслон. Две копии одного
 * правила разошлись бы, и разошлись бы в сторону «разрешить».
 *
 * **Наборов два, и это важно.** Общий мерит разбор (маршрутизатор,
 * извлечение, классификация), у резолвера свой — со своим отчётом и своим
 * порогом. Пока проверка резолвера жила только в скрипте заливки, панель
 * могла включить его промпт вообще без измерения: ровно та дыра, ради
 * которой заслон и ставится. Теперь оба набора проверяются здесь.
 */

export interface FreshnessOk {
  readonly ok: true;
  /** Отчёты, которыми подтверждены включаемые версии. */
  readonly runs: readonly string[];
  /**
   * Стадии, у которых измерителя нет вовсе.
   *
   * Не «всё хорошо», а «мерить нечем»: включение разрешено, но человеку
   * это надо сказать вслух, иначе молчание прочтётся как проверка.
   */
  readonly unmeasured: readonly string[];
}

export interface FreshnessProblem {
  readonly ok: false;
  readonly reasons: readonly string[];
  /** Отчёты, которые смотрели: пусто, если их не нашлось. */
  readonly runs: readonly string[];
}

/** Прогона нет, он про другие версии или не прошёл порог. */
export type FreshnessVerdict = FreshnessOk | FreshnessProblem;

/**
 * Стадии, которые прогоняет общий набор.
 *
 * Представления здесь нет: набор мерит **разбор**, а не ответ. Поэтому
 * промпт представления можно менять без прогона — и это не послабление, а
 * отсутствие измерителя, о котором надо помнить.
 */
export const MEASURED_STAGES = ['router', 'extractor', 'classifier'] as const;

export type MeasuredStage = (typeof MEASURED_STAGES)[number];

/** У резолвера свой набор, свой отчёт и свой порог. */
export const RESOLVER_STAGE = 'resolver';

/** Самый свежий отчёт прогона. Имена файлов — время, сортировка честная. */
export async function newestRun(
  evalDir: string,
): Promise<{ readonly name: string; readonly report: EvalReport } | undefined> {
  const found = await newestIn(join(evalDir, 'runs'));
  return found === undefined ? undefined : { name: found.name, report: found.report as EvalReport };
}

/** Самый свежий отчёт прогона резолвера. */
export async function newestResolverRun(
  evalDir: string,
): Promise<{ readonly name: string; readonly report: ResolverReport } | undefined> {
  const found = await newestIn(join(evalDir, 'resolver', 'runs'));

  return found === undefined
    ? undefined
    : { name: found.name, report: found.report as ResolverReport };
}

async function newestIn(
  runs: string,
): Promise<{ readonly name: string; readonly report: unknown } | undefined> {
  for await (const run of runsNewestFirst(runs)) return run;
  return undefined;
}

/**
 * Сколько отчётов вообще смотрим, вглубь от свежего.
 *
 * Прогонов за год накопятся сотни, а откатываются всегда на недавнее.
 * Читать всю историю ради версии годовой давности — лишняя работа на
 * каждом открытии страницы.
 */
const HISTORY_DEPTH = 60;

/** Отчёты от свежего к старому. Имена файлов — время, сортировка честная. */
async function* runsNewestFirst(
  runs: string,
): AsyncGenerator<{ readonly name: string; readonly report: unknown }> {
  let files: string[];
  try {
    files = (await readdir(runs)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return;
  }

  for (const name of files.slice(-HISTORY_DEPTH).reverse()) {
    try {
      yield { name, report: JSON.parse(await readFile(join(runs, name), 'utf8')) };
    } catch {
      // Битый отчёт — это «такого прогона нет», а не «прогон прошёл».
      // Молчаливое «всё хорошо» здесь стоило бы регрессии на боевом.
      continue;
    }
  }
}

/**
 * Сверить версии, которые собираются включить, со свежими прогонами.
 *
 * `activating` — какие версии станут активными: стадия → версия.
 * Проверяется только то, что действительно включается: набор, который
 * никого из включаемых стадий не касается, ни на что не влияет.
 */
export async function evalFreshness(params: {
  readonly evalDir: string;
  readonly activating: ReadonlyMap<string, string>;
}): Promise<FreshnessVerdict> {
  const reasons: string[] = [];
  const runs: string[] = [];

  const touchesMain = MEASURED_STAGES.some((stage) => params.activating.has(stage));

  if (touchesMain) {
    const problem = await checkMain(params.evalDir, params.activating, runs);
    if (problem !== undefined) reasons.push(...problem);
  }

  if (params.activating.has(RESOLVER_STAGE)) {
    const problem = await checkResolver(
      params.evalDir,
      params.activating.get(RESOLVER_STAGE) ?? '',
      runs,
    );
    if (problem !== undefined) reasons.push(...problem);
  }

  if (reasons.length > 0) return { ok: false, reasons, runs };

  const unmeasured = [...params.activating.keys()].filter(
    (stage) => stage !== RESOLVER_STAGE && !(MEASURED_STAGES as readonly string[]).includes(stage),
  );

  return { ok: true, runs, unmeasured };
}

/**
 * Общий набор: разбор. Возвращает причины отказа или ничего.
 *
 * Ищется **самый свежий прогон именно этого сочетания версий**, а не
 * просто самый свежий. Разница видна на откате: включили новую версию,
 * измерили, стало хуже — и вернуться назад по правилу «сверять только с
 * последним прогоном» стало бы нельзя, хотя прежнее сочетание мерили и
 * оно прошло. Заслон, мешающий откатиться, опаснее отсутствующего:
 * откатываются в аварию.
 *
 * Сочетание, а не отдельная версия: 28.08.2026 подвело именно оно —
 * стадии мерили порознь, а включали вместе.
 */
async function checkMain(
  evalDir: string,
  activating: ReadonlyMap<string, string>,
  runs: string[],
): Promise<readonly string[] | undefined> {
  let newest: { readonly name: string; readonly report: EvalReport } | undefined;

  for await (const run of runsNewestFirst(join(evalDir, 'runs'))) {
    const report = run.report as EvalReport;
    newest ??= { name: run.name, report };

    const measured = report.promptVersions;
    const fits = MEASURED_STAGES.every((stage) => {
      const now = activating.get(stage);
      return now === undefined || now === measured[stage];
    });

    if (!fits) continue;

    runs.push(run.name);

    const verdict = checkThreshold(report);

    return verdict.passed
      ? undefined
      : [`Прогон этих версий (${run.name}) не прошёл порог:`, ...verdict.failures];
  }

  if (newest === undefined) {
    return [
      'Прогона контрольного набора нет ни одного.',
      '§10.3 ТЗ: выкладка промптов только при отсутствии ухудшения.',
    ];
  }

  runs.push(newest.name);

  const measured = newest.report.promptVersions;
  const mismatch = MEASURED_STAGES.flatMap((stage) => {
    const now = activating.get(stage);
    if (now === undefined || now === measured[stage]) return [];

    return [`${stage}: включается ${now}, а мерили ${measured[stage] ?? 'ничего'}`];
  });

  return [
    `Такого сочетания версий не прогоняли ни разу. Свежий прогон (${newest.name}):`,
    ...mismatch,
  ];
}

/** Набор резолвера: свой отчёт, свой порог, та же логика поиска. */
async function checkResolver(
  evalDir: string,
  version: string,
  runs: string[],
): Promise<readonly string[] | undefined> {
  let newest: { readonly name: string; readonly report: ResolverReport } | undefined;

  for await (const run of runsNewestFirst(join(evalDir, 'resolver', 'runs'))) {
    const report = run.report as ResolverReport;
    newest ??= { name: run.name, report };

    if (report.promptVersion !== version) continue;

    runs.push(run.name);

    const verdict = checkResolverThreshold(report);

    return verdict.passed
      ? undefined
      : [`Прогон резолвера на этой версии (${run.name}) не прошёл порог:`, ...verdict.failures];
  }

  if (newest === undefined) {
    return [
      'Прогона контрольного набора резолвера нет ни одного.',
      '§10.3 ТЗ: выкладка промптов только при отсутствии ухудшения.',
    ];
  }

  runs.push(newest.name);

  return [
    `Резолвер ${version} не прогоняли ни разу.`,
    `Свежий прогон (${newest.name}) сделан на ${newest.report.promptVersion}.`,
  ];
}
