import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { evalFreshness, reportByName, type FreshnessReason } from '../eval/freshness.js';
import { shares, type EvalReport } from '../eval/report.js';
import type { ResolverReport } from '../eval/resolver-report.js';

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

/**
 * Причина словами: стадия приезжает отдельным полем.
 *
 * Панель переводит ключ в человеческое имя («Маршрутизатор»), а здесь
 * нужен как раз ключ — таким, каким он в базе, в отчёте и в имени файла
 * промпта: по нему и идут править.
 */
function said(reason: FreshnessReason): string {
  return typeof reason === 'string' ? reason : `${reason.stage}: ${reason.text}`;
}

if (!verdict.ok) {
  fail([
    ...verdict.reasons.map(said),
    '',
    '§10.3 ТЗ: любое изменение промпта прогоняется по набору. Прогнать:',
    '    npx tsx src/scripts/run-eval.ts ../../docs/eval',
  ]);
}

/**
 * Печать итога — по **зачтённым** отчётам, а не по самым свежим.
 *
 * Сверку делает `evalFreshness`, здесь только числа для человека: какой
 * отчёт зачли и что в нём получилось. Проверять что-либо ещё раз тут
 * нельзя — две проверки одного правила разойдутся.
 *
 * **Ревизия четвёртого этапа нашла здесь неправду.** Печатался самый
 * свежий отчёт вообще, со словами «порог пройден», — а заслон мог зачесть
 * другой: на откате ищется прогон этого сочетания версий, а не последний
 * по времени. Человек читал числа одного прогона под вердиктом о другом.
 * Имя зачтённого лежало рядом, в `verdict.runs`, и не использовалось.
 */

for (const name of verdict.runs) {
  const main = (await reportByName(join(evalDir, 'runs'), name, 'eval')) as EvalReport | undefined;

  if (main !== undefined) {
    const found = shares(main);

    process.stdout.write(
      `Зачтён прогон ${name}: найдено ${(found.recall * 100).toFixed(1)}%, ` +
        `точность типа ${(found.type * 100).toFixed(1)}%.\n`,
    );

    continue;
  }

  const resolver = (await reportByName(join(evalDir, 'resolver', 'runs'), name, 'resolver')) as
    ResolverReport | undefined;

  if (resolver !== undefined) {
    process.stdout.write(
      `Зачтён прогон резолвера ${name}: ${String(resolver.decisionCorrect)} из ` +
        `${String(resolver.cases)} решений верны, ложных применений ` +
        `${String(resolver.falseApplies)}, подмен слов ${String(resolver.rewrittenText)}.\n`,
    );

    continue;
  }

  // Отчёт зачли, а прочитать не смогли — сказать об этом надо: молчание
  // здесь читалось бы как «числа сошлись».
  process.stdout.write(`Зачтён прогон ${name}, но прочитать его не удалось.\n`);
}

if (verdict.unmeasured.length > 0) {
  // Молчание тут прочлось бы как «проверено». Не проверено — нечем.
  process.stdout.write(
    `Набор не мерит: ${verdict.unmeasured.join(', ')} — включается без измерения.\n`,
  );
}
