import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { and, eq } from 'drizzle-orm';
import pg from 'pg';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import * as schema from '../db/schema.js';
import {
  batches,
  items,
  projectSteps,
  recurrenceSuggestions,
  reminders,
  telegramUpdates,
  topics,
  users,
  userSettings,
  type Item,
} from '../db/schema.js';
import type { AiStage } from '../db/schema.js';
import { STEP } from '../modules/onboarding/onboarding.service.js';
import { activatePrompt, seedPrompt } from '../modules/ai/prompts/seed.js';
import { SCHEMA_BY_STAGE } from '../modules/ai/schemas/index.js';
import { setItemEmbedding } from '../modules/embedder/embedder.service.js';
import { startTelegramStub, type TelegramStub } from '../e2e/telegram-stub.js';
import { callbackUpdate, postUpdate, textUpdate } from '../e2e/updates.js';
import { defaultTexts } from '../texts/index.js';
import { upsertUser } from '../modules/users/users.repo.js';

/**
 * Сквозной тест этапа 3 (задача 3.18).
 *
 * Проверяет §21 п.4, 5, 6, 8, 11 на живой системе: свой процесс бота,
 * свой HTTP-сервер, вебхук с секретом, Postgres, Redis, очередь, воркер,
 * живая языковая модель и настоящие промпты из `docs/prompts`.
 *
 * **Что подменено.** Telegram — иначе ответ бота не прочитать. Речь —
 * голосовое может прислать только живой человек (проверяется руками, см.
 * рантбук). Всё остальное настоящее, включая планировщик.
 *
 * **Почему не GramJS, как стояло в плане.** Вход пользователем требует
 * кода из SMS вручную при каждой смене сессии; сквозной тест, который
 * нельзя запустить без человека с телефоном, не будут запускать. Этапы 1
 * и 2 отступили от GramJS по той же причине.
 *
 * **Прогон стоит денег заказчицы.** Около десяти обращений к модели за
 * один запуск. Не гонять в цикле.
 *
 * Запуск:
 *   cd apps/bot
 *   YANDEX_API_KEY=… YANDEX_FOLDER_ID=… npx tsx src/scripts/e2e-stage3.ts
 */

const DB_URL = process.env['E2E_DATABASE_URL'] ?? 'postgres://vydoh:vydoh@localhost:5434/vydoh_e2e';
const REDIS_URL = process.env['E2E_REDIS_URL'] ?? 'redis://localhost:6379/8';
const SECRET = 'e2e-secret-e2e-secret';
const CHAT_ID = 999_000_333;
const PORT = Number(process.env['E2E_PORT'] ?? 3458);
const ZONE = 'Europe/Moscow';

const TOPICS = ['семья', 'здоровье', 'работа', 'покупки', 'личное'] as const;

/**
 * Какие сценарии гонять: `E2E_ONLY=4` или `E2E_ONLY=1,2`.
 *
 * Прогон стоит денег заказчицы, а разбираться приходится с одним
 * сценарием за раз. Без этого выбора каждая попытка починить один пункт
 * оплачивала бы ещё девять обращений к модели.
 */
const ONLY = new Set(
  (process.env['E2E_ONLY'] ?? '')
    .split(',')
    .map((one) => one.trim())
    .filter((one) => one.length > 0),
);

function runs(scenario: string): boolean {
  return ONLY.size === 0 || ONLY.has(scenario);
}

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
 * активной версии промпта в базе нет. Та же ловушка, что при выкладке.
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

interface SeedOptions {
  readonly morningTime?: string;
  readonly eveningTime?: string;
  readonly quietHoursOn?: boolean;
}

/** Человек с пройденным онбордингом: темы, пояс, согласие. */
async function seedUser(options: SeedOptions = {}): Promise<string> {
  const user = await upsertUser(db, { tgId: CHAT_ID, firstName: 'Сквозной' });

  await db
    .update(users)
    .set({ consentAt: new Date(), timezone: ZONE, timezoneConfirmed: true })
    .where(eq(users.id, user.id));

  const settings = {
    onboardingStep: STEP.done,
    ...(options.morningTime === undefined ? {} : { morningTime: options.morningTime }),
    ...(options.eveningTime === undefined ? {} : { eveningTime: options.eveningTime }),
    ...(options.quietHoursOn === undefined ? {} : { quietHoursOn: options.quietHoursOn }),
  };

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

  return user.id;
}

async function cleanup(userId: string): Promise<void> {
  // Каскад по внешним ключам уносит сообщения, выгрузки и записи вместе с
  // человеком. Журнал апдейтов чистится отдельно: ссылки на пользователя
  // у него нет, и без этого повторный прогон отсекался бы дедупликацией.
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(telegramUpdates);
}

function startBot(stub: TelegramStub, extra: Record<string, string> = {}): ChildProcess {
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
      // Напоминания и обход истории проверяются сценариями 5 и 7.
      REMINDERS: 'on',
      RECURRENCE_SUGGESTIONS: 'on',
      ...extra,
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

async function waitForBatch(
  userId: string,
  expected = 1,
  seconds = 150,
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

let messageId = 1000;

async function send(text: string): Promise<void> {
  messageId += 1;
  const status = await postUpdate(
    { baseUrl: `http://127.0.0.1:${String(PORT)}`, secret: SECRET },
    textUpdate({ chatId: CHAT_ID, messageId, firstName: 'Сквозной' }, text),
  );

  if (status < 200 || status >= 300) throw new Error(`вебхук ответил ${String(status)}`);
}

async function press(data: string): Promise<void> {
  messageId += 1;
  const status = await postUpdate(
    { baseUrl: `http://127.0.0.1:${String(PORT)}`, secret: SECRET },
    callbackUpdate({ chatId: CHAT_ID, messageId, firstName: 'Сквозной' }, data),
  );

  if (status < 200 || status >= 300) throw new Error(`вебхук ответил ${String(status)}`);
  // Нажатие обрабатывается вне очереди выгрузок: короткой паузы хватает.
  await sleep(2500);
}

interface Keyboard {
  readonly labels: readonly string[];
  readonly actions: readonly string[];
}

/** Кнопки под последним сообщением человеку. */
function lastKeyboard(): Keyboard {
  const call = stub.calls
    .filter(
      (one) =>
        (one.method === 'sendMessage' || one.method === 'editMessageText') &&
        one.payload['message_thread_id'] === undefined &&
        one.payload['reply_markup'] !== undefined,
    )
    .at(-1);

  const markup = call?.payload['reply_markup'] as
    { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined;

  const flat = (markup?.inline_keyboard ?? []).flat();

  return { labels: flat.map((one) => one.text), actions: flat.map((one) => one.callback_data) };
}

/**
 * Признак сводки ветки: по нему её отличают от ответа человеку.
 *
 * По ветке отличить нельзя: сводка обновляется через `editMessageText`, а
 * у правки признака ветки нет — правят по номеру сообщения. До того как
 * сводки начали обновляться после правок, это не мешало; после — сводка
 * стала выглядеть последним ответом человеку и роняла проверку.
 *
 * Заголовок берётся из словаря, а не переписан сюда: правка формулировки
 * не должна ломать тест, который к ней отношения не имеет.
 */
const SUMMARY_MARK = defaultTexts.summary.header('').trim();

/** Последний ответ человеку, не сводка ветки. */
function answerToPerson(): string {
  return (
    stub.calls
      .filter(
        (call) =>
          (call.method === 'sendMessage' || call.method === 'editMessageText') &&
          call.payload['message_thread_id'] === undefined &&
          !(
            typeof call.payload['text'] === 'string' && call.payload['text'].includes(SUMMARY_MARK)
          ),
      )
      .map((call) => (typeof call.payload['text'] === 'string' ? call.payload['text'] : ''))
      .at(-1) ?? ''
  );
}

/** Все реплики человеку за прогон: где искать, если что-то не совпало. */
function allAnswers(): string {
  return stub.calls
    .filter((call) => call.method === 'sendMessage' || call.method === 'editMessageText')
    .map((call) => (typeof call.payload['text'] === 'string' ? call.payload['text'] : ''))
    .join('\n---\n');
}

async function openItems(userId: string): Promise<Item[]> {
  return await db.select().from(items).where(eq(items.userId, userId));
}

/** Местное время ЧЧ:ММ через `minutes` минут от сейчас. */
function localTimeIn(minutes: number): string {
  const at = new Date(Date.now() + minutes * 60_000);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
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

  if (runs('1')) {
    // ── Сценарий 1: корректировка даты (§21 п.4) ───────────────────────────
    say('Сценарий 1: корректировка даты меняет запись, а не создаёт вторую');

    stub.reset();
    await send('надо записать сына к врачу в четверг');
    const created = await waitForBatch(userId, 1);
    check('первая выгрузка разобрана', created === 'done', `состояние: ${String(created)}`);

    const afterFirst = await openItems(userId);
    const doctor = afterFirst.find((one) => /врач/iu.test(one.text));
    check(
      'запись со сроком создана',
      doctor?.deadlineAt != null,
      `записей: ${String(afterFirst.length)}`,
    );

    const beforeCount = afterFirst.length;
    const thursday = doctor?.deadlineAt;

    stub.reset();
    await send('не в четверг, а в пятницу');
    await waitForBatch(userId, 2);

    const afterFix = await openItems(userId);
    check(
      'вторая запись не создана',
      afterFix.length === beforeCount,
      `было ${String(beforeCount)}, стало ${String(afterFix.length)}`,
    );

    const moved = afterFix.find((one) => one.id === doctor?.id);
    check(
      'срок существующей записи сдвинут',
      moved?.deadlineAt != null && moved.deadlineAt.getTime() !== thursday?.getTime(),
      `было ${String(thursday)}, стало ${String(moved?.deadlineAt)}`,
    );

    const fixAnswer = answerToPerson();
    check(
      'показано, что именно изменилось',
      /Перенесла|Поправила/u.test(fixAnswer),
      `ответ: ${fixAnswer}`,
    );

    const undo = lastKeyboard();
    const undoAction = undo.actions[undo.labels.indexOf(defaultTexts.resolver.buttonUndo)];
    if (undoAction === undefined) {
      no('под изменением есть кнопка отката', `кнопки: ${undo.labels.join(', ')}`);
    } else {
      ok('под изменением есть кнопка отката');

      stub.reset();
      await press(undoAction);

      const reverted = (await openItems(userId)).find((one) => one.id === doctor?.id);
      check(
        'откат вернул прежний срок',
        reverted?.deadlineAt?.getTime() === thursday?.getTime(),
        `стало ${String(reverted?.deadlineAt)}, ждали ${String(thursday)}`,
      );
    }
  }
  if (runs('2')) {
    // ── Сценарий 2: неоднозначность (§21 п.5) ──────────────────────────────
    say('Сценарий 2: неоднозначная правка даёт один вопрос с двумя кнопками');

    await cleanup(userId);
    userId = await seedUser();
    stub.reset();

    await send('надо пропить курс витаминов и записаться к ортопеду');
    await waitForBatch(userId, 1);

    const pair = await openItems(userId);
    check('обе близкие записи созданы', pair.length >= 2, `записей: ${String(pair.length)}`);

    stub.reset();
    await send('перенеси на пятницу');
    await waitForBatch(userId, 2);

    const asked = answerToPerson();
    const keyboard = lastKeyboard();

    check(
      'бот не угадал, а спросил',
      asked.includes('?') && keyboard.actions.length === 2,
      `ответ: ${asked}\nкнопки: ${keyboard.labels.join(', ')}`,
    );

    check(
      'в реплике ровно один вопрос (§13.9)',
      (asked.match(/\?/gu) ?? []).length === 1,
      `ответ: ${asked}`,
    );

    const first = keyboard.actions[0];
    if (first === undefined) {
      no('первая кнопка отрабатывает');
    } else {
      stub.reset();
      await press(first);

      const afterChoice = await openItems(userId);
      const withDeadline = afterChoice.filter((one) => one.deadlineAt !== null);
      check(
        'ответ кнопкой применён ровно к одной записи',
        withDeadline.length === 1,
        `со сроком: ${withDeadline.map((one) => one.text).join(' / ')}`,
      );
    }
  }
  if (runs('3')) {
    // ── Сценарий 3: отметка выполнения (§21 п.8) ───────────────────────────
    say('Сценарий 3: отметка выполнения без уточняющих вопросов');

    await cleanup(userId);
    userId = await seedUser();
    stub.reset();

    await send('надо оплатить садик за сентябрь');
    await waitForBatch(userId, 1);

    stub.reset();
    await send('садик оплатила');
    await waitForBatch(userId, 2);

    const closed = await openItems(userId);
    const kindergarten = closed.find((one) => /садик/iu.test(one.text));
    check(
      'запись переведена в выполненные',
      kindergarten?.status === 'done',
      `статус: ${String(kindergarten?.status)}`,
    );

    /**
     * §21 п.8 запрещает **уточняющие** вопросы: бот не должен
     * переспрашивать, о какой записи речь. Вопрос сценария 8 §2 —
     * «продолжаем или на сегодня достаточно» — уточняющим не является и
     * прямо назван в ТЗ. Проверяем оба требования по отдельности.
     */
    const said = allAnswers();
    check(
      'уточняющего вопроса о записи не было (§21 п.8)',
      !/отдельная история|это про/iu.test(said),
      `реплики: ${said}`,
    );
    check(
      'бот спросил, продолжаем или на сегодня хватит (§2, сценарий 8)',
      answerToPerson() === defaultTexts.resolver.goOn,
      `последняя реплика: ${answerToPerson()}`,
    );
    check(
      'и дал две кнопки',
      lastKeyboard().labels.length === 2,
      `кнопки: ${lastKeyboard().labels.join(', ')}`,
    );
  }
  if (runs('6')) {
    // ── Сценарий 6: регулярное дело (запрос на изменение №1) ───────────────
    say('Сценарий 6: «каждый вторник» — одна запись с правилом');

    await cleanup(userId);
    userId = await seedUser();
    stub.reset();

    await send('каждый вторник вожу сына на плавание');
    await waitForBatch(userId, 1);

    const swimming = (await openItems(userId)).find((one) => /плаван/iu.test(one.text));
    check(
      'создана одна запись с правилом повторения',
      swimming?.recurrenceRule != null,
      `правило: ${JSON.stringify(swimming?.recurrenceRule)}`,
    );

    if (swimming !== undefined) {
      /**
       * Две пропущенные недели: срок отодвигаем назад руками.
       *
       * Ждать две недели нельзя, а проверить надо именно это — §13.6
       * запрещает превращать пропуск в очередь просроченных.
       */
      const twoWeeksBack = new Date(Date.now() - 14 * 24 * 60 * 60_000);
      await db
        .update(items)
        .set({ deadlineAt: twoWeeksBack, deadlineAccuracy: 'day' })
        .where(eq(items.id, swimming.id));

      stub.reset();
      /**
       * «Отвёл», а не «свозил», и это не придирка к слову.
       *
       * На «свозил сына на плавание» YandexGPT отвечает «Я не могу
       * обсуждать эту тему» — срабатывает фильтр безопасности, причём на
       * само слово: «свозил сына в бассейн» тоже отказ, а «отвёл сына на
       * плавание», «на плавание сходили» и «вожу сына на плавание»
       * проходят. Проверено прямым обращением к модели.
       *
       * Продукт при отказе ведёт себя верно: текст сохраняется целиком,
       * человек получает «Сохранила целиком. Разберу позже». Но сквозной
       * тест должен проверять перенос срока у регулярного дела, а не
       * фильтр чужой модели.
       */
      await send('отвёл сына на плавание');
      await waitForBatch(userId, 2);

      const afterDone = await openItems(userId);
      const same = afterDone.find((one) => one.id === swimming.id);

      check(
        'вторая запись не создана',
        afterDone.filter((one) => /плаван/iu.test(one.text)).length === 1,
        `записей про плавание: ${String(afterDone.filter((one) => /плаван/iu.test(one.text)).length)}`,
      );

      check(
        'запись не закрыта, а перенесена вперёд',
        same?.status !== 'done' && (same?.deadlineAt?.getTime() ?? 0) > Date.now(),
        `статус ${String(same?.status)}, срок ${String(same?.deadlineAt)}`,
      );

      check(
        'догоняющей очереди из просроченных нет',
        afterDone.filter((one) => (one.deadlineAt?.getTime() ?? Infinity) < Date.now()).length ===
          0,
        `просроченных: ${String(
          afterDone.filter((one) => (one.deadlineAt?.getTime() ?? Infinity) < Date.now()).length,
        )}`,
      );
    }
  }
  if (runs('8')) {
    // ── Сценарий 8: дополнение против замены (§7.4) ────────────────────────
    say('Сценарий 8: «а ещё туда» дописывает подробность, а не заводит запись');

    await cleanup(userId);
    userId = await seedUser();
    stub.reset();

    await send('надо записать сына к врачу в четверг');
    await waitForBatch(userId, 1);

    const before = (await openItems(userId)).length;

    stub.reset();
    await send('а ещё туда надо взять карту прививок');
    await waitForBatch(userId, 2);

    const after = await openItems(userId);
    const doctor = after.find((one) => /врач/iu.test(one.text));

    check(
      'подробность легла в запись про врача',
      doctor?.body != null && /привив/iu.test(doctor.body),
      `подробности: ${String(doctor?.body)}`,
    );

    check(
      'вторая запись не создана',
      after.length === before,
      `было ${String(before)}, стало ${String(after.length)}: ${after.map((one) => one.text).join(' / ')}`,
    );

    check(
      'заголовок не переписан',
      doctor?.text.includes('врач') === true,
      `заголовок: ${String(doctor?.text)}`,
    );
  }

  if (runs('4')) {
    // ── Сценарий 4: возврат к проекту (§21 п.6) ────────────────────────────
    say('Сценарий 4: возврат к проекту через неделю — контекст и ближайший шаг');

    await cleanup(userId);
    userId = await seedUser();
    stub.reset();

    await send('надо спланировать день рождения сына, там куча всего');
    await waitForBatch(userId, 1);

    const project = (await openItems(userId)).find((one) => /рожден/iu.test(one.text));
    check(
      'проект создан',
      project !== undefined,
      `записей: ${String((await openItems(userId)).length)}`,
    );

    if (project !== undefined) {
      /**
       * Неделя тишины: сдвигаем время последнего движения назад.
       *
       * Ждать неделю нельзя, а сценарий §21 п.6 именно про возврат спустя
       * неделю. Фикстура с прошлыми датами предусмотрена планом.
       */
      const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000);
      await db.update(items).set({ updatedAt: weekAgo }).where(eq(items.id, project.id));

      stub.reset();
      await send('что там с днём рождения');
      await waitForBatch(userId, 2);

      const context = answerToPerson();
      const steps = await db.select().from(projectSteps).where(eq(projectSteps.itemId, project.id));

      check('проект разложен на шаги', steps.length > 0, `шагов: ${String(steps.length)}`);
      check(
        'бот показал контекст проекта, а не пустой список',
        /рожден/iu.test(context) && context.length > 20,
        `ответ: ${context}`,
      );
      check(
        'назван ближайший шаг',
        steps.some((step) => context.includes(step.text)),
        `шаги: ${steps.map((one) => one.text).join(' / ')}\nответ: ${context}`,
      );
      check(
        'бот не переспрашивает известное',
        !/какой|уточни|напомни, что/iu.test(context),
        `ответ: ${context}`,
      );
    }
  }
  if (runs('5')) {
    // ── Сценарии 5 и 7: планировщик ────────────────────────────────────────
    say('Сценарии 5 и 7: утреннее напоминание и обход накопленной истории');

    await cleanup(userId);

    /**
     * Одно окно на два сценария.
     *
     * Планировщик просыпается раз в минуту, поэтому утро ставим через две
     * минуты, вечер — через три. Тишину выключаем: прогон может случиться
     * ночью, и тогда напоминания не были бы поставлены вовсе — правильное
     * поведение, но не то, что здесь проверяется.
     */
    userId = await seedUser({
      morningTime: localTimeIn(2),
      eveningTime: localTimeIn(3),
      quietHoursOn: false,
    });

    // Четыре ежемесячные оплаты с одинаковым вектором: связка, которую
    // обход обязан заметить. Векторы синтетические — живые считались бы
    // за деньги и ради проверки планировщика этого не нужно.
    const axis = Array.from({ length: 256 }, (_unused, position) => (position === 0 ? 1 : 0));
    for (const [index, monthsBack] of [3, 2, 1, 0].entries()) {
      const at = new Date(Date.now() - monthsBack * 30 * 24 * 60 * 60_000);
      const [row] = await db
        .insert(items)
        .values({
          userId,
          text: `Оплатить садик ${String(index)}`,
          type: 'TASK',
          priority: 'SOON',
          topic: 'деньги',
          status: monthsBack === 0 ? 'new' : 'done',
        })
        .returning({ id: items.id });

      const id = row?.id ?? '';
      await setItemEmbedding(db, id, axis);
      // Дата ставится после вектора: запись вектора двигает `updated_at`.
      await db.update(items).set({ createdAt: at }).where(eq(items.id, id));
    }

    stub.reset();

    const morningLabel = localTimeIn(2);
    process.stdout.write(`  ждём напоминаний: утро ${morningLabel}, вечер ${localTimeIn(3)}\n`);

    let morning: string | undefined;
    let evening: string | undefined;

    for (let attempt = 0; attempt < 300; attempt++) {
      const rows = await db
        .select({ kind: reminders.kind, sentAt: reminders.sentAt })
        .from(reminders)
        .where(and(eq(reminders.userId, userId)));

      const sentKinds = rows.filter((row) => row.sentAt !== null).map((row) => row.kind);

      if (morning === undefined && sentKinds.includes('morning')) {
        morning = stub.texts().find((text) => text.includes(defaultTexts.reminders.morningInvite));
      }

      if (evening === undefined && sentKinds.includes('evening')) {
        evening = stub.texts().find((text) => text.includes(defaultTexts.reminders.eveningInvite));
      }

      if (morning !== undefined && evening !== undefined) break;
      await sleep(1000);
    }

    check('утреннее напоминание пришло в заданное время', morning !== undefined, allAnswers());
    check('вечернее напоминание пришло', evening !== undefined, allAnswers());

    const planned = await db
      .select({
        kind: reminders.kind,
        dueAt: reminders.dueAt,
        dedupeKey: reminders.dedupeKey,
        sentAt: reminders.sentAt,
      })
      .from(reminders)
      .where(eq(reminders.userId, userId));

    /**
     * Сегодняшнее утреннее, а не любое.
     *
     * После отправки планировщик законно ставит завтрашнее — это не
     * дубль, а следующий день: у него другой ключ. Первая версия проверки
     * считала строки по виду и падала именно на этом.
     */
    const morningRow = planned
      .filter((row) => row.kind === 'morning')
      .sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime())[0];
    check(
      'утреннее поставлено на местное время из настроек',
      morningRow !== undefined &&
        new Intl.DateTimeFormat('en-GB', {
          timeZone: ZONE,
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(morningRow.dueAt) === morningLabel,
      `поставлено на ${String(morningRow?.dueAt)}, ждали ${morningLabel} по ${ZONE}`,
    );

    check(
      'все ключи заданий различны',
      new Set(planned.map((row) => row.dedupeKey)).size === planned.length,
      `ключи: ${planned.map((row) => row.dedupeKey).join(', ')}`,
    );

    check(
      'каждое напоминание отправлено ровно один раз',
      planned.filter((row) => row.kind === 'morning' && row.sentAt !== null).length === 1 &&
        planned.filter((row) => row.kind === 'evening' && row.sentAt !== null).length === 1,
      `отправлено: ${planned
        .filter((row) => row.sentAt !== null)
        .map((row) => row.dedupeKey)
        .join(', ')}`,
    );

    check(
      'предложение запомнить регулярность приехало в вечерней сводке',
      evening?.includes('каждый месяц') === true,
      `вечер: ${String(evening)}`,
    );

    check(
      'в вечерней сводке ровно один вопрос',
      ((evening ?? '').match(/\?/gu) ?? []).length === 1,
      `вечер: ${String(evening)}`,
    );

    const offerKeyboard = lastKeyboard();
    const decline =
      offerKeyboard.actions[offerKeyboard.labels.indexOf(defaultTexts.resolver.buttonNoNeed)];

    if (decline === undefined) {
      no('под предложением есть кнопка «Не надо»', `кнопки: ${offerKeyboard.labels.join(', ')}`);
    } else {
      ok('под предложением есть кнопка «Не надо»');

      await press(decline);

      const offers = await db
        .select()
        .from(recurrenceSuggestions)
        .where(eq(recurrenceSuggestions.userId, userId));

      check(
        'отказ записан — больше эту связку не предложим',
        offers.length === 1 && offers[0]?.outcome === 'declined',
        `предложений ${String(offers.length)}, исход ${String(offers[0]?.outcome)}`,
      );
    }
  }
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
