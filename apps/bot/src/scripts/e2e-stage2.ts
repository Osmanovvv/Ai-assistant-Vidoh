import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { eq } from 'drizzle-orm';
import pg from 'pg';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import * as schema from '../db/schema.js';
import { batches, items, telegramUpdates, topics, users, userSettings } from '../db/schema.js';
import { STEP } from '../modules/onboarding/onboarding.service.js';
import { activatePrompt, seedPrompt } from '../modules/ai/prompts/seed.js';
import { SCHEMA_BY_STAGE } from '../modules/ai/schemas/index.js';
import type { AiStage } from '../db/schema.js';
import { startTelegramStub, type TelegramStub } from '../e2e/telegram-stub.js';
import { postUpdate, textUpdate } from '../e2e/updates.js';
import { defaultTexts } from '../texts/index.js';
import { upsertUser } from '../modules/users/users.repo.js';

/**
 * Сквозной тест этапа 2 (задача 2.23).
 *
 * Проверяет §21 на живой системе: длинное сообщение со смесью дел, мыслей
 * и желаний — все дела распознаны, желания не стали задачами, показано не
 * более трёх действий, записи разложены по темам. Отдельно: реплика о
 * низком ресурсе сокращает выдачу до одного действия.
 *
 * **Что здесь настоящее.** Свой процесс бота, свой HTTP-сервер, вебхук с
 * секретом, Postgres, Redis, очередь, воркер, живая языковая модель и
 * настоящие промпты из `docs/prompts`. Подменены две вещи: Telegram (иначе
 * ответ бота не прочитать) и расшифровка речи (голосовое может прислать
 * только живой человек — это проверяется руками, см. рантбук).
 *
 * **Почему не GramJS, как стояло в плане.** Вход пользователем требует
 * кода из SMS вручную при каждой смене сессии; сквозной тест, который
 * нельзя запустить без человека с телефоном, не будут запускать. Первый
 * этап отступил от GramJS по той же причине, и это отступление
 * зафиксировано в плане.
 *
 * Запуск:
 *   cd apps/bot
 *   YANDEX_API_KEY=… YANDEX_FOLDER_ID=… npx tsx src/scripts/e2e-stage2.ts
 */

const DB_URL = process.env['E2E_DATABASE_URL'] ?? 'postgres://vydoh:vydoh@localhost:5434/vydoh_e2e';
const REDIS_URL = process.env['E2E_REDIS_URL'] ?? 'redis://localhost:6379/7';
const SECRET = 'e2e-secret-e2e-secret';
const CHAT_ID = 999_000_222;
const PORT = Number(process.env['E2E_PORT'] ?? 3457);

/** Темы человека: онбординг проверяется своими тестами, здесь он пройден. */
const TOPICS = ['семья', 'здоровье', 'работа', 'покупки', 'личное'] as const;

let passed = 0;
let failed = 0;

function ok(title: string): void {
  passed++;
  process.stdout.write(`  [32mOK[0m  ${title}\n`);
}

function no(title: string, detail = ''): void {
  failed++;
  process.stdout.write(`  [31mНЕТ[0m ${title}${detail === '' ? '' : ` — ${detail}`}\n`);
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

/**
 * Настоящие промпты из `docs/prompts` — те же, что в бою.
 *
 * Без этого шага бот поднимется здоровым и упадёт на первой выгрузке:
 * активной версии промпта в базе нет. Ровно та же ловушка, что при
 * выкладке на сервер, и здесь она проверяется заодно.
 */
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

/** Человек с пройденным онбордингом: темы, пояс, согласие. */
async function seedUser(): Promise<string> {
  const user = await upsertUser(db, { tgId: CHAT_ID, firstName: 'Сквозной' });

  await db
    .update(users)
    .set({ consentAt: new Date(), timezone: 'Europe/Moscow', timezoneConfirmed: true })
    .where(eq(users.id, user.id));

  // Онбординг пройден: он проверяется своими тестами, а здесь мешал бы —
  // первая выгрузка ушла бы в вопросы вместо разбора.
  await db
    .insert(userSettings)
    .values({ userId: user.id, onboardingStep: STEP.done })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { onboardingStep: STEP.done },
    });

  for (const [index, name] of TOPICS.entries()) {
    await db
      .insert(topics)
      .values({ userId: user.id, name, sortOrder: index })
      .onConflictDoNothing();
  }

  return user.id;
}

async function cleanup(userId: string): Promise<void> {
  // Каскад по внешним ключам уносит сообщения, выгрузки и записи вместе
  // с человеком. Журнал апдейтов чистится отдельно: у него нет ссылки на
  // пользователя, и без этого повторный прогон отсекался бы
  // дедупликацией по update_id — проверки падали бы, хотя система права.
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(telegramUpdates);
}

function startBot(stub: TelegramStub): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
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
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  return child;
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

/**
 * Ждёт, пока выгрузки дойдут до конечного состояния.
 *
 * `expected` — сколько их должно быть завершено: во втором сообщении
 * сценария выгрузка вторая, и ждать надо её, а не первую, которая уже
 * готова.
 */
async function waitForBatch(
  userId: string,
  seconds = 120,
  expected = 1,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < seconds * 2; attempt++) {
    const rows = await db
      .select({ status: batches.status })
      .from(batches)
      .where(eq(batches.userId, userId));

    const finished = rows.filter((row) => row.status === 'done' || row.status === 'failed');
    if (finished.length >= expected) return finished.at(-1)?.status;
    await sleep(500);
  }

  return undefined;
}

/** Идентификатор ветки первой темы, у которой он есть. */
async function threadIdOf(userId: string): Promise<number | undefined> {
  const rows = await db
    .select({ threadId: topics.tgThreadId })
    .from(topics)
    .where(eq(topics.userId, userId));

  return rows.map((row) => row.threadId).find((id): id is number => id !== null);
}

async function send(text: string, messageId: number): Promise<void> {
  const status = await postUpdate(
    { baseUrl: `http://127.0.0.1:${String(PORT)}`, secret: SECRET },
    textUpdate({ chatId: CHAT_ID, messageId, firstName: 'Сквозной' }, text),
  );

  if (status < 200 || status >= 300) throw new Error(`вебхук ответил ${String(status)}`);
}

/** Сообщение, отправленное человеком внутрь ветки темы. */
async function sendToThread(text: string, messageId: number, threadId: number): Promise<void> {
  const update = textUpdate({ chatId: CHAT_ID, messageId, firstName: 'Сквозной' }, text);
  const message = update['message'] as Record<string, unknown>;
  message['message_thread_id'] = threadId;
  message['is_topic_message'] = true;

  const status = await postUpdate(
    { baseUrl: `http://127.0.0.1:${String(PORT)}`, secret: SECRET },
    update,
  );

  if (status < 200 || status >= 300) throw new Error(`вебхук ответил ${String(status)}`);
}

/**
 * Ответ человеку, а не сводка ветки.
 *
 * Первый прогон на этом и споткнулся: последним сообщением оказалась
 * сводка темы, и проверка «не более трёх действий» считала пункты в ней.
 * Сводки уходят каждая в свою ветку, ответ — в общий чат, и различать их
 * надо по ветке, а не по порядку отправки.
 */
function answerToPerson(): string {
  return (
    stub.calls
      .filter(
        (call) =>
          (call.method === 'sendMessage' || call.method === 'editMessageText') &&
          call.payload['message_thread_id'] === undefined,
      )
      .map((call) => (typeof call.payload['text'] === 'string' ? call.payload['text'] : ''))
      .at(-1) ?? ''
  );
}

/**
 * Сколько действий предложено человеку.
 *
 * Пункты идут строками с тире после вводной фразы. И фраза, и вид пункта
 * берутся из словаря текстов, а не выдумываются тестом: иначе правка
 * формулировки ломала бы тест, который к ней отношения не имеет.
 */
function actionsIn(text: string): number {
  const leads = [defaultTexts.answer.actionsLead, defaultTexts.answer.actionsLeadSingle];
  const lines = text.split('\n');
  const start = lines.findIndex((line) => leads.some((lead) => line.includes(lead)));

  if (start === -1) return 0;

  let count = 0;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (!line.trimStart().startsWith(defaultTexts.answer.bullet('').trim())) break;
    count++;
  }

  return count;
}

const stub = await startTelegramStub();
let bot: ChildProcess | undefined;
let userId = '';

try {
  await ensureDatabase();
  await seedPrompts();
  userId = await seedUser();
  await cleanup(userId);
  userId = await seedUser();

  bot = startBot(stub);
  await waitForReady();

  // ── Сценарий 1: смесь дел, мыслей и желаний ────────────────────────────
  say('Сценарий 1: длинная выгрузка со смесью дел, мыслей и желаний');

  stub.reset();
  await send(
    'так надо записать сына к врачу, купить продукты на неделю, ' +
      'сверить кассу по работе. давно хочу начать бегать по утрам. ' +
      'и я вообще ничего не успеваю',
    501,
  );

  // Окно тишины закрывает выгрузку само (§9.1): ждём его, а не торопим.
  const status1 = await waitForBatch(userId);
  check('выгрузка дошла до «готово»', status1 === 'done', `состояние: ${String(status1)}`);

  const saved = await db.select().from(items).where(eq(items.userId, userId));
  // Тип у записи может быть пустым: так выглядит черновик, который
  // разбор не осилил. Для проверки это тоже ответ, и молча приравнивать
  // его к задаче нельзя.
  const byType = new Map<string, string[]>();
  for (const item of saved) {
    const type = item.type ?? 'без типа';
    byType.set(type, [...(byType.get(type) ?? []), item.text]);
  }

  const tasks = byType.get('TASK') ?? [];
  check(
    'все три дела распознаны',
    ['врач', 'продукт', 'касс'].every((root) =>
      tasks.some((text) => text.toLowerCase().includes(root)),
    ),
    `задачи: ${tasks.join(' / ')}`,
  );

  check(
    'желание не стало задачей (§6.2)',
    !tasks.some((text) => /бегать/iu.test(text)),
    `задачи: ${tasks.join(' / ')}`,
  );

  check(
    'состояние не стало задачей (§6.3)',
    !tasks.some((text) => /не успева/iu.test(text)),
    `задачи: ${tasks.join(' / ')}`,
  );

  const answer = answerToPerson();
  check('ответ человеку отправлен', answer !== '', `сообщений: ${String(stub.texts().length)}`);
  check(
    'показано не более трёх действий (§13.1)',
    actionsIn(answer) > 0 && actionsIn(answer) <= 3,
    `действий: ${String(actionsIn(answer))}
ответ: ${answer}`,
  );

  const withTopic = saved.filter((item) => item.topic !== null);
  check(
    'записи разложены по темам (§6.4)',
    withTopic.length === saved.length && saved.length > 0,
    `с темой ${String(withTopic.length)} из ${String(saved.length)}`,
  );

  // ── Сценарий 2: низкий ресурс ──────────────────────────────────────────
  say('Сценарий 2: реплика о низком ресурсе сокращает выдачу');

  await cleanup(userId);
  userId = await seedUser();
  stub.reset();

  await send(
    'я вымотана совсем, сил нет. надо оплатить садик, записаться к стоматологу, ' +
      'купить корм коту и забрать вещи из химчистки',
    601,
  );

  const status2 = await waitForBatch(userId);
  check('выгрузка дошла до «готово»', status2 === 'done', `состояние: ${String(status2)}`);

  const answer2 = answerToPerson();
  const shown = actionsIn(answer2);
  check(
    'при низком ресурсе показано одно действие (§13.7)',
    shown === 1,
    `действий: ${String(shown)}\nответ: ${answer2}`,
  );

  const saved2 = await db.select().from(items).where(eq(items.userId, userId));
  check(
    'остальные дела сохранены, а не потеряны',
    saved2.length >= 4,
    `записей: ${String(saved2.length)}`,
  );

  // ── Сценарий 3: сообщение в ветку ──────────────────────────────────────
  say('Сценарий 3: сообщение, отправленное в ветку, обработано в её контексте');

  await cleanup(userId);
  userId = await seedUser();
  stub.reset();

  // Первая выгрузка создаёт ветки: без них писать некуда.
  await send('купить продукты и записаться к врачу', 701);
  await waitForBatch(userId);

  const threads = stub
    .callsOf('createForumTopic')
    .map((call) => call['name'])
    .filter((name): name is string => typeof name === 'string');

  check(
    'ветки тем созданы',
    threads.length > 0,
    `создано: ${threads.length ? threads.join(', ') : 'ни одной'}`,
  );

  const threadId = await threadIdOf(userId);
  if (threadId === undefined) {
    no('у темы есть ветка в базе');
  } else {
    ok('у темы есть ветка в базе');

    stub.reset();
    await sendToThread('и ещё оплатить садик', 702, threadId);
    await waitForBatch(userId, 120, 2);

    const answered = stub.calls.filter(
      (call) =>
        (call.method === 'sendMessage' || call.method === 'editMessageText') &&
        call.payload['message_thread_id'] === threadId,
    );

    check(
      'ответ пришёл в ту же ветку, а не в общий чат',
      answered.length > 0,
      `ответов в ветку ${String(threadId)}: ${String(answered.length)}`,
    );
  }

  // ── Сценарий 4: плоский режим ──────────────────────────────────────────
  say('Сценарий 4: при выключенных темах разбор работает целиком (§8.2)');

  await cleanup(userId);
  userId = await seedUser();
  stub.reset();
  stub.setTopicsEnabled(false);

  await send('купить продукты, записаться к врачу и сверить кассу', 801);
  const flatStatus = await waitForBatch(userId);

  check(
    'выгрузка дошла до «готово» и без тем',
    flatStatus === 'done',
    `состояние: ${String(flatStatus)}`,
  );

  const flatItems = await db.select().from(items).where(eq(items.userId, userId));
  check(
    'записи сохранены и разложены по темам в базе',
    flatItems.length >= 3 && flatItems.every((item) => item.topic !== null),
    `записей: ${String(flatItems.length)}`,
  );

  const flatAnswer = answerToPerson();
  check(
    'человек получил обычный ответ, без упоминания веток',
    actionsIn(flatAnswer) > 0 && !/ветк|тем[аы]\s+telegram/iu.test(flatAnswer),
    `действий: ${String(actionsIn(flatAnswer))}`,
  );

  stub.setTopicsEnabled(true);

  // ── Итог ───────────────────────────────────────────────────────────────
  process.stdout.write(`\n[1mПройдено ${String(passed)}, провалено ${String(failed)}[0m\n`);
} catch (error) {
  process.stdout.write(`\n[31mПрогон сорвался:[0m ${String(error)}\n`);
  failed++;
} finally {
  if (userId !== '') await cleanup(userId).catch(() => undefined);
  bot?.kill('SIGTERM');
  await stub.close();
  await pool.end();
}

process.exit(failed === 0 ? 0 : 1);
