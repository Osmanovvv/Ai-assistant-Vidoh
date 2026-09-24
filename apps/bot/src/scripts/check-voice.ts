import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { modelEnvSchema } from '../config/env.js';
import type { AiStage } from '../db/schema.js';
import { BadBudgetError, parseBudget, withRunBudget } from '../eval/budget.js';
import { BadPinError, parsePins } from '../eval/pins.js';
import { closeDb, getDb } from '../infra/db.js';
import { createLogger } from '../infra/logger.js';
import { PromptRegistry } from '../modules/ai/prompts/registry.js';
import { createLlmProvider } from '../modules/ai/providers/factory.js';
import { askContextLine, checkContextLine } from '../modules/presenter/context-line.js';
import { renderContextPack, type ContextPack } from '../modules/presenter/context-pack.js';
import { ceilingFromEnv } from '../modules/metering/account-spend.js';
import { costLine, runCost } from '../modules/metering/run-cost.js';
import { createSpendGuard } from '../modules/metering/spend-guard.js';

/**
 * Стенд живой строки (слой A, 22.09.2026).
 *
 * Каждый случай — готовый контекст (`ContextPack`) из живых ситуаций:
 * повтор, просроченное, час на сегодня, недавно закрытое, тишина,
 * первая выгрузка, усталость, сильная эмоция. Стенд спрашивает модель
 * тем же путём, что и бой (`askContextLine`), и печатает строку, вердикт
 * стража и цену. Тон судит человек — по её тексту о характере; стенд
 * стережёт, чтобы ни одна строка не прошла мимо стража.
 *
 * Деньги: ≈1,5–2 ₽ на случай (промпт длинный). Потолок обязателен.
 *
 * Запуск:
 *   AI_PROVIDER=yandex DATABASE_URL=… npx tsx src/scripts/check-voice.ts ../../docs/eval-voice --budget 30
 *   … --use presenter=presenter@3   — сравнить версию до включения
 */

interface VoiceCase {
  readonly id: string;
  readonly note?: string | undefined;
  /** Ожидание человека: пусто ли должно быть. Не страж — подсказка глазу. */
  readonly expectEmpty?: boolean | undefined;
  readonly pack: ContextPack;
}

function parseArguments(argv: readonly string[]): {
  readonly budgetRub: number | undefined;
  readonly pinned: ReadonlyMap<AiStage, string>;
  readonly rest: readonly string[];
} {
  try {
    const pins = parsePins(argv);
    const budget = parseBudget(pins.rest);
    return { budgetRub: budget.budgetRub, pinned: pins.pinned, rest: budget.rest };
  } catch (error) {
    if (error instanceof BadBudgetError || error instanceof BadPinError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
}

const { budgetRub, pinned: pinnedVersions, rest } = parseArguments(process.argv.slice(2));

/** `--only voice-04,voice-09` — только названные случаи (по началу имени). */
function parseOnly(argv: readonly string[]): { only: readonly string[]; rest: readonly string[] } {
  const only: string[] = [];
  const kept: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? '';
    const value =
      argument === '--only'
        ? argv[++index]
        : argument.startsWith('--only=')
          ? argument.slice('--only='.length)
          : undefined;
    if (value === undefined) kept.push(argument);
    else
      only.push(
        ...value
          .split(',')
          .map((one) => one.trim())
          .filter((one) => one !== ''),
      );
  }
  return { only, rest: kept };
}

const { only, rest: positional } = parseOnly(rest);
const [directory] = positional;
if (directory === undefined) {
  process.stderr.write(
    'Использование: check-voice <папка-набора> --budget <₽> [--use presenter=версия] [--only id,id]\n',
  );
  process.exit(2);
}

const env = modelEnvSchema.parse(process.env);
const logger = createLogger({ level: 'warn' });
const db = getDb();
const startedAt = new Date();

if (env.AI_PROVIDER !== 'mock' && budgetRub === undefined) {
  process.stderr.write('Живой прогон — только с --budget <₽>.\n');
  await closeDb();
  process.exit(2);
}

const ceilings = {
  ...(ceilingFromEnv(env.ACCOUNT_SPEND_CEILING_RUB) === undefined
    ? {}
    : { total: ceilingFromEnv(env.ACCOUNT_SPEND_CEILING_RUB) }),
  ...(ceilingFromEnv(env.ACCOUNT_SPEND_DAILY_RUB) === undefined
    ? {}
    : { daily: ceilingFromEnv(env.ACCOUNT_SPEND_DAILY_RUB) }),
};
const accountGuard = createSpendGuard({
  db,
  ceilings,
  warnShare: env.ACCOUNT_SPEND_WARN_SHARE,
  logger,
});
const spendGuard =
  budgetRub === undefined
    ? accountGuard
    : withRunBudget(accountGuard, { db, startedAt, budgetRub });

const casesDir = join(directory, 'cases');
const files = (await readdir(casesDir)).filter((name) => name.endsWith('.json')).sort();
const cases: VoiceCase[] = [];
for (const file of files) {
  const one = JSON.parse(await readFile(join(casesDir, file), 'utf8')) as VoiceCase;
  if (only.length === 0 || only.some((prefix) => one.id.startsWith(prefix))) cases.push(one);
}

const prompts = new PromptRegistry(db, 0, pinnedVersions);
const provider = createLlmProvider(env);
const ai = { db, provider, prompts, logger, spendGuard, retry: { attempts: 2 } };

const active = await prompts.get('presenter');
process.stdout.write(
  `Случаев: ${String(cases.length)}. Промпт: ${active.version} (${active.schemaName}). ` +
    `Модель: ${provider.name}.` +
    (budgetRub === undefined ? '' : ` Потолок: ${budgetRub.toFixed(2)} ₽.`) +
    '\n\n',
);

interface Outcome {
  readonly id: string;
  readonly note: string | undefined;
  readonly expectEmpty: boolean;
  readonly line: string | undefined;
  readonly why: string | undefined;
  readonly rejected: string | undefined;
}

const outcomes: Outcome[] = [];
let stopped: string | undefined;

for (const one of cases) {
  let outcome: Outcome;
  try {
    const asked = await askContextLine(ai, { pack: one.pack });
    outcome = {
      id: one.id,
      note: one.note,
      expectEmpty: one.expectEmpty === true,
      line: asked.line,
      why: asked.why,
      rejected: asked.rejected,
    };
  } catch (error) {
    stopped = error instanceof Error ? error.message : String(error);
    break;
  }
  outcomes.push(outcome);

  const verdict =
    outcome.line !== undefined
      ? `✓ ${outcome.line}`
      : outcome.why === 'пусто'
        ? '— (пусто)'
        : outcome.why === 'нет повода'
          ? '— (пусто: повода нет, модель не звали)'
          : `✗ отвергнута: ${outcome.why ?? '?'}` +
            (outcome.rejected === undefined ? '' : ` — «${outcome.rejected}»`);
  const mark = outcome.expectEmpty && outcome.line !== undefined ? '  ← ждали пусто' : '';
  process.stdout.write(
    `${one.id}${one.note === undefined ? '' : ` — ${one.note}`}\n  ${verdict}${mark}\n`,
  );
}

const passed = outcomes.filter((one) => one.line !== undefined).length;
// «Нет повода» — тоже пусто: код не звал модель, строки нет по правилу.
const isEmpty = (one: Outcome): boolean => one.why === 'пусто' || one.why === 'нет повода';
const empty = outcomes.filter(isEmpty).length;
const rejected = outcomes.filter((one) => one.line === undefined && !isEmpty(one));
const reasons = new Map<string, number>();
for (const one of rejected) {
  const key = (one.why ?? '?').replace(/: .*/u, '');
  reasons.set(key, (reasons.get(key) ?? 0) + 1);
}

process.stdout.write(
  `\nСтрока есть: ${String(passed)}, пусто: ${String(empty)}, отвергнуто стражем: ${String(rejected.length)}` +
    (reasons.size === 0
      ? ''
      : ` (${[...reasons].map(([why, n]) => `${why} — ${String(n)}`).join('; ')})`) +
    `, всего ${String(outcomes.length)} из ${String(cases.length)}.\n`,
);
if (stopped !== undefined) process.stdout.write(`Остановлено: ${stopped}\n`);

// Самопроверка стенда: ни одна напечатанная строка не обходит стража.
const packById = new Map(cases.map((one) => [one.id, one.pack]));
for (const one of outcomes) {
  const pack = packById.get(one.id);
  if (one.line === undefined || pack === undefined) continue;
  if (!checkContextLine(one.line, renderContextPack(pack)).ok) {
    process.stdout.write(`ВНИМАНИЕ: строка случая ${one.id} прошла мимо стража\n`);
  }
}

const cost = await runCost(db, { startedAt, now: new Date() });
process.stdout.write(`${costLine(cost, ceilings)}\n`);

const runs = join(directory, 'runs');
await mkdir(runs, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/gu, '-');
await writeFile(
  join(runs, `${stamp}.json`),
  JSON.stringify(
    {
      startedAt: startedAt.toISOString(),
      prompt: active.version,
      model: provider.name,
      outcomes,
      cost: { runMicros: cost.runMicros, calls: cost.calls },
    },
    null,
    2,
  ),
  'utf8',
);
process.stdout.write(`Отчёт: ${basename(runs)}/${stamp}.json\n`);

await closeDb();
process.exitCode = stopped === undefined ? 0 : 1;
