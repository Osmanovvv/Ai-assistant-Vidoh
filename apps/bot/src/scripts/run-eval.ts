import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadDataset } from '../eval/dataset.js';
import { checkThreshold, collect, format, type EvalReport } from '../eval/report.js';
import { runDataset } from '../eval/runner.js';
import { modelEnvSchema } from '../config/env.js';
import { closeDb, getDb } from '../infra/db.js';
import { createLogger } from '../infra/logger.js';
import { PromptRegistry } from '../modules/ai/prompts/registry.js';
import { createLlmProvider } from '../modules/ai/providers/factory.js';

/**
 * Прогон контрольного набора (задачи 2.19 и 2.20).
 *
 * Запуск:
 *   DATABASE_URL=… AI_PROVIDER=yandex YANDEX_API_KEY=… YANDEX_FOLDER_ID=… \
 *     npx tsx src/scripts/run-eval.ts ../../docs/eval
 *
 * §10.3 требует прогона на каждое изменение промпта. Отчёт печатается и
 * складывается в `<папка>/runs`, чтобы следующий прогон показал разницу:
 * без сравнения с прошлым числа не значат ничего.
 *
 * **Базу берёт ту, что дана.** Расход прогона пишется в учёт, как у
 * настоящих вызовов (§10.5) — значит боевую базу подставлять нельзя,
 * иначе прогоны исказят себестоимость выгрузки.
 */

const [, , directory] = process.argv;

if (directory === undefined) {
  process.stderr.write(
    'Использование: run-eval <папка-с-набором>\n' +
      '  Настоящий набор лежит в docs/eval — вне репозитория.\n' +
      '  Синтетический, для проверки самого стенда: src/eval/synthetic\n',
  );
  process.exit(2);
}

const logger = createLogger({ level: 'info', pretty: true });
const env = modelEnvSchema.parse(process.env);
const db = getDb();

/** Прошлый прогон: по нему считается разница. */
async function previousRun(runs: string): Promise<EvalReport | undefined> {
  try {
    const files = (await readdir(runs)).filter((name) => name.endsWith('.json')).sort();
    const last = files.at(-1);
    if (last === undefined) return undefined;

    return JSON.parse(await readFile(join(runs, last), 'utf8')) as EvalReport;
  } catch {
    // Первого прогона ещё не было — это не ошибка.
    return undefined;
  }
}

try {
  const cases = await loadDataset(directory);
  logger.info({ случаев: cases.length }, 'Набор загружен');

  const prompts = new PromptRegistry(db);
  const full = createLlmProvider(env);
  const light = createLlmProvider(env, { light: true });

  logger.info({ полная: full.name, лёгкая: light.name }, 'Провайдеры выбраны');

  const outcomes = await runDataset(
    {
      ai: { db, provider: full, prompts, logger },
      aiLight: { db, provider: light, prompts, logger },
      logger,
    },
    cases,
  );

  const report = collect(outcomes);
  const runs = join(directory, 'runs');
  const previous = await previousRun(runs);

  process.stdout.write(`\n${format(report, previous)}\n\n`);

  // Промахи по одному: без них отчёт говорит «85%», но не говорит, где
  // именно ошиблись, а править надо промпт, а не число.
  for (const outcome of outcomes) {
    for (const unit of outcome.result.missed) {
      process.stdout.write(
        `  потеряно [${outcome.id}] ${unit.keywords.join(' + ')}${unit.why === '' ? '' : ` — ${unit.why}`}\n`,
      );
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
    // Двоякое ожидание — это наша ошибка разметки, и она искажает счёт:
    // одно ожидание забирает запись, которую ждало другое, и второе
    // считается потерянным. Поэтому надо назвать виновника, а не только
    // сообщить, что он есть.
    for (const unit of outcome.result.ambiguous) {
      process.stdout.write(
        `  двояко [${outcome.id}] ${unit.keywords.join(' + ')} — корни подошли больше чем одной записи\n`,
      );
    }
    if (outcome.failed !== undefined) {
      process.stdout.write(`  отказ [${outcome.id}] ${outcome.failed}\n`);
    }
  }

  const verdict = checkThreshold(report);
  process.stdout.write(
    verdict.passed
      ? '\nПорог качества пройден.\n'
      : `\nПорог качества НЕ пройден:\n${verdict.failures.map((line) => `  — ${line}`).join('\n')}\n`,
  );

  await mkdir(runs, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  await writeFile(join(runs, `${stamp}.json`), JSON.stringify(report, null, 2), 'utf8');
  logger.info({ файл: `${stamp}.json` }, 'Прогон сохранён');

  await closeDb();
  process.exit(verdict.passed ? 0 : 1);
} catch (error) {
  logger.error({ err: error }, 'Прогон не удался');
  await closeDb();
  process.exit(1);
}
