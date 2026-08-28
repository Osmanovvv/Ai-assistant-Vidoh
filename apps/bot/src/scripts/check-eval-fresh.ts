import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { checkThreshold, shares, type EvalReport } from '../eval/report.js';

/**
 * Заслон перед заливкой промптов (§10.3 ТЗ).
 *
 * §10.3 говорит прямо: «Любое изменение промпта прогоняется по контрольному
 * набору. **Выкладка только при отсутствии ухудшения.**»
 *
 * **Я это нарушил 28.08.2026** — выложил `router@3`, потом `router@4`, не
 * прогнав набор. Регрессия дошла до боевого сервера и жила там, пока
 * разработчик не попросил перемерить приёмку: промпт терял три единицы из
 * сорока трёх, то есть семь процентов сказанного человеком не превращалось
 * в записи. Требование процесса было записано в ТЗ и ничем не исполнялось.
 *
 * Теперь исполняется. Скрипт сверяет версии промптов, которые сейчас
 * заливаются, с самым свежим отчётом прогона:
 *
 *   - отчёта нет вовсе — отказ;
 *   - отчёт про другие версии — отказ, с указанием, какие где;
 *   - отчёт не прошёл порог — отказ, со списком причин.
 *
 * Запуск:
 *   npx tsx src/scripts/check-eval-fresh.ts ../../docs/prompts ../../docs/eval
 *
 * Стадию представления набор не прогоняет — он мерит разбор, а не ответ, —
 * поэтому сверяются только маршрутизатор, извлечение и классификация.
 */

const [, , promptsArg, evalArg] = process.argv;

if (promptsArg === undefined || evalArg === undefined) {
  process.stderr.write('Использование: check-eval-fresh <папка-промптов> <папка-набора>\n');
  process.exit(2);
}

const promptsDir: string = promptsArg;
const evalDir: string = evalArg;

/** Стадии, которые прогоняет контрольный набор. */
const STAGES = ['router', 'extractor', 'classifier'] as const;

function fail(lines: readonly string[]): never {
  process.stderr.write(`\n${lines.join('\n')}\n\n`);
  process.exit(1);
}

/** Версии, которые заливка сделает активными: имя файла и есть версия. */
async function versionsToActivate(): Promise<Map<string, string>> {
  const files = (await readdir(promptsDir)).filter((name) => name.endsWith('.md'));
  const versions = new Map<string, string>();

  for (const file of files) {
    const version = basename(file, '.md');
    const [stage] = version.split('@');
    if (stage !== undefined && stage !== version) versions.set(stage, version);
  }

  return versions;
}

/** Самый свежий отчёт прогона. Имена файлов — время в ISO, поэтому сортировка честная. */
async function newestRun(): Promise<{ name: string; report: EvalReport } | undefined> {
  const runs = join(evalDir, 'runs');

  let files: string[];
  try {
    files = (await readdir(runs)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return undefined;
  }

  const newest = files.at(-1);
  if (newest === undefined) return undefined;

  return {
    name: newest,
    report: JSON.parse(await readFile(join(runs, newest), 'utf8')) as EvalReport,
  };
}

const activating = await versionsToActivate();
const run = await newestRun();

if (run === undefined) {
  fail([
    'Прогона контрольного набора нет ни одного.',
    '',
    '§10.3 ТЗ: выкладка промптов только при отсутствии ухудшения. Сначала',
    'прогон:',
    '    npx tsx src/scripts/run-eval.ts ../../docs/eval',
  ]);
}

const measured = run.report.promptVersions;
const mismatch: string[] = [];

for (const stage of STAGES) {
  const now = activating.get(stage);
  const then = measured[stage];

  if (now === undefined) continue;
  if (now !== then) mismatch.push(`  ${stage}: заливается ${now}, а мерили ${then ?? 'ничего'}`);
}

if (mismatch.length > 0) {
  fail([
    `Свежий прогон (${run.name}) сделан на других промптах:`,
    ...mismatch,
    '',
    '§10.3 ТЗ: любое изменение промпта прогоняется по набору. Прогнать:',
    '    npx tsx src/scripts/run-eval.ts ../../docs/eval',
  ]);
}

const verdict = checkThreshold(run.report);

if (!verdict.passed) {
  fail([
    `Свежий прогон (${run.name}) не прошёл порог:`,
    ...verdict.failures.map((line) => `  ${line}`),
    '',
    '§10.3 ТЗ: выкладка только при отсутствии ухудшения.',
  ]);
}

const found = shares(run.report);

process.stdout.write(
  `Прогон ${run.name}: найдено ${(found.recall * 100).toFixed(1)}%, ` +
    `точность типа ${(found.type * 100).toFixed(1)}% — порог пройден.\n`,
);
