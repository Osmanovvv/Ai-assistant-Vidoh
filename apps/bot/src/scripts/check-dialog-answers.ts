import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ReaderReading } from '../modules/ai/schemas/index.js';
import { clockTimesIn } from '../modules/classifier/clock-time.js';
import { answerRemainder, readAnswer } from '../modules/resolver/answer.js';
import {
  checkReading,
  readerInput,
  type ReaderQuestion,
  type ReplyMeaning,
} from '../modules/resolver/answer-reader.js';
import { clarifiedCommand } from '../modules/resolver/clarify.js';
import { defaultTexts } from '../texts/index.js';

/**
 * Замер ответов на вопросы бота (шаги 2 и 4 плана docs/28, 28.09.2026) по
 * набору `docs/eval-dialog/cases.md`.
 *
 * Итог по каждой фразе — «верно», «не понял» или «не так». «Не так» —
 * худшее: бот сделал бы не то, что сказано (выбрал не тот час, принял
 * новую мысль за ответ, потерял её). «Не понял» — реплика ушла бы обычным
 * разбором, а вопрос остался без ответа.
 *
 * Три режима — как на бою: сначала код, модель — только где код не понял.
 *
 * - без флагов — только код, бесплатно, ни базы, ни модели;
 * - `--model --budget <₽> [--limit N]` — живая модель (этап `reader`),
 *   ответы пишутся в `runs/<время>.json`;
 * - `--replay <runs/….json>` — те же ответы модели заново через проверки
 *   кода, бесплатно: правка проверок меряется без новых вызовов;
 * - `--model … --resume <runs/….json>` — оплаченные ответы берутся из
 *   файла, модель спрашивается только о недостающих.
 *
 * Запуск:
 *   npx tsx src/scripts/check-dialog-answers.ts ../../docs/eval-dialog/cases.md
 *   AI_PROVIDER=yandex DATABASE_URL=… npx tsx src/scripts/check-dialog-answers.ts … --model --budget 110
 *   npx tsx src/scripts/check-dialog-answers.ts … --replay ../../docs/eval-dialog/runs/….json
 */

type Kind = 'time' | 'which' | 'move' | 'attach';

interface Section {
  readonly title: string;
  readonly kind: Kind;
  readonly command: string;
  readonly subject: string;
  readonly cases: { readonly say: string; readonly expect: string; readonly live: boolean }[];
}

type Verdict = 'верно' | 'не понял' | 'не так';

const KINDS: readonly Kind[] = ['time', 'which', 'move', 'attach'];

function parse(text: string): Section[] {
  const sections: Section[] = [];
  let current:
    | {
        title: string;
        kind?: Kind;
        command: string;
        subject: string;
        cases: Section['cases'][number][];
      }
    | undefined;

  const flush = (): void => {
    if (current?.kind !== undefined) {
      sections.push({
        title: current.title,
        kind: current.kind,
        command: current.command,
        subject: current.subject,
        cases: current.cases,
      });
    }
  };

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) {
      flush();
      current = { title: line.slice(3), command: '', subject: '', cases: [] };
      continue;
    }
    if (current === undefined) continue;

    const header = /^(вид|команда|вопрос): (.+)$/u.exec(line);
    if (header !== null) {
      const value = header[2] ?? '';
      if (header[1] === 'вид') {
        const kind = KINDS.find((one) => one === value);
        if (kind === undefined) throw new Error(`Неизвестный вид «${value}» в «${current.title}»`);
        current.kind = kind;
      } else if (header[1] === 'команда') {
        current.command = value;
      } else {
        // Название дела из вопроса с кнопками: «Перенести «X»?».
        current.subject = /«(.+)»/u.exec(value)?.[1] ?? '';
      }
      continue;
    }

    const at = line.indexOf(' => ');
    if (at < 0 || line.startsWith('`')) continue;
    const say = line.slice(0, at);
    const [expect = '', source = ''] = line.slice(at + 4).split(' | ');
    current.cases.push({ say, expect: expect.trim(), live: source.includes('живое') });
  }
  flush();
  return sections;
}

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Что понял бы код: то же слово, что в наборе, или «нет ответа». */
function codeReads(section: Section, say: string): string {
  if (section.kind === 'time') {
    const done = clarifiedCommand('time', section.command, say);
    if (done === undefined) return 'нет ответа';
    const readings = clockTimesIn(done);
    const only = readings.length === 1 && readings[0]?.length === 1 ? readings[0][0] : undefined;
    return only === undefined ? 'двояко' : clock(only);
  }
  if (section.kind === 'which') {
    return clarifiedCommand('which', section.command, say) === undefined ? 'нет ответа' : 'дело';
  }

  const reading = readAnswer(say, { move: section.kind === 'move' });
  if (reading === 'content') return 'мысль';
  if (reading === 'unclear') return 'нет ответа';
  if (section.kind === 'move') return reading === 'attach' ? 'да' : 'нет';
  return reading === 'attach' ? 'к прошлой' : 'отдельно';
}

const NOT_ANSWERS = ['не ответ', 'встречный вопрос', 'не решил', 'переспросить'];

function judgeCode(section: Section, say: string, expect: string, got: string): Verdict {
  const answer = expect.split(' + мысль')[0]?.trim() ?? '';
  const withThought = expect.includes('+ мысль');

  if (NOT_ANSWERS.includes(answer)) {
    if (answer === 'не ответ') {
      return got === 'нет ответа' || got === 'мысль' ? 'верно' : 'не так';
    }
    // Встречный вопрос, «не знаю», двоякое: код их не различает. Главное —
    // не принять за ответ; не принял — «не понял», принял — «не так».
    if (got === 'нет ответа' || got === 'мысль' || got === 'двояко') {
      return answer === 'не решил' &&
        section.kind !== 'time' &&
        section.kind !== 'which' &&
        got === 'нет ответа'
        ? 'верно'
        : 'не понял';
    }
    return 'не так';
  }

  if (got === 'нет ответа' || got === 'мысль' || got === 'двояко') return 'не понял';
  // Ответ с мыслью: у вопроса с кнопками слова сверх ответа уходят в
  // черновик (`pending.ts`) — не потеряны, но и не разобраны; у переспроса
  // ответом целиком мысль пропала бы.
  if (withThought) {
    const kept =
      (section.kind === 'move' || section.kind === 'attach') && answerRemainder(say) !== '';
    return kept && got === answer ? 'не понял' : 'не так';
  }
  if (section.kind === 'which') return 'верно';
  return got === answer ? 'верно' : 'не так';
}

/** Код не понял — дойдёт ли фраза до модели на бою. */
function reachesModel(got: string): boolean {
  return got === 'нет ответа' || got === 'мысль' || got === 'двояко';
}

function questionOf(section: Section): ReaderQuestion {
  if (section.kind === 'move' || section.kind === 'attach') {
    return { kind: section.kind, title: section.subject };
  }
  return { kind: section.kind, command: section.command };
}

/** Прочитанное моделью и проверенное кодом — словом набора. */
function meaningWord(meaning: ReplyMeaning): string {
  switch (meaning.kind) {
    case 'answer':
      return meaning.thought === ''
        ? meaning.choice
        : `${meaning.choice} + мысль «${meaning.thought}»`;
    case 'counter_question':
      return 'встречный вопрос';
    case 'undecided':
      return 'не решил';
    case 'ambiguous':
      return 'переспросить';
    case 'not_answer':
      return 'нет ответа';
    case 'unread':
      return `не прочитано: ${meaning.why}`;
  }
}

function judgeModel(section: Section, expect: string, meaning: ReplyMeaning): Verdict {
  const answer = expect.split(' + мысль')[0]?.trim() ?? '';
  const withThought = expect.includes('+ мысль');
  const silent = meaning.kind === 'not_answer' || meaning.kind === 'unread';

  if (answer === 'не ответ') {
    // Встречный, «не решил», «двояко» на новой мысли — реплика не
    // разбирается: мысль пропала бы.
    return silent ? 'верно' : 'не так';
  }
  if (answer === 'встречный вопрос' || answer === 'не решил' || answer === 'переспросить') {
    if (meaning.kind === 'answer') return 'не так';
    const right =
      answer === 'встречный вопрос'
        ? meaning.kind === 'counter_question'
        : answer === 'не решил'
          ? meaning.kind === 'undecided'
          : meaning.kind === 'ambiguous' || meaning.kind === 'counter_question';
    // «Не решил» на встречном вопросе — «оставлю как есть» вместо
    // объяснения; остальное — переспрос или обычный разбор.
    if (right) return 'верно';
    return meaning.kind === 'undecided' ? 'не так' : 'не понял';
  }

  // Ждали ответ.
  if (silent || meaning.kind === 'counter_question' || meaning.kind === 'ambiguous') {
    return 'не понял';
  }
  if (meaning.kind === 'undecided') return 'не так';
  if (meaning.thought !== '' && !withThought) return 'не так';
  if (meaning.thought === '' && withThought) return 'не так';
  if (section.kind === 'which') return 'верно';
  return meaning.choice === answer ? 'верно' : 'не так';
}

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

interface Recorded {
  readonly section: string;
  readonly say: string;
  readonly reading?: ReaderReading | undefined;
  readonly problem?: string | undefined;
}

function argumentAfter(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at < 0 ? undefined : process.argv[at + 1];
}

type Ask = (question: ReaderQuestion, reply: string) => Promise<Recorded['reading'] | string>;

/** Живая модель: этап `reader`, как на бою, с потолком расхода. */
async function liveModel(): Promise<{ ask: Ask; finish: () => Promise<string> }> {
  const { modelEnvSchema } = await import('../config/env.js');
  const { parseBudget, withRunBudget } = await import('../eval/budget.js');
  const { closeDb, getDb } = await import('../infra/db.js');
  const { createLogger } = await import('../infra/logger.js');
  const { PromptRegistry } = await import('../modules/ai/prompts/registry.js');
  const { createLlmProvider } = await import('../modules/ai/providers/factory.js');
  const { requestStructured } = await import('../modules/ai/client.js');
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

  const active = await prompts.get('reader');
  say(
    `Промпт: ${active.version} (${active.schemaName}). Модель: ${provider.name}.` +
      (budgetRub === undefined ? '' : ` Потолок: ${budgetRub.toFixed(2)} ₽.`),
  );

  return {
    ask: async (question, reply) => {
      const outcome = await requestStructured<ReaderReading>(ai, {
        stage: 'reader',
        input: readerInput(question, defaultTexts, reply),
        maxTokens: 200,
      });
      return outcome.ok ? outcome.value : outcome.problem;
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
  if (path === undefined) throw new Error('Путь к набору: …/docs/eval-dialog/cases.md');
  const sections = parse(await readFile(path, 'utf8'));

  const replayPath = argumentAfter('--replay');
  const replayed =
    replayPath === undefined
      ? undefined
      : (JSON.parse(await readFile(replayPath, 'utf8')) as { readonly calls: Recorded[] }).calls;
  const live =
    replayed === undefined && process.argv.includes('--model') ? await liveModel() : undefined;
  const limit = Number(argumentAfter('--limit') ?? Infinity);
  const resumePath = argumentAfter('--resume');
  const resumed =
    resumePath === undefined
      ? []
      : (JSON.parse(await readFile(resumePath, 'utf8')) as { readonly calls: Recorded[] }).calls;
  let paid = 0;
  // Дошли бы до модели на бою, а её ответа нет (потолок, `--limit`).
  const unasked: string[] = [];
  const withModel = replayed !== undefined || live !== undefined;

  const total: Record<Verdict, number> = { верно: 0, 'не понял': 0, 'не так': 0 };
  const liveReplies = { all: 0, right: 0 };
  const calls: Recorded[] = [];
  let stopped: string | undefined;

  for (const section of sections) {
    const counts: Record<Verdict, number> = { верно: 0, 'не понял': 0, 'не так': 0 };
    const wrong: string[] = [];
    const missed: string[] = [];
    for (const one of section.cases) {
      const got = codeReads(section, one.say);
      let verdict = judgeCode(section, one.say, one.expect, got);
      let shown = `код: ${got}`;

      if (withModel && reachesModel(got) && stopped === undefined) {
        let recorded: Recorded | undefined;
        if (replayed !== undefined) {
          recorded = replayed.find(
            (call) => call.section === section.title && call.say === one.say,
          );
        } else if (live !== undefined) {
          recorded = resumed.find(
            (call) =>
              call.section === section.title && call.say === one.say && call.reading !== undefined,
          );
        }
        // Потолок числа новых вызовов (`--limit`): дальше — как код.
        if (recorded === undefined && live !== undefined && paid < limit) {
          paid++;
          try {
            const answer = await live.ask(questionOf(section), one.say);
            recorded =
              typeof answer === 'string'
                ? { section: section.title, say: one.say, problem: answer }
                : { section: section.title, say: one.say, reading: answer };
          } catch (error) {
            stopped = error instanceof Error ? error.message : String(error);
          }
        }
        if (recorded === undefined) unasked.push(`${section.title.slice(0, 2)} «${one.say}»`);
        if (recorded !== undefined) {
          calls.push(recorded);
          const meaning: ReplyMeaning =
            recorded.reading === undefined
              ? { kind: 'unread', why: recorded.problem ?? 'нет ответа модели' }
              : checkReading(questionOf(section), one.say, recorded.reading);
          verdict = judgeModel(section, one.expect, meaning);
          shown = `модель: ${meaningWord(meaning)}`;
        }
      }

      counts[verdict]++;
      total[verdict]++;
      if (one.live) {
        liveReplies.all++;
        if (verdict === 'верно') liveReplies.right++;
      }
      if (verdict === 'не так') wrong.push(`  «${one.say}» → ${shown}; надо: ${one.expect}`);
      if (verdict === 'не понял') missed.push(`  «${one.say}» → ${shown}; надо: ${one.expect}`);
    }
    say(
      `\n${section.title}: ${String(section.cases.length)} фраз — верно ${String(counts.верно)}, не понял ${String(counts['не понял'])}, не так ${String(counts['не так'])}`,
    );
    if (wrong.length > 0) say(`Не так:\n${wrong.join('\n')}`);
    if (process.argv.includes('--missed') && missed.length > 0) {
      say(`Не понял:\n${missed.join('\n')}`);
    }
  }

  const all = total.верно + total['не понял'] + total['не так'];
  say(
    `\nВсего ${String(all)} фраз: верно ${String(total.верно)} (${String(Math.round((total.верно / all) * 100))}%), не понял ${String(total['не понял'])}, не так ${String(total['не так'])}`,
  );
  say(`Живые реплики: верно ${String(liveReplies.right)} из ${String(liveReplies.all)}`);
  if (withModel) {
    say(
      `Ответов модели: ${String(calls.length)}${live === undefined ? '' : `, из них новых вызовов ${String(paid)}`}`,
    );
  }
  if (withModel && unasked.length > 0) {
    say(`Без ответа модели (судил код): ${String(unasked.length)}`);
    if (process.argv.includes('--missed')) say(unasked.map((one) => `  ${one}`).join('\n'));
  }
  if (stopped !== undefined) say(`Остановлено: ${stopped}`);

  if (live !== undefined) {
    say(await live.finish());
    const runs = join(dirname(path), 'runs');
    await mkdir(runs, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    await writeFile(join(runs, `${stamp}.json`), JSON.stringify({ calls }, null, 2), 'utf8');
    say(`Ответы модели: runs/${stamp}.json`);
  }
}

await main();
