import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import * as schema from '../db/schema.js';
import { batches, items, telegramUpdates, topics, users, userSettings } from '../db/schema.js';
import type { AiStage } from '../db/schema.js';
import { startTelegramStub, type TelegramStub } from '../e2e/telegram-stub.js';
import { postUpdate, textUpdate } from '../e2e/updates.js';
import { activatePrompt, seedPrompt } from '../modules/ai/prompts/seed.js';
import { SCHEMA_BY_STAGE } from '../modules/ai/schemas/index.js';
import { STEP } from '../modules/onboarding/onboarding.service.js';
import { upsertUser } from '../modules/users/users.repo.js';
import { defaultTexts } from '../texts/index.js';

/**
 * Прогон жалобы с боевого (задачи 3.21–3.23).
 *
 * **Зачем отдельным скриптом.** Три починки закрывали один живой случай:
 * выдача не про то, что человек сказал; повтор выгрузки плодит дубли;
 * подписи кнопок обрезаются. Каждая проверена своими тестами, но человек
 * жаловался не на три починки — он жаловался на один разговор с ботом.
 * Проверить надо именно разговор, целиком и на живой модели.
 *
 * **Что настоящее.** Свой процесс бота, вебхук с секретом, Postgres,
 * Redis, очередь, воркер, промпты из `docs/prompts`, живая модель.
 * Подменён только Telegram — иначе ответ бота не прочитать.
 *
 * **Состояние человека воспроизведено по боевой базе:** его девять тем и
 * три дела из прошлых выгрузок, те самые, что вытесняли свежие. Векторов
 * у них нет: правки в этом сценарии не участвуют, а отсев повторов
 * сверяет текст, не близость.
 *
 * Текст выгрузки — расшифровка его голосового, слово в слово из
 * `batches.combined_text`.
 *
 * **Прогон стоит денег заказчицы:** около восьми обращений к модели.
 *
 * Запуск:
 *   cd apps/bot
 *   YANDEX_API_KEY=… YANDEX_FOLDER_ID=… npx tsx src/scripts/check-complaint.ts
 */

const DB_URL = process.env['E2E_DATABASE_URL'] ?? 'postgres://vydoh:vydoh@localhost:5434/vydoh_e2e';
const REDIS_URL = process.env['E2E_REDIS_URL'] ?? 'redis://localhost:6379/9';
const SECRET = 'e2e-secret-e2e-secret';
const CHAT_ID = 999_000_555;
const PORT = Number(process.env['E2E_PORT'] ?? 3459);
const ZONE = 'Europe/Moscow';

/** Темы человека с боевого — все девять. */
const TOPICS = [
  'семья',
  'здоровье',
  'работа',
  'покупки',
  'дом',
  'дети',
  'деньги',
  'учёба',
  'личное',
] as const;

/** Его голосовое, расшифровка слово в слово. */
const SAID =
  'Сделай мне сегодня, распредели, мне нужно съездить в магазин, оплатить ' +
  'бухгалтеру налоги, позвонить заказчику и отправить ссылки на сайт. ' +
  'Распредели по делам, мне еще нужно купить себе витамины, заплатить по учебе.';

/** Что он назвал — по этому проверяется, попало ли это в ответ. */
const NAMED = ['магазин', 'налог', 'заказчик', 'ссылк', 'витамин', 'учеб'];

/** Что лежало у него до этой выгрузки и вытесняло свежее из ответа. */
const OLD = [
  { text: 'записать к врачу в четверг', priority: 'SOON', topic: 'здоровье', days: 3 },
  { text: 'Записаться к врачу в пятницу', priority: 'SOON', topic: 'здоровье', days: 4 },
  { text: 'Нужно сходить с собакой погулять', priority: 'NOW', topic: 'личное', days: 0 },
] as const;

let passed = 0;
let failed = 0;

function ok(title: string): void {
  process.stdout.write(`  [32mOK[0m  ${title}\n`);
  passed++;
}

function no(title: string, detail = ''): void {
  process.stdout.write(`  [31mНЕТ[0m ${title}${detail === '' ? '' : ` — ${detail}`}\n`);
  failed++;
}

function check(title: string, condition: boolean, detail = ''): void {
  if (condition) ok(title);
  else no(title, detail);
}

function say(title: string): void {
  process.stdout.write(`\n[1m==> ${title}[0m\n`);
}

const pool = new pg.Pool({ connectionString: DB_URL });
const db = drizzle(pool, { schema });

async function ensureDatabase(): Promise<void> {
  const url = new URL(DB_URL);
  const name = url.pathname.replace(/^\//u, '');
  const adminUrl = new URL(DB_URL);
  adminUrl.pathname = '/postgres';

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const existing = await admin.query('select 1 from pg_database where datname = $1', [name]);
    if (existing.rowCount === 0) await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }

  await pool.query('create extension if not exists vector');
  await migrate(db, { migrationsFolder: './drizzle' });
}

async function seedPrompts(): Promise<void> {
  const directory = process.env['E2E_PROMPTS'] ?? join('..', '..', 'docs', 'prompts');
  const files = (await readdir(directory)).filter((name) => name.endsWith('.md')).sort();

  let seeded = 0;
  for (const file of files) {
    const version = basename(file, '.md');
    const stage = version.split('@')[0];
    if (stage === undefined || !(stage in SCHEMA_BY_STAGE)) continue;

    const schemaName = SCHEMA_BY_STAGE[stage as AiStage];
    if (schemaName === undefined) continue;

    const prompt = (await readFile(join(directory, file), 'utf8')).trim();
    await seedPrompt(db, { stage: stage as AiStage, version, prompt, schemaName });
    await activatePrompt(db, stage as AiStage, version);
    seeded++;
  }

  if (seeded === 0) throw new Error(`в папке ${directory} нет промптов — разбор не заработает`);
}

async function seedUser(): Promise<string> {
  const user = await upsertUser(db, { tgId: CHAT_ID, firstName: 'Никита' });

  await db
    .update(users)
    .set({ consentAt: new Date(), timezone: ZONE, timezoneConfirmed: true })
    .where(eq(users.id, user.id));

  const settings = { onboardingStep: STEP.done };
  await db
    .insert(userSettings)
    .values({ userId: user.id, ...settings })
    .onConflictDoUpdate({ target: userSettings.userId, set: settings });

  for (const [index, name] of TOPICS.entries()) {
    await db
      .insert(topics)
      .values({ userId: user.id, name, sortOrder: index })
      .onConflictDoNothing();
  }

  const day = 24 * 60 * 60_000;
  for (const one of OLD) {
    await db.insert(items).values({
      userId: user.id,
      text: one.text,
      type: 'TASK',
      priority: one.priority,
      topic: one.topic,
      ...(one.days === 0
        ? {}
        : {
            deadlineAt: new Date(Date.now() + one.days * day),
            deadlineAccuracy: 'day' as const,
          }),
    });
  }

  return user.id;
}

async function cleanup(userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(telegramUpdates);
}

function startBot(stub: TelegramStub): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORT),
      LOG_LEVEL: process.env['E2E_LOG_LEVEL'] ?? 'warn',
      DATABASE_URL: DB_URL,
      REDIS_URL,
      BOT_TOKEN: '777:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      BOT_WEBHOOK_SECRET: SECRET,
      BOT_SET_WEBHOOK_ON_BOOT: 'false',
      PUBLIC_URL: 'https://e2e.invalid',
      PRIVACY_POLICY_URL: 'https://e2e.invalid/privacy',
      TELEGRAM_API_ROOT: stub.url,
      SPEECH_PROVIDER: 'mock',
      AI_PROVIDER: 'yandex',
      REMINDERS: 'off',
      RECURRENCE_SUGGESTIONS: 'off',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

async function waitForReady(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(PORT)}/health/ready`);
      if (response.ok) return;
    } catch {
      // Процесс ещё поднимается.
    }
    await sleep(500);
  }

  throw new Error('бот не стал готов за тридцать секунд');
}

async function waitForBatch(userId: string, expected: number): Promise<string | undefined> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const rows = await db
      .select({ status: batches.status })
      .from(batches)
      .where(eq(batches.userId, userId));

    const done = rows.filter((row) => row.status === 'done' || row.status === 'failed');
    if (done.length >= expected) return done.at(-1)?.status;
    await sleep(500);
  }

  return undefined;
}

let messageId = 2000;

async function send(text: string): Promise<void> {
  messageId += 1;
  const status = await postUpdate(
    { baseUrl: `http://127.0.0.1:${String(PORT)}`, secret: SECRET },
    textUpdate({ chatId: CHAT_ID, messageId, firstName: 'Никита' }, text),
  );

  if (status < 200 || status >= 300) throw new Error(`вебхук ответил ${String(status)}`);
}

/**
 * Сколько обращений к Telegram уже было.
 *
 * Список заглушки только для чтения, поэтому вместо очистки запоминается
 * позиция: всё, что после неё, относится к текущей выгрузке. Так надёжнее
 * и очистки: она стёрла бы и то, чего мы ещё не прочитали.
 */
function mark(): number {
  return stub.calls.length;
}

/**
 * Клавиатура последнего сообщения человеку — **строками**.
 *
 * Строки, а не плоский список подписей: обрезание кнопок и было в том,
 * что все три стояли одной строкой. Проверка, которая склеивает строки,
 * этого не увидит — и не увидела.
 */
function lastRows(from: number): string[][] {
  const call = stub.calls
    .slice(from)
    .filter(
      (one) =>
        (one.method === 'sendMessage' || one.method === 'editMessageText') &&
        one.payload['message_thread_id'] === undefined &&
        one.payload['reply_markup'] !== undefined,
    )
    .at(-1);

  const markup = call?.payload['reply_markup'] as
    { inline_keyboard?: { text: string }[][] } | undefined;

  return (markup?.inline_keyboard ?? []).map((row) => row.map((one) => one.text));
}

/** Последняя реплика человеку — не сводка ветки. */
const SUMMARY_MARK = defaultTexts.summary.header('').trim();

function answerToPerson(from: number): string {
  const texts = stub.calls
    .slice(from)
    .filter((one) => one.method === 'sendMessage' || one.method === 'editMessageText')
    .filter((one) => one.payload['message_thread_id'] === undefined)
    .map((one) => (typeof one.payload['text'] === 'string' ? one.payload['text'] : ''))
    .filter((text) => text !== '' && !text.includes(SUMMARY_MARK));

  return texts.at(-1) ?? '';
}

async function openTexts(userId: string): Promise<string[]> {
  const rows = await db.select().from(items).where(eq(items.userId, userId));
  return rows.map((row) => row.text);
}

// ── Прогон ────────────────────────────────────────────────────────────────

await ensureDatabase();
await seedPrompts();

const stub = await startTelegramStub();
const bot = startBot(stub);

let userId = '';

try {
  await waitForReady();
  userId = await seedUser();

  say('Он говорит то же, что 31.08: шесть дел и «распредели по делам»');
  const firstMark = mark();
  await send(SAID);

  const first = await waitForBatch(userId, 1);
  check('выгрузка разобрана', first === 'done', `состояние: ${String(first)}`);

  const answer = answerToPerson(firstMark);
  process.stdout.write(`\n[2m${answer}[0m\n\n`);

  const named = NAMED.filter((mark) => answer.toLowerCase().includes(mark));
  check(
    'в ответе есть дела, которые он только что назвал',
    named.length > 0,
    `нашлось: ${named.join(', ') || 'ни одного'}`,
  );
  check(
    'в ответе нет старых дел про врача',
    !answer.toLowerCase().includes('врач'),
    'старое дело снова вытеснило свежее',
  );
  check(
    'в ответе нет старого дела про собаку',
    !answer.toLowerCase().includes('собак'),
    'старое дело снова вытеснило свежее',
  );

  const rows = lastRows(firstMark);
  process.stdout.write(`  клавиатура: ${rows.map((row) => `[${row.join(' | ')}]`).join(' ')}\n`);

  check(
    'кнопки §13.2 стоят двумя строками, а не одной',
    rows.length === 2,
    `строк: ${String(rows.length)}`,
  );
  check(
    '«Оставить на потом» стоит одна в своей строке',
    rows.at(-1)?.length === 1 && rows.at(-1)?.[0] === defaultTexts.answer.buttonLater,
    `последняя строка: ${JSON.stringify(rows.at(-1))}`,
  );
  check(
    'все три кнопки §13.2 на месте и в порядке ТЗ',
    rows.flat().join('|') ===
      [
        defaultTexts.answer.buttonDoNow,
        defaultTexts.answer.buttonShowAll,
        defaultTexts.answer.buttonLater,
      ].join('|'),
    rows.flat().join(', '),
  );

  const afterFirst = await openTexts(userId);
  check(
    'записи из выгрузки заведены',
    afterFirst.length > OLD.length,
    `было ${String(OLD.length)}, стало ${String(afterFirst.length)}`,
  );

  say('Он отправляет то же голосовое второй раз — как тогда');
  const secondMark = mark();
  await send(SAID);

  const second = await waitForBatch(userId, 2);
  check('вторая выгрузка разобрана', second === 'done', `состояние: ${String(second)}`);

  const afterSecond = await openTexts(userId);
  check(
    'ни одной новой записи не появилось',
    afterSecond.length === afterFirst.length,
    `было ${String(afterFirst.length)}, стало ${String(afterSecond.length)}`,
  );

  const repeated = answerToPerson(secondMark);
  const namedAgain = NAMED.filter((mark) => repeated.toLowerCase().includes(mark));
  check(
    'повтор отвечает про его дела, а не пустотой',
    namedAgain.length > 0,
    `нашлось: ${namedAgain.join(', ') || 'ни одного'}`,
  );
  check(
    'и снова без старых дел',
    !repeated.toLowerCase().includes('врач') && !repeated.toLowerCase().includes('собак'),
    repeated.slice(0, 120),
  );

  say('Что легло в базу');
  const rowsInDb = await db.select().from(items).where(eq(items.userId, userId));
  for (const row of rowsInDb) {
    process.stdout.write(
      `  ${(row.priority ?? '—').padEnd(6)} ${(row.topic ?? '—').padEnd(10)} ${row.text}\n`,
    );
  }

  const byTopic = new Set(rowsInDb.filter((row) => !row.isDraft).map((row) => row.topic));
  check(
    'дела разложены больше чем по одной теме',
    byTopic.size > 1,
    `тем: ${[...byTopic].join(', ')}`,
  );
  check(
    'черновиков нет',
    rowsInDb.every((row) => !row.isDraft),
    `черновиков: ${String(rowsInDb.filter((row) => row.isDraft).length)}`,
  );
} finally {
  if (userId !== '') await cleanup(userId);
  bot.kill('SIGTERM');
  await sleep(1000);
  await stub.close();
  await pool.end();
}

process.stdout.write(`\n[1mПройдено ${String(passed)}, провалено ${String(failed)}[0m\n`);
process.exit(failed === 0 ? 0 : 1);
