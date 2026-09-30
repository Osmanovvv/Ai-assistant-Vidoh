import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { DecomposedSteps } from '../modules/ai/schemas/index.js';
import { shortTitleFrom } from '../modules/projects/project-title.js';

/**
 * Замер раскладки больших целей (правка заказчицы 30.09.2026) на наборе
 * docs/eval-goals/cases.md: шаги и короткое название.
 *
 *   npx tsx src/scripts/check-goals.ts ../../docs/eval-goals/cases.md --model --budget 8
 *     — живая модель с потолком расхода; ответы пишутся в runs/;
 *   … --replay <файл> — бесплатно: те же ответы, судит нынешний код.
 *
 * Название судится после проверки кодом (`shortTitleFrom`) — ровно то,
 * что увидит человек. Ворота: НЕВЕРНО 0.
 */

interface Case {
  readonly goal: string;
  readonly section: string;
  /** Ожидаемое короткое название; нет — название не меняется. */
  readonly title: string | undefined;
}

interface Recorded {
  readonly goal: string;
  /** Что ответила модель; `null` — не ответила. */
  readonly answer: DecomposedSteps | null;
}

function parse(text: string): Case[] {
  const cases: Case[] = [];
  let section: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('## ')) {
      section = line.slice(3);
      continue;
    }
    if (section === undefined) continue;
    const at = line.indexOf(' => ');
    if (at < 0) continue;
    const expected = line.slice(at + 4).trim();
    cases.push({
      goal: line.slice(0, at),
      section,
      title: expected === 'то же' ? undefined : expected,
    });
  }
  return cases;
}

type Verdict = 'верно' | 'промах' | 'НЕВЕРНО' | 'не ответила';

function judge(one: Case, accepted: string | undefined): Verdict {
  if (accepted === one.title) return 'верно';
  if (accepted === undefined) return 'промах';
  return 'НЕВЕРНО';
}

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

function argumentAfter(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at < 0 ? undefined : process.argv[at + 1];
}

/** Модель — та же, что на бою, с потолком расхода. */
async function liveDecomposer(): Promise<{
  readonly name: string;
  readonly ask: (goal: string) => Promise<DecomposedSteps | null>;
  readonly finish: () => Promise<string>;
}> {
  const { modelEnvSchema } = await import('../config/env.js');
  const { parseBudget, withRunBudget } = await import('../eval/budget.js');
  const { closeDb, getDb } = await import('../infra/db.js');
  const { createLogger } = await import('../infra/logger.js');
  const { requestStructured } = await import('../modules/ai/client.js');
  const { PromptRegistry } = await import('../modules/ai/prompts/registry.js');
  const { createLlmProvider } = await import('../modules/ai/providers/factory.js');
  const { ceilingFromEnv } = await import('../modules/metering/account-spend.js');
  const { costLine, runCost } = await import('../modules/metering/run-cost.js');
  const { createSpendGuard } = await import('../modules/metering/spend-guard.js');

  const { budgetRub } = parseBudget(process.argv.slice(2));
  const env = modelEnvSchema.parse(process.env);
  if (env.AI_PROVIDER !== 'mock' && budgetRub === undefined) {
    throw new Error('Живой прогон — только с --budget <₽>.');
  }

  const db = getDb();
  const startedAt = new Date();
  const logger = createLogger({ level: 'warn' });
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
  const prompts = new PromptRegistry(db, 0);
  const provider = createLlmProvider(env);
  const ai = { db, provider, prompts, logger, spendGuard, retry: { attempts: 2 } };

  const active = await prompts.get('decomposer');
  say(
    `Промпт: ${active.version}. Модель: ${provider.name}.` +
      (budgetRub === undefined ? '' : ` Потолок: ${budgetRub.toFixed(2)} ₽.`),
  );

  return {
    name: provider.name,
    ask: async (goal) => {
      const outcome = await requestStructured<DecomposedSteps>(ai, {
        stage: 'decomposer',
        input: goal,
      });
      return outcome.ok ? outcome.value : null;
    },
    finish: async () => {
      const cost = await runCost(db, { startedAt, now: new Date() });
      await closeDb();
      return `${costLine(cost, ceilings)} Промпт ${active.version}.`;
    },
  };
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (path === undefined) throw new Error('Путь к набору: …/docs/eval-goals/cases.md');
  const cases = parse(await readFile(path, 'utf8'));

  const replayPath = argumentAfter('--replay');
  const replayed =
    replayPath === undefined
      ? undefined
      : (JSON.parse(await readFile(replayPath, 'utf8')) as { readonly calls: Recorded[] }).calls;
  const live = process.argv.includes('--model') ? await liveDecomposer() : undefined;
  if (live === undefined && replayed === undefined) {
    throw new Error('Нужен --model --budget <₽> или --replay <файл>.');
  }

  const verdicts = new Map<Verdict, number>();
  const calls: Recorded[] = [];
  const bad: string[] = [];
  let stopped: string | undefined;
  let section: string | undefined;

  for (const one of cases) {
    if (one.section !== section) {
      section = one.section;
      say(`\n## ${section}`);
    }

    let answer = replayed?.find((call) => call.goal === one.goal)?.answer;
    if (answer === undefined && live !== undefined && stopped === undefined) {
      try {
        answer = await live.ask(one.goal);
      } catch (error) {
        stopped = error instanceof Error ? error.message : String(error);
      }
    }
    if (answer === undefined) {
      say(`  «${one.goal}» — модель не спрашивали`);
      continue;
    }
    calls.push({ goal: one.goal, answer });

    if (answer === null) {
      verdicts.set('не ответила', (verdicts.get('не ответила') ?? 0) + 1);
      say(`  ✗ «${one.goal}» — модель не ответила`);
      continue;
    }

    const steps = answer.steps.map((step) => step.trim()).filter((step) => step.length > 0);
    const accepted = shortTitleFrom(one.goal, answer.title, steps);
    const verdict = judge(one, accepted);
    verdicts.set(verdict, (verdicts.get(verdict) ?? 0) + 1);
    const mark = verdict === 'верно' ? '✓' : verdict === 'промах' ? '·' : '✗';
    say(
      `  ${mark} «${one.goal}»\n` +
        `      модель: «${answer.title ?? '—'}» → название: «${accepted ?? one.goal}»` +
        (verdict === 'верно' ? '' : ` — ${verdict}`) +
        `\n      шаги (${String(steps.length)}): ${steps.join(' | ')}`,
    );
    if (verdict === 'НЕВЕРНО') bad.push(`  «${one.goal}» → «${accepted ?? ''}»`);
  }

  const judged = [...verdicts.values()].reduce((sum, count) => sum + count, 0);
  const right = verdicts.get('верно') ?? 0;
  say(
    `\nВсего ${String(judged)}: верно ${String(right)}` +
      `, промахов ${String(verdicts.get('промах') ?? 0)}` +
      `, НЕВЕРНО ${String(verdicts.get('НЕВЕРНО') ?? 0)}` +
      `, не ответила ${String(verdicts.get('не ответила') ?? 0)}.`,
  );
  if (bad.length > 0) say(`Неверно:\n${bad.join('\n')}`);
  if (stopped !== undefined) say(`Остановлено: ${stopped}`);

  if (live !== undefined) {
    say(await live.finish());
    const runs = join(dirname(path), 'runs');
    await mkdir(runs, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const file = `goals-${stamp}.json`;
    await writeFile(join(runs, file), JSON.stringify({ model: live.name, calls }, null, 2), 'utf8');
    say(`Ответы модели: runs/${file}`);
  }
}

await main();
