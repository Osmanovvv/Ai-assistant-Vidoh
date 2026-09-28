import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Item } from '../db/schema.js';
import { feelingsOnlyReply } from '../modules/presenter/presenter.service.js';
import { moodOf } from '../modules/presenter/mood.js';
import { onlyThanks } from '../modules/presenter/thanks.js';
import { detectByMarkers } from '../modules/safety/crisis.js';
import { asksToRemind, asksWillRemind } from '../modules/scheduler/remind-request.js';
import { checkTalk, onlyAck, talkFacts, type TalkOutcome } from '../modules/talk/talk.js';
import { asksForRest } from '../modules/topics/rest-request.js';
import { defaultTexts } from '../texts/index.js';

/**
 * Замер реплик вне сценария (план docs/29; набор `docs/eval-talk/cases.md`,
 * 28.09.2026).
 *
 * Что бот отвечает сейчас — по коду, бесплатно: кризис по маркерам,
 * «спасибо», «напомнишь?», «какие ещё», чувства по закрытому списку слов.
 * Всё остальное решает маршрутизатор (модель); если он счёл реплику
 * болтовнёй, ответ — «Я здесь. Расскажешь, что в голове?» или, когда
 * модель ответчика нашла что сказать про дела, строка про дела.
 *
 * Режимы:
 * - без флагов — только код, бесплатно;
 * - `--model --budget <₽> [--per-section <n>] [--only <образец>]` — живой ответ моделью
 *   (этап `talker`) на то, что дошло бы до неё на бою; ответы — в `runs/`;
 * - `--replay <runs/talk-….json>` — те же ответы заново через стража,
 *   бесплатно; вместе с `--model` — спрашивается только недостающее.
 */

interface Case {
  readonly say: string;
  readonly kind: string;
  readonly section: string;
}

interface Recorded {
  readonly say: string;
  readonly reply: string;
}

const TO_ROUTER = 'решает модель → одна из заготовок';

const TO_ROUTER_LEGEND =
  '«Решает модель → одна из заготовок»: маршрутизатор счёл болтовнёй — «Я здесь. Расскажешь, что' +
  ' в голове?» или строка про дела от ответчика; счёл чувством — «Поняла тебя. Давай пока просто' +
  ' оставим это здесь 🤍»; счёл делом — запишет делом.';

/** Один и тот же момент у записи и повтора: иначе факты разойдутся. */
const NOW = new Date('2026-09-28T16:00:00.000Z'); // 19:00 МСК, понедельник
const ZONE = 'Europe/Moscow';

/** Её дела на стенде: сегодня с часом, завтра, без срока. */
function standItems(): Item[] {
  const base = {
    userId: 'стенд',
    sourceBatchId: null,
    sourceOrder: null,
    body: null,
    type: 'TASK' as const,
    priority: 'SOON' as const,
    topicId: null,
    status: 'new' as const,
    completedAt: null,
    isProject: false,
    backgroundedAt: null,
    deferredAt: null,
    offeredAt: null,
    reviewedAt: null,
    assignee: null,
    deadlineAt: null,
    deadlineAccuracy: null,
    deadlineTime: null,
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
  const day = (offset: number): Date => new Date(Date.UTC(2026, 8, 28 + offset, -3, 0, 0));
  return [
    {
      ...base,
      id: 's1',
      text: 'Забрать посылку',
      topic: 'дом',
      deadlineAt: day(0),
      deadlineAccuracy: 'day',
      deadlineTime: 20 * 60,
    },
    {
      ...base,
      id: 's2',
      text: 'Позвонить маме',
      topic: 'семья',
      deadlineAt: day(1),
      deadlineAccuracy: 'day',
    },
    { ...base, id: 's3', text: 'Записать Мишу к стоматологу', topic: 'здоровье' },
  ];
}

function factsOf(said: string): string {
  return talkFacts({
    said,
    now: NOW,
    timeZone: ZONE,
    texts: defaultTexts,
    overview: standItems(),
    mood: moodOf(said),
  });
}

function parse(text: string): Case[] {
  const cases: Case[] = [];
  let section: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) section = line.slice(3);
    if (section === undefined) continue;
    const at = line.indexOf(' => ');
    if (at < 0) continue;
    const [kind = ''] = line.slice(at + 4).split('|');
    cases.push({ say: line.slice(0, at), kind: kind.trim(), section });
  }
  return cases;
}

/** Что бот ответит сейчас, если решает код; иначе — путь через модель. */
function nowReply(say: string): { readonly reply: string; readonly byCode: boolean } {
  const texts = defaultTexts;
  if (detectByMarkers(say).detected) return { reply: 'кризисный ответ (код)', byCode: true };
  if (onlyThanks(say)) return { reply: texts.answer.thanks, byCode: true };
  if (asksToRemind(say) || asksWillRemind(say)) {
    return { reply: 'ответ про напоминание (код)', byCode: true };
  }
  if (asksForRest(say)) return { reply: 'остальные дела ветки (код)', byCode: true };
  const mood = moodOf(say);
  if (mood !== undefined) return { reply: feelingsOnlyReply(texts, mood), byCode: true };
  return { reply: TO_ROUTER, byCode: false };
}

/**
 * Дойдёт ли реплика до модели живого ответа на бою: кризис, «спасибо»,
 * «напомнишь?», «какие ещё» и «ок» отвечает код.
 */
function reachesTalker(one: Case): boolean {
  if (one.kind.startsWith('код:')) return false;
  const now = nowReply(one.say);
  if (now.byCode && moodOf(one.say) === undefined) return false;
  return !onlyAck(one.say);
}

/** По `n` из каждого раздела, равномерно: замер дешевле, разнообразие то же. */
function sampled(cases: readonly Case[], perSection: number | undefined): Case[] {
  if (perSection === undefined) return [...cases];
  const bySection = new Map<string, Case[]>();
  for (const one of cases) bySection.set(one.section, [...(bySection.get(one.section) ?? []), one]);
  return [...bySection.values()].flatMap((list) => {
    if (list.length <= perSection) return list;
    const step = (list.length - 1) / Math.max(1, perSection - 1);
    return Array.from({ length: perSection }, (_, index) => list[Math.round(index * step)]).filter(
      (one): one is Case => one !== undefined,
    );
  });
}

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

function argumentAfter(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at < 0 ? undefined : process.argv[at + 1];
}

/** Живой ответ — той же моделью, что на бою, с потолком расхода. */
async function liveTalker(): Promise<{
  ask: (said: string) => Promise<TalkOutcome>;
  finish: () => Promise<string>;
}> {
  const { modelEnvSchema } = await import('../config/env.js');
  const { parseBudget, withRunBudget } = await import('../eval/budget.js');
  const { closeDb, getDb } = await import('../infra/db.js');
  const { createLogger } = await import('../infra/logger.js');
  const { PromptRegistry } = await import('../modules/ai/prompts/registry.js');
  const { createLlmProvider } = await import('../modules/ai/providers/factory.js');
  const { askTalk } = await import('../modules/talk/talk.js');
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

  const active = await prompts.get('talker');
  say(
    `Промпт: ${active.version}. Модель: ${provider.name}.` +
      (budgetRub === undefined ? '' : ` Потолок: ${budgetRub.toFixed(2)} ₽.`),
  );

  return {
    ask: async (said) => await askTalk(ai, { facts: factsOf(said), mood: moodOf(said) }),
    finish: async () => {
      const cost = await runCost(db, { startedAt, now: new Date() });
      await closeDb();
      return `${costLine(cost, ceilings)} Промпт ${active.version}.`;
    },
  };
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (path === undefined) throw new Error('Путь к набору: …/docs/eval-talk/cases.md');
  const cases = parse(await readFile(path, 'utf8'));

  const replayPath = argumentAfter('--replay');
  const replayed =
    replayPath === undefined
      ? undefined
      : (JSON.parse(await readFile(replayPath, 'utf8')) as { readonly calls: Recorded[] }).calls;
  const perSectionText = argumentAfter('--per-section');
  const perSection = perSectionText === undefined ? undefined : Number(perSectionText);
  // `--model` вместе с `--replay` — записанное не спрашивается второй раз:
  // платится только недостающее.
  const live = process.argv.includes('--model') ? await liveTalker() : undefined;
  const withModel = live !== undefined || replayed !== undefined;
  // `--only <образец>` — проба на нескольких репликах, цена известна заранее.
  const onlyText = argumentAfter('--only');
  const only = onlyText === undefined ? undefined : new RegExp(onlyText, 'u');
  const asked = new Set(
    sampled(cases.filter(reachesTalker), perSection)
      .filter((one) => only === undefined || only.test(one.say))
      .map((one) => one.say),
  );

  const byReply = new Map<string, number>();
  const misses: string[] = [];
  const calls: Recorded[] = [];
  const verdicts = new Map<string, number>();
  let stopped: string | undefined;
  let section: string | undefined;
  for (const one of cases) {
    const now = nowReply(one.say);
    if (withModel && !asked.has(one.say)) continue;
    if (one.section !== section) {
      section = one.section;
      say(`\n## ${section}`);
    }
    say(`  «${one.say}» [${one.kind}] → ${now.reply}`);
    byReply.set(now.reply, (byReply.get(now.reply) ?? 0) + 1);

    // Код обязан остаться кодом: модель туда не зовётся.
    if (one.kind === 'код: спасибо' && now.reply !== defaultTexts.answer.thanks) {
      misses.push(`  «${one.say}» — ждали «спасибо» кодом, вышло: ${now.reply}`);
    }
    if (one.kind === 'код: кризис' && now.reply !== 'кризисный ответ (код)') {
      misses.push(`  «${one.say}» — ждали кризис по маркерам, вышло: ${now.reply}`);
    }

    if (!withModel) continue;
    let reply = replayed?.find((call) => call.say === one.say)?.reply;
    if (reply === undefined && live !== undefined && stopped === undefined) {
      try {
        const outcome = await live.ask(one.say);
        reply = outcome.line ?? outcome.rejected ?? '';
      } catch (error) {
        stopped = error instanceof Error ? error.message : String(error);
      }
    }
    if (reply !== undefined) calls.push({ say: one.say, reply });
    if (reply === undefined) {
      say('    модель: не спрашивали');
      continue;
    }
    const checked = checkTalk(reply, factsOf(one.say), { mood: moodOf(one.say) });
    const verdict = checked.ok ? 'прошёл' : checked.why === 'пусто' ? 'пусто' : 'отвергнут';
    verdicts.set(verdict, (verdicts.get(verdict) ?? 0) + 1);
    say(
      `    модель: «${reply}» → ${checked.ok ? '✓' : `✗ ${checked.why}`}` +
        (checked.ok ? '' : ` → бот скажет: ${now.reply}`),
    );
  }

  if (withModel) {
    say(`\nДо модели дошло ${String(asked.size)} реплик.`);
    for (const [verdict, count] of verdicts) say(`  ${verdict}: ${String(count)}`);
  } else {
    say(`\nВсего ${String(cases.length)} реплик. Что бот отвечает сейчас:`);
    for (const [reply, count] of [...byReply].sort((a, b) => b[1] - a[1])) {
      say(`  ${String(count).padStart(3)} × ${reply}`);
    }
    say(TO_ROUTER_LEGEND);
    say(`До модели живого ответа дошло бы: ${String(cases.filter(reachesTalker).length)}.`);
  }
  if (misses.length > 0) say(`Код не узнал:\n${misses.join('\n')}`);
  if (stopped !== undefined) say(`Остановлено: ${stopped}`);

  if (live !== undefined) {
    say(await live.finish());
    const runs = join(dirname(path), 'runs');
    await mkdir(runs, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    await writeFile(join(runs, `talk-${stamp}.json`), JSON.stringify({ calls }, null, 2), 'utf8');
    say(`Ответы модели: runs/talk-${stamp}.json`);
  }
}

await main();
