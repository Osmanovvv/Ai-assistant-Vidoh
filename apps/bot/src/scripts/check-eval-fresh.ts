import { readdir } from 'node:fs/promises';
import { basename } from 'node:path';

import {
  evalFreshness,
  MEASURED_STAGES,
  newestResolverRun,
  newestRun,
  RESOLVER_STAGE,
} from '../eval/freshness.js';
import { shares } from '../eval/report.js';

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

const activating = await versionsToActivate();

/**
 * Сверка вынесена в `eval/freshness.ts` (задача 4.8).
 *
 * Читателей у правила стало два: этот скрипт и админ-панель, где §15
 * разрешает менять промпт без выкладки. Две копии одного правила
 * разошлись бы — и разошлись бы в сторону «разрешить».
 */
const verdict = await evalFreshness({ evalDir, activating });

if (!verdict.ok) {
  fail([
    ...verdict.reasons,
    '',
    '§10.3 ТЗ: любое изменение промпта прогоняется по набору. Прогнать:',
    '    npx tsx src/scripts/run-eval.ts ../../docs/eval',
  ]);
}

/**
 * Печать итога.
 *
 * Сверку делает `evalFreshness`, здесь только числа для человека: какой
 * отчёт зачли и что в нём получилось. Проверять что-либо ещё раз тут
 * нельзя — две проверки одного правила разойдутся.
 */

const run = await newestRun(evalDir);

if (run !== undefined && MEASURED_STAGES.some((stage) => activating.has(stage))) {
  const found = shares(run.report);

  process.stdout.write(
    `Прогон ${run.name}: найдено ${(found.recall * 100).toFixed(1)}%, ` +
      `точность типа ${(found.type * 100).toFixed(1)}% — порог пройден.\n`,
  );
}

const resolverVersion = activating.get(RESOLVER_STAGE);
const resolverRun = resolverVersion === undefined ? undefined : await newestResolverRun(evalDir);

if (resolverVersion !== undefined && resolverRun !== undefined) {
  process.stdout.write(
    `Резолвер ${resolverVersion}: ${String(resolverRun.report.decisionCorrect)} из ` +
      `${String(resolverRun.report.cases)} решений верны, ложных применений нет.\n`,
  );
}

if (verdict.unmeasured.length > 0) {
  // Молчание тут прочлось бы как «проверено». Не проверено — нечем.
  process.stdout.write(
    `Набор не мерит: ${verdict.unmeasured.join(', ')} — включается без измерения.\n`,
  );
}
