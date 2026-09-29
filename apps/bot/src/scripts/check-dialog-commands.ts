import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { onlyGreeting } from '../modules/presenter/greeting.js';
import { onlyThanks } from '../modules/presenter/thanks.js';
import { onlyAck } from '../modules/talk/talk.js';
import { onlyDoneWords, patchesKnownItem } from '../modules/router/known-patch.js';
import { asksToRemind, asksWillRemind } from '../modules/scheduler/remind-request.js';

/**
 * Замер реплик без вопроса бота (план docs/28, шаг 6, часть B; набор
 * `docs/eval-dialog/commands.md`, 28.09.2026).
 *
 * Как на бою: сперва быстрые списки кода («спасибо», «напомнишь?»), всё
 * остальное решает маршрутизатор (этап `router`, модель маршрутизатора).
 * Итог — «верно», «не понял» (намерений несколько, ждали одно) или «не
 * так» (намерение не то: «удали это» стало новой мыслью).
 *
 * Режимы:
 * - без флагов — только код, бесплатно;
 * - `--model --budget <₽>` — живой маршрутизатор, ответы в `runs/`;
 * - `--replay <runs/….json>` — те же ответы заново, бесплатно.
 */

interface Case {
  readonly say: string;
  readonly expect: string;
  readonly live: boolean;
}

type Verdict = 'верно' | 'не понял' | 'не так';

interface Recorded {
  readonly say: string;
  readonly intents?: readonly string[] | undefined;
  readonly problem?: string | undefined;
}

/** Открытые дела человека из шапки раздела: «дела: A; B; C». */
function openTitlesOf(text: string): readonly string[] {
  const line = text.split('\n').find((one) => one.startsWith('дела: '));
  return line === undefined
    ? []
    : line
        .slice('дела: '.length)
        .split(';')
        .map((one) => one.trim());
}

/**
 * Код после маршрутизатора, как на бою: «готово» одной репликой — сделано
 * (`routeIntents`), мысль без глагола про записанное дело со сроком —
 * правка (`dump.handler`). У ответов, записанных до правил, — тоже.
 */
function afterRouter(
  say: string,
  intents: readonly string[],
  open: readonly string[],
): readonly string[] {
  if (intents.length !== 1) return intents;
  const [only] = intents;
  if ((only === 'SMALLTALK' || only === 'DUMP') && onlyDoneWords(say)) return ['COMPLETE'];
  if (only === 'DUMP' && patchesKnownItem(say, open)) return ['PATCH'];
  return intents;
}

function parse(text: string): Case[] {
  const cases: Case[] = [];
  // Фразы — только внутри разделов («## …»): шапка описывает формат.
  let inSection = false;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) inSection = true;
    if (!inSection) continue;
    const at = line.indexOf(' => ');
    if (at < 0 || line.startsWith('-') || line.startsWith('`')) continue;
    const [expect = '', source = ''] = line.slice(at + 4).split(' | ');
    cases.push({ say: line.slice(0, at), expect: expect.trim(), live: source.includes('живое') });
  }
  return cases;
}

/** Что решил бы код до маршрутизатора. */
function codeReads(say: string): string {
  if (onlyThanks(say)) return 'спасибо';
  // Приветствие и «ок» — ответ сразу в приёме, без маршрутизатора (29.09.2026).
  if (onlyGreeting(say) || onlyAck(say)) return 'SMALLTALK';
  if (asksToRemind(say) || asksWillRemind(say)) return 'напомнить';
  return 'маршрутизатор';
}

function judge(expect: string, got: string, intents: readonly string[] | undefined): Verdict {
  if (got !== 'маршрутизатор') return got === expect ? 'верно' : 'не так';
  if (intents === undefined) return 'не понял';

  // «Спасибо» мимо списка — болтовня: ответ тёплый, вреда нет.
  const wanted = expect === 'спасибо' ? 'SMALLTALK' : expect;
  if (intents.length === 1 && intents[0] === wanted) return 'верно';
  if (intents.includes(wanted)) return 'не понял';
  // «Напомнишь?» вопросом — ответ о записях, а не план: не то, но и не вред.
  if (expect === 'напомнить' && intents.every((one) => one === 'QUERY')) return 'не понял';
  return 'не так';
}

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

function argumentAfter(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at < 0 ? undefined : process.argv[at + 1];
}

/** Живой маршрутизатор — той же моделью, что на бою, с потолком расхода. */
async function liveRouter(): Promise<{
  ask: (text: string) => Promise<readonly string[] | string>;
  finish: () => Promise<string>;
}> {
  const { modelEnvSchema } = await import('../config/env.js');
  const { parseBudget, withRunBudget } = await import('../eval/budget.js');
  const { closeDb, getDb } = await import('../infra/db.js');
  const { createLogger } = await import('../infra/logger.js');
  const { PromptRegistry } = await import('../modules/ai/prompts/registry.js');
  const { createLlmProvider } = await import('../modules/ai/providers/factory.js');
  const { routeIntents } = await import('../modules/router/router.service.js');
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
  // Как на бою: у маршрутизатора своя модель (`YANDEX_LLM_MODEL_ROUTER`).
  const provider = createLlmProvider(env, { router: true });
  const ai = { db, provider, prompts, logger, spendGuard, retry: { attempts: 2 } };

  const active = await prompts.get('router');
  say(
    `Промпт: ${active.version}. Модель: ${provider.name}.` +
      (budgetRub === undefined ? '' : ` Потолок: ${budgetRub.toFixed(2)} ₽.`),
  );

  return {
    ask: async (text) => {
      const routed = await routeIntents(ai, { input: text });
      return routed.fallback
        ? 'маршрутизатор не ответил'
        : routed.segments.map((one) => one.intent);
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
  if (path === undefined) throw new Error('Путь к набору: …/docs/eval-dialog/commands.md');
  const source = await readFile(path, 'utf8');
  const cases = parse(source);
  const open = openTitlesOf(source);

  const replayPath = argumentAfter('--replay');
  const replayed =
    replayPath === undefined
      ? undefined
      : (JSON.parse(await readFile(replayPath, 'utf8')) as { readonly calls: Recorded[] }).calls;
  const live =
    replayed === undefined && process.argv.includes('--model') ? await liveRouter() : undefined;

  const total: Record<Verdict, number> = { верно: 0, 'не понял': 0, 'не так': 0 };
  const calls: Recorded[] = [];
  const liveReplies = { all: 0, right: 0 };
  const wrong: string[] = [];
  const missed: string[] = [];
  let unasked = 0;
  let stopped: string | undefined;

  for (const one of cases) {
    const got = codeReads(one.say);
    let recorded: Recorded | undefined;
    if (got === 'маршрутизатор') {
      recorded = replayed?.find((call) => call.say === one.say);
      if (recorded === undefined && live !== undefined && stopped === undefined) {
        try {
          const answer = await live.ask(one.say);
          recorded =
            typeof answer === 'string'
              ? { say: one.say, problem: answer }
              : { say: one.say, intents: answer };
        } catch (error) {
          stopped = error instanceof Error ? error.message : String(error);
        }
      }
      if (recorded === undefined) unasked++;
      else calls.push(recorded);
    }

    const intents =
      recorded?.intents === undefined ? undefined : afterRouter(one.say, recorded.intents, open);
    const verdict = judge(one.expect, got, intents);
    total[verdict]++;
    if (one.live) {
      liveReplies.all++;
      if (verdict === 'верно') liveReplies.right++;
    }
    const shown =
      got === 'маршрутизатор'
        ? `маршрутизатор: ${intents?.join(' + ') ?? recorded?.problem ?? 'не спрашивали'}`
        : `код: ${got}`;
    if (verdict === 'не так') wrong.push(`  «${one.say}» → ${shown}; надо: ${one.expect}`);
    if (verdict === 'не понял') missed.push(`  «${one.say}» → ${shown}; надо: ${one.expect}`);
  }

  const all = cases.length;
  say(
    `\nВсего ${String(all)} фраз: верно ${String(total.верно)} (${String(Math.round((total.верно / all) * 100))}%), не понял ${String(total['не понял'])}, не так ${String(total['не так'])}`,
  );
  if (wrong.length > 0) say(`Не так:\n${wrong.join('\n')}`);
  if (process.argv.includes('--missed') && missed.length > 0)
    say(`Не понял:\n${missed.join('\n')}`);
  say(`Живые реплики: верно ${String(liveReplies.right)} из ${String(liveReplies.all)}`);
  say(`До маршрутизатора: ${String(calls.length + unasked)}, без его ответа: ${String(unasked)}`);
  if (stopped !== undefined) say(`Остановлено: ${stopped}`);

  if (live !== undefined) {
    say(await live.finish());
    const runs = join(dirname(path), 'runs');
    await mkdir(runs, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    await writeFile(
      join(runs, `commands-${stamp}.json`),
      JSON.stringify({ calls }, null, 2),
      'utf8',
    );
    say(`Ответы маршрутизатора: runs/commands-${stamp}.json`);
  }
}

await main();
