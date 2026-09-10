import { closeDb, getDb } from '../infra/db.js';
import { createRunGuard } from '../modules/metering/run-guard.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadDataset } from '../eval/dataset.js';
import { runMergedDataset } from '../eval/merged.js';
import { checkThreshold, collect, format, shares, type EvalReport } from '../eval/report.js';
import { modelEnvSchema } from '../config/env.js';
import { createLogger } from '../infra/logger.js';
import { createLlmProvider } from '../modules/ai/providers/factory.js';

/**
 * Замер объединённого разбора (задача 2.20, §10.1).
 *
 * Запуск:
 *   DATABASE_URL=… AI_PROVIDER=yandex YANDEX_API_KEY=… YANDEX_FOLDER_ID=… \
 *     npx tsx src/scripts/run-eval-merged.ts ../../docs/eval
 *
 * **База нужна.** С задачи 3.82 расход пишется в учёт классификаторским
 * этапом (`eval/merged.ts`) — иначе его не видят ни страж расхода, ни
 * отчёт по базам. Промпт при этом лежит файлом, а не в таблице версий, и
 * справочник этапов ради опыта не пополняется; оба решения объяснены там
 * же. Прежний текст говорил «базы не требует» — под ним строку цены и
 * приписали ниже выхода, из него ведь следует, что печатать нечего.
 *
 * Сравнение идёт с последним обычным прогоном из `<папка>/runs`: одни
 * числа сами по себе не говорят ничего — вопрос всегда «хуже или лучше
 * того, что есть».
 */

const [, , directory] = process.argv;

if (directory === undefined) {
  process.stderr.write('Использование: run-eval-merged <папка-с-набором>\n');
  process.exit(2);
}

// Читаемый вывод — только в терминале человека: в контейнере
// без `pino-pretty` он не нужен и раньше ронял скрипт.
const logger = createLogger({ level: 'info', pretty: process.stdout.isTTY });
const env = modelEnvSchema.parse(process.env);

const PROMPT = join(directory, '..', 'prompts', 'experiments', 'merged@1.md');
const VERSION = 'merged@1';

/** Последний обычный прогон: с ним и сравниваем. */
async function lastRegularRun(runs: string): Promise<EvalReport | undefined> {
  let files: string[];
  try {
    files = (await readdir(runs)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return undefined;
  }

  const latest = files.at(-1);
  if (latest === undefined) return undefined;

  return JSON.parse(await readFile(join(runs, latest), 'utf8')) as EvalReport;
}

const cases = await loadDataset(directory);
const previous = await lastRegularRun(join(directory, 'runs'));

logger.info({ случаев: cases.length, промпт: VERSION }, 'Объединённый прогон');

/**
 * Потолок расхода и учёт (задача 3.82).
 *
 * Прогон целого набора по полной модели стоит десятки рублей и делается
 * подряд помногу раз — это подбор промпта. До этой правки ни один из
 * этих рублей не попадал никуда: ни в учёт, ни в отчёт по базам, ни под
 * потолок. Ровно из таких вызовов и собралось расхождение отчёта со
 * счётом, стоившее гранта 05.09.2026.
 */
const db = getDb();
const guard = createRunGuard({ db, env, logger, startedAt: new Date() });
const refused = await guard.checkBefore();

if (refused !== undefined) {
  process.stderr.write(`Прогон не начат: ${refused}${String.fromCharCode(10)}`);
  await closeDb();
  process.exit(3);
}

const outcomes = await runMergedDataset(
  {
    provider: createLlmProvider(env),
    prompt: await readFile(PROMPT, 'utf8'),
    logger,
    db,
    spendGuard: guard.spendGuard,
    promptVersion: VERSION,
  },
  cases,
  VERSION,
);

const report = collect(outcomes);
process.stdout.write(`\n${format(report, previous)}\n\n`);

for (const outcome of outcomes) {
  for (const unit of outcome.result.missed) {
    process.stdout.write(`  потеряно [${outcome.id}] ${unit.keywords.join(' + ')}\n`);
  }
  for (const { expected, actual } of outcome.result.matched) {
    if (actual.type !== expected.type) {
      process.stdout.write(
        `  тип [${outcome.id}] «${actual.text}»: ожидался ${expected.type}, получен ${actual.type}\n`,
      );
    }
  }
  for (const item of outcome.result.extra) {
    process.stdout.write(`  лишнее [${outcome.id}] «${item.text}»\n`);
  }
  if (outcome.failed !== undefined) {
    process.stdout.write(`  отказ [${outcome.id}] ${outcome.failed}\n`);
  }
}

/**
 * Расход считается на одну выгрузку, а не всего: «всего» зависит от
 * размера набора и ни с чем не сравнивается.
 */
const tokensIn = outcomes.reduce((sum, outcome) => sum + outcome.tokensIn, 0);
const tokensOut = outcomes.reduce((sum, outcome) => sum + outcome.tokensOut, 0);
const perDump = (value: number): string => (value / outcomes.length).toFixed(0);

process.stdout.write(
  [
    '',
    'Расход объединённого пути на одну выгрузку:',
    `  входных токенов:  ${perDump(tokensIn)}`,
    `  выходных токенов: ${perDump(tokensOut)}`,
    `  вызовов модели:   1 вместо 2`,
    '',
  ].join('\n'),
);

const verdict = checkThreshold(report);
const now = shares(report);

process.stdout.write(
  verdict.passed
    ? `Порог качества пройден: точность типа ${(now.type * 100).toFixed(1)}%\n`
    : `Порог качества НЕ пройден:\n${verdict.failures.map((line) => `  — ${line}`).join('\n')}\n`,
);

/**
 * Цена прогона — после итога, но **до** выхода.
 *
 * Прежде `process.exit` стоял выше этих строк, и они не исполнялись ни
 * разу. Молчание двойное: ни типы, ни линтер недостижимости за
 * `process.exit` не видят — для них это обычный вызов, — а из обвязки
 * 3.82 работала только защитная половина, потолок до прогона. Вторая её
 * половина, ради которой всё и делалось, — назвать цену тому, кто
 * платит, — молчала. А этот прогон гоняют как раз пачками, подбирая
 * промпт.
 *
 * Код выхода остаётся про качество: `costReport` не бросает, отказ счёта
 * он печатает строкой.
 */
process.stdout.write(
  String.fromCharCode(10) + (await guard.costReport()) + String.fromCharCode(10),
);
await closeDb();

process.exit(verdict.passed ? 0 : 1);
