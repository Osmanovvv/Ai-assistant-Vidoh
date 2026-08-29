import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadResolverCases } from '../eval/resolver-dataset.js';
import {
  checkResolverThreshold,
  collectResolver,
  formatResolver,
} from '../eval/resolver-report.js';
import { runResolverDataset } from '../eval/resolver-runner.js';
import { closeDb, getDb } from '../infra/db.js';
import { createLogger } from '../infra/logger.js';
import { PromptRegistry } from '../modules/ai/prompts/registry.js';
import { modelEnvSchema } from '../config/env.js';
import { createLlmProvider } from '../modules/ai/providers/factory.js';
import { PRICING } from '../modules/metering/pricing.js';

/**
 * Прогон контрольного набора резолвера (§10.3 ТЗ).
 *
 * Запуск:
 *   DATABASE_URL=… AI_PROVIDER=yandex YANDEX_API_KEY=… YANDEX_FOLDER_ID=… \
 *     npx tsx src/scripts/run-resolver-eval.ts ../../docs/eval/resolver
 *
 * База нужна не для случаев — они заданы разметкой, — а для учёта
 * расхода и промптов: §10.5 требует записывать каждый вызов, включая
 * прогоны стенда. Иначе себестоимость замеров окажется невидимой, а она
 * уже однажды составила три четверти всего расхода.
 *
 * Отчёт кладётся в `runs/` рядом с набором: заслон перед заливкой
 * промпта ищет его там же.
 */

const [, , datasetArg, outArg] = process.argv;

if (datasetArg === undefined) {
  process.stderr.write('Использование: run-resolver-eval <папка-набора> [папка-отчётов]\n');
  process.exit(2);
}

const dataset: string = datasetArg;
const runs = outArg ?? join(dataset, 'runs');

const env = modelEnvSchema.parse(process.env);
const logger = createLogger({ level: 'warn' });
const db = getDb();

try {
  const cases = await loadResolverCases(dataset);

  if (cases.length === 0) {
    process.stderr.write(`В «${dataset}» нет ни одного случая.\n`);
    process.exit(2);
  }

  const prompts = new PromptRegistry(db);
  const active = await prompts.get('resolver');

  process.stdout.write(`Прогон ${String(cases.length)} случаев на ${active.version}\n\n`);

  const outcomes = await runResolverDataset(
    {
      db,
      provider: createLlmProvider(env),
      prompts,
      pricing: PRICING,
      logger,
    },
    cases,
    (outcome) => {
      const mark = outcome.expected === outcome.actual ? '·' : '×';
      const target = outcome.targetOk ? '' : ' (не та запись)';
      const deadline = outcome.deadlineOk ? '' : ' (не тот срок)';

      process.stdout.write(
        `  ${mark} ${outcome.id.padEnd(24)} ждали ${outcome.expected.padEnd(7)} получили ${outcome.actual}${target}${deadline}\n`,
      );
    },
  );

  const report = collectResolver(outcomes, active.version);
  process.stdout.write(formatResolver(report));

  const verdict = checkResolverThreshold(report);

  if (verdict.passed) {
    process.stdout.write('Порог пройден.\n');
  } else {
    process.stdout.write(
      `Порог не пройден:\n${verdict.failures.map((line) => `  ${line}`).join('\n')}\n`,
    );
  }

  /**
   * Отчёт сохраняется всегда, включая непройденный.
   *
   * Прогон, который «не получился» и потому не записан, — это потерянное
   * наблюдение: разброс между запусками виден только по череде отчётов.
   */
  await mkdir(runs, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  await writeFile(join(runs, `${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);

  process.exit(verdict.passed ? 0 : 1);
} finally {
  await closeDb();
}
