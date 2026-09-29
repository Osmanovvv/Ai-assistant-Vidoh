import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { checkedPositions, purchaseList } from '../modules/classifier/purchase-split.js';

/**
 * Замер «покупки позициями» (правка заказчицы 29.09.2026) на наборе
 * docs/eval-purchases/cases.md.
 *
 *   npx tsx src/scripts/check-purchases.ts ../../docs/eval-purchases/cases.md
 *     — бесплатно: узнаёт ли код, кого вообще спрашивать модель;
 *   … --model --budget 30 [--light] [--only <образец>]
 *     — живая модель (полная или лёгкая), с потолком расхода; ответы
 *       пишутся в runs/ и повторяются бесплатно через --replay <файл>.
 *
 * Ответ модели судится после проверки кодом (`checkedPositions`) — ровно
 * то, что увидит человек. Ворота: неверных делений 0, верно ≥ 95%.
 */

type Answer = 'одно' | 'код' | readonly string[];

interface Case {
  readonly title: string;
  readonly section: string;
  readonly answers: readonly Answer[];
}

interface Recorded {
  readonly title: string;
  /** Что ответила модель, до проверки; `null` — не ответила. */
  readonly positions: readonly string[] | null;
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
    const answers = line
      .slice(at + 4)
      .split(' || ')
      .map((one): Answer => {
        const answer = one.trim();
        if (answer === 'одно' || answer === 'код') return answer;
        return answer.split(' | ').map((position) => position.trim());
      });
    cases.push({ title: line.slice(0, at), section, answers });
  }
  return cases;
}

const same = (one: readonly string[], other: readonly string[]): boolean =>
  one.length === other.length && one.every((value, index) => value === other[index]);

type Verdict = 'верно' | 'промах' | 'НЕВЕРНОЕ ДЕЛЕНИЕ' | 'код ошибся';

function judge(one: Case, outcome: 'код' | 'одно' | readonly string[]): Verdict {
  const expectsCode = one.answers.includes('код');
  if (expectsCode !== (outcome === 'код')) return 'код ошибся';
  if (outcome === 'код') return 'верно';
  if (outcome === 'одно') return one.answers.includes('одно') ? 'верно' : 'промах';
  const matched = one.answers.some((answer) => typeof answer !== 'string' && same(answer, outcome));
  return matched ? 'верно' : 'НЕВЕРНОЕ ДЕЛЕНИЕ';
}

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

function argumentAfter(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at < 0 ? undefined : process.argv[at + 1];
}

/** Модель — та же, что на бою (полная или лёгкая), с потолком расхода. */
async function liveSplitter(light: boolean): Promise<{
  readonly name: string;
  readonly ask: (title: string) => Promise<readonly string[] | null>;
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
  const provider = createLlmProvider(env, { light });
  const ai = { db, provider, prompts, logger, spendGuard, retry: { attempts: 2 } };

  const active = await prompts.get('splitter');
  say(
    `Промпт: ${active.version}. Модель: ${provider.name}.` +
      (budgetRub === undefined ? '' : ` Потолок: ${budgetRub.toFixed(2)} ₽.`),
  );

  return {
    name: provider.name,
    ask: async (title) => {
      const outcome = await requestStructured<{ positions: string[] }>(ai, {
        stage: 'splitter',
        input: `Дело: ${title}`,
        maxTokens: 200,
      });
      return outcome.ok ? outcome.value.positions : null;
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
  if (path === undefined) throw new Error('Путь к набору: …/docs/eval-purchases/cases.md');
  const cases = parse(await readFile(path, 'utf8'));

  const replayPath = argumentAfter('--replay');
  const replayed =
    replayPath === undefined
      ? undefined
      : (JSON.parse(await readFile(replayPath, 'utf8')) as { readonly calls: Recorded[] }).calls;
  const light = process.argv.includes('--light');
  const live = process.argv.includes('--model') ? await liveSplitter(light) : undefined;
  const withModel = live !== undefined || replayed !== undefined;
  const onlyText = argumentAfter('--only');
  const only = onlyText === undefined ? undefined : new RegExp(onlyText, 'u');

  const verdicts = new Map<Verdict, number>();
  const calls: Recorded[] = [];
  const bad: string[] = [];
  let stopped: string | undefined;
  let section: string | undefined;
  let judged = 0;

  for (const one of cases) {
    if (only !== undefined && !only.test(one.title)) continue;
    const listed = purchaseList(one.title);
    if (!withModel && listed !== undefined && !one.answers.includes('код')) continue;

    if (one.section !== section) {
      section = one.section;
      say(`\n## ${section}`);
    }

    let outcome: 'код' | 'одно' | readonly string[];
    let shown: string;
    if (listed === undefined) {
      outcome = 'код';
      shown = 'модель не зовётся';
    } else if (!withModel) {
      outcome = 'одно';
      shown = 'кандидат';
    } else {
      let positions = replayed?.find((call) => call.title === one.title)?.positions;
      if (positions === undefined && live !== undefined && stopped === undefined) {
        try {
          positions = await live.ask(one.title);
        } catch (error) {
          stopped = error instanceof Error ? error.message : String(error);
        }
      }
      if (positions === undefined) {
        say(`  «${one.title}» — модель не спрашивали`);
        continue;
      }
      calls.push({ title: one.title, positions });
      const checked =
        positions === null || positions.length === 0
          ? undefined
          : checkedPositions(listed.list, positions);
      outcome = checked ?? 'одно';
      shown =
        positions === null
          ? 'не ответила'
          : `[${positions.join(' | ')}]` +
            (positions.length > 0 && checked === undefined ? ' → проверка: одно' : '');
    }

    const verdict = judge(one, outcome);
    judged += 1;
    verdicts.set(verdict, (verdicts.get(verdict) ?? 0) + 1);
    const mark = verdict === 'верно' ? '✓' : verdict === 'промах' ? '·' : '✗';
    say(`  ${mark} «${one.title}» → ${shown}${verdict === 'верно' ? '' : ` — ${verdict}`}`);
    if (verdict === 'НЕВЕРНОЕ ДЕЛЕНИЕ' || verdict === 'код ошибся') {
      bad.push(`  «${one.title}» → ${shown}`);
    }
  }

  const right = verdicts.get('верно') ?? 0;
  say(
    `\nВсего ${String(judged)}: верно ${String(right)} (${judged === 0 ? '0' : ((right * 100) / judged).toFixed(1)}%)` +
      `, промахов ${String(verdicts.get('промах') ?? 0)}` +
      `, неверных делений ${String(verdicts.get('НЕВЕРНОЕ ДЕЛЕНИЕ') ?? 0)}` +
      `, код ошибся ${String(verdicts.get('код ошибся') ?? 0)}.`,
  );
  if (bad.length > 0) say(`Неверно:\n${bad.join('\n')}`);
  if (stopped !== undefined) say(`Остановлено: ${stopped}`);

  if (live !== undefined) {
    say(await live.finish());
    const runs = join(dirname(path), 'runs');
    await mkdir(runs, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const file = `purchases-${stamp}-${light ? 'lite' : 'pro'}.json`;
    await writeFile(join(runs, file), JSON.stringify({ model: live.name, calls }, null, 2), 'utf8');
    say(`Ответы модели: runs/${file}`);
  }
}

await main();
