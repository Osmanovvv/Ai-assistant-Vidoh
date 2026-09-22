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
import type { Item, ProjectStep } from '../db/schema.js';
import { defaultTexts } from '../texts/index.js';
import { askLiveAnswer, checkLiveAnswer, questionFacts } from '../modules/backlog/live-answer.js';
import type { BacklogAnswer } from '../modules/backlog/query.service.js';
import type { ProjectContext } from '../modules/projects/projects.service.js';
import { ceilingFromEnv } from '../modules/metering/account-spend.js';
import { costLine, runCost } from '../modules/metering/run-cost.js';
import { createSpendGuard } from '../modules/metering/spend-guard.js';

/**
 * Стенд живого ответа на вопрос (слой B, 22.09.2026).
 *
 * Каждый случай — вопрос и то, что нашёл бы код: найденные записи,
 * шаги большой цели или обзор открытых дел. Стенд спрашивает модель тем
 * же путём, что и бой (`questionFacts` → `askLiveAnswer`), печатает
 * ответ, вердикт стража и цену. Тон судит человек по её тексту о
 * характере; ошибки факта ловит страж.
 *
 * Деньги: ≈1,6–2 ₽ на случай. Потолок обязателен.
 *
 * Запуск:
 *   AI_PROVIDER=yandex DATABASE_URL=… npx tsx src/scripts/check-answers.ts ../../docs/eval-answers --budget 30
 *   … --only answers-03,answers-07   … --use answerer=answerer@2
 */

/** Запись случая — короче боевой: время относительно «сейчас» стенда. */
interface CaseItem {
  readonly text: string;
  readonly topic?: string | undefined;
  readonly type?: 'TASK' | 'DESIRE' | 'IDEA' | 'INFO' | undefined;
  /** Срок: дней от «сейчас» (0 — сегодня, -6 — шесть дней назад). */
  readonly dueDays?: number | undefined;
  readonly accuracy?: 'day' | 'week' | 'month' | undefined;
  readonly time?: string | undefined;
  readonly status?: 'new' | 'done' | 'cancelled' | undefined;
  readonly deferred?: boolean | undefined;
  readonly assignee?: string | undefined;
  readonly isProject?: boolean | undefined;
}

interface VoiceCase {
  readonly id: string;
  readonly note?: string | undefined;
  readonly expectEmpty?: boolean | undefined;
  readonly question: string;
  readonly kind: 'about' | 'aboutClosed' | 'project' | 'nothing';
  readonly items?: readonly CaseItem[] | undefined;
  readonly project?:
    { readonly done: readonly string[]; readonly remaining: readonly string[] } | undefined;
  readonly overview?: readonly CaseItem[] | undefined;
}

/** «Сейчас» стенда — вторник 22.09.2026, 12:00 МСК: числа в ответах сверяемы. */
const NOW = new Date('2026-09-22T09:00:00.000Z');
const MOSCOW = 'Europe/Moscow';

let seq = 0;
function toItem(one: CaseItem): Item {
  seq += 1;
  const day =
    one.dueDays === undefined ? null : new Date(Date.UTC(2026, 8, 22 + one.dueDays, -3, 0, 0));
  const [hours, minutes] = (one.time ?? '').split(':').map(Number);
  return {
    id: `case-${String(seq)}`,
    userId: 'stand',
    sourceBatchId: null,
    sourceOrder: null,
    text: one.text,
    body: null,
    type: one.type ?? 'TASK',
    priority: 'SOON',
    topicId: null,
    topic: one.topic ?? 'личное',
    status: one.status ?? 'new',
    completedAt: one.status === 'done' ? NOW : null,
    isProject: one.isProject ?? false,
    backgroundedAt: null,
    deferredAt: one.deferred === true ? NOW : null,
    offeredAt: null,
    reviewedAt: null,
    assignee: one.assignee ?? null,
    deadlineAt: day,
    deadlineAccuracy: day === null ? null : (one.accuracy ?? 'day'),
    deadlineTime:
      one.time === undefined || hours === undefined || minutes === undefined
        ? null
        : hours * 60 + minutes,
    lineMentionedAt: null,
    embedding: null,
    recurrenceRule: null,
    recurrenceText: null,
    recurrenceSource: null,
    isDraft: false,
    draftReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function step(text: string, done = false): ProjectStep {
  seq += 1;
  return {
    id: `step-${String(seq)}`,
    itemId: 'case-project',
    userId: 'stand',
    text,
    position: seq,
    doneAt: done ? NOW : null,
    createdAt: NOW,
  };
}

function factsOf(one: VoiceCase): string {
  const items = (one.items ?? []).map(toItem);
  const answer: BacklogAnswer =
    one.kind === 'project'
      ? { kind: 'project', item: items[0] ?? toItem({ text: one.question, isProject: true }) }
      : one.kind === 'nothing'
        ? { kind: 'nothing' }
        : { kind: one.kind, items };
  const project: ProjectContext | undefined =
    one.project === undefined
      ? undefined
      : (() => {
          const done = one.project.done.map((text) => step(text, true));
          const remaining = one.project.remaining.map((text) => step(text));
          return { steps: [...done, ...remaining], done, remaining, next: remaining[0] };
        })();
  return questionFacts({
    question: one.question,
    now: NOW,
    timeZone: MOSCOW,
    texts: defaultTexts,
    answer,
    project,
    overview: one.overview?.map(toItem),
  });
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

const active = await prompts.get('answerer');
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
    const asked = await askLiveAnswer(ai, { facts: factsOf(one) });
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
        : `✗ отвергнута: ${outcome.why ?? '?'}` +
          (outcome.rejected === undefined ? '' : ` — «${outcome.rejected}»`);
  const mark = outcome.expectEmpty && outcome.line !== undefined ? '  ← ждали пусто' : '';
  process.stdout.write(
    `${one.id}${one.note === undefined ? '' : ` — ${one.note}`}\n  ${verdict}${mark}\n`,
  );
}

const passed = outcomes.filter((one) => one.line !== undefined).length;
const empty = outcomes.filter((one) => one.why === 'пусто').length;
const rejected = outcomes.filter((one) => one.line === undefined && one.why !== 'пусто');
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
const caseById = new Map(cases.map((one) => [one.id, one]));
for (const one of outcomes) {
  const found = caseById.get(one.id);
  if (one.line === undefined || found === undefined) continue;
  if (!checkLiveAnswer(one.line, factsOf(found)).ok) {
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
