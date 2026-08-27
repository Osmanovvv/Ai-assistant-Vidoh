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
 *   AI_PROVIDER=yandex YANDEX_API_KEY=… YANDEX_FOLDER_ID=… \
 *     npx tsx src/scripts/run-eval-merged.ts ../../docs/eval
 *
 * Базы не требует: расход в учёт не пишется (объединённого этапа в
 * справочнике нет), а промпт лежит файлом, не в таблице версий. Оба
 * решения объяснены в `eval/merged.ts`.
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

const outcomes = await runMergedDataset(
  { provider: createLlmProvider(env), prompt: await readFile(PROMPT, 'utf8'), logger },
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

process.exit(verdict.passed ? 0 : 1);
