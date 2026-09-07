import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aiCalls,
  appSettings,
  batches,
  billingEvents,
  billingInvoices,
  billingSubscriptions,
  broadcastDeliveries,
  broadcasts,
  items,
  promptVersions,
  users,
} from '../db/schema.js';
import { createEvalRunner } from '../modules/admin/eval-run.js';
import { sendChunk, type BroadcastSender } from '../modules/broadcast/broadcast.service.js';
import { CLASSIFIER_SCHEMA_NAME } from '../modules/ai/schemas/index.js';
import { activatePrompt, seedPrompt } from '../modules/ai/prompts/seed.js';
import { hashPassword } from '../http/admin/password.js';
import { createServer } from '../http/server.js';
import type { Database } from '../infra/db.js';
import { SettingsRegistry } from '../modules/settings/settings.repo.js';
import { setupTestDatabase } from '../test/db.js';

/**
 * Стенд для сквозных проверок панели (§15 ТЗ, задача 4.5).
 *
 * Поднимает **тот же** сервер, что в бою, с той же панелью и той же
 * отдачей файлов — но без базы, очереди и Telegram: вход в панель ни
 * одного из них не касается, а поднимать их ради проверки окна входа
 * значило бы проверять их, а не окно.
 *
 * **Один процесс и один адрес — это часть проверяемого.** Печенье
 * пропуска помечено `SameSite=Strict` и путём `/admin`; если бы стенд
 * отдавал страницу с одного адреса, а API с другого, вход не работал бы
 * именно там, где его проверяют, — и разница с боем всплыла бы на
 * приёмке. Поэтому здесь всё как в бою: панель отдаёт тот же сервер.
 *
 * **Пароль приходит открытым текстом и хэшируется здесь.** В бою в
 * `.env` лежит хэш, но проверке нужно знать пароль, чтобы его ввести.
 * Отдельная переменная с явным именем честнее, чем хэш, подобранный
 * заранее и непонятно к чему относящийся.
 *
 * Запуск делает Playwright сам, см. `playwright.config.ts`.
 */

const PORT = Number(process.env['ADMIN_E2E_PORT'] ?? '3100');
const LOGIN = process.env['ADMIN_E2E_LOGIN'] ?? 'аня';
const PASSWORD = process.env['ADMIN_E2E_PASSWORD'] ?? 'очень-длинный-пароль-42';

/** Секрет из RFC 6238: у проверки должны быть предсказуемые коды. */
const TOTP_SECRET = process.env['ADMIN_E2E_TOTP_SECRET'] ?? 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const here = dirname(fileURLToPath(import.meta.url));
const dist = process.env['ADMIN_E2E_DIST'] ?? join(here, '../../../admin/dist');

/**
 * База со предсказуемыми строками учёта — для раздела расходов.
 *
 * **Настоящий путь целиком: база → запрос → страница.** Агрегаты сами
 * покрыты четырнадцатью проверками, страница нарисована отдельно, но
 * между ними есть шов — имена полей в ответе. Переименуй поле в одном
 * месте, и обе половины останутся зелёными, а панель покажет пустоту.
 * Ловится это только сквозным путём.
 *
 * Задаётся отдельной переменной и **только** ею: стенд чистит таблицу
 * учёта, и делать это по адресу из общей настройки было бы способом
 * однажды стереть боевой учёт.
 */
const seedUrl = process.env['ADMIN_E2E_DATABASE_URL'];
let seeded: Database | undefined;

if (seedUrl !== undefined) {
  process.env['TEST_DATABASE_URL'] = seedUrl;
  seeded = await setupTestDatabase();

  await seeded.delete(appSettings);
  await seeded.delete(broadcastDeliveries);
  await seeded.delete(broadcasts);
  await seeded.delete(aiCalls);
  /**
   * Счета чистятся **до** людей, и это не порядок ради порядка.
   *
   * У счёта связь с человеком обрывается, а не удаляется: выручка — наша
   * история, а не его данные (§16). Значит удаление людей оставило бы
   * обезличенные счета, и выручка на стенде росла бы с каждым прогоном.
   */
  await seeded.delete(billingEvents);
  await seeded.delete(billingSubscriptions);
  await seeded.delete(billingInvoices);
  await seeded.delete(users);

  const [person] = await seeded
    .insert(users)
    .values({ tgId: 90_001, firstName: 'Аня' })
    .returning({ id: users.id });

  if (person === undefined) throw new Error('стенд: человек не создался');

  const [batch] = await seeded
    .insert(batches)
    .values({ userId: person.id, status: 'done' })
    .returning({ id: batches.id });

  if (batch === undefined) throw new Error('стенд: выгрузка не создалась');

  /**
   * Разбор с текстом и результатом — для карточки (задача 4.6).
   *
   * Сеется настоящая жалоба: человек сказал про врача в четверг, а в
   * записи оказалось другое. Ровно тот случай, ради которого карточка
   * существует, — и проверка читает её так же, как читал бы человек,
   * разбирающий жалобу.
   */
  await seeded.update(batches).set({ combinedText: 'надо записать сына к врачу в четверг' });

  await seeded.insert(items).values({
    userId: person.id,
    sourceBatchId: batch.id,
    text: 'Записать сына к врачу',
    type: 'TASK',
    priority: 'SOON',
    topic: 'семья',
  });

  /**
   * Ещё девять человек — для рассылки (задача 4.10).
   *
   * Десяти хватает, чтобы рассылка успела побыть «идущей»: при темпе
   * пять в секунду это две секунды, и кнопку «Остановить» можно
   * нажать не спеша.
   */
  await seeded.insert(users).values(
    Array.from({ length: 9 }, (_, index) => ({
      tgId: 90_100 + index,
      firstName: `человек-${String(index + 1)}`,
    })),
  );

  /**
   * Оплаченная подписка — для выручки и статуса в списке (задача 4.2).
   *
   * У Ани, а не у отдельного человека: колонка «Подписка» проверяется в
   * её строке, и заводить для этого одиннадцатого человека значило бы
   * сдвинуть числа в рассылке и в расходах.
   *
   * Счёт **оплаченный**: выручка считается по оплаченным, и выставленный
   * счёт в неё попасть не должен.
   */
  const [paidInvoice] = await seeded
    .insert(billingInvoices)
    .values({
      provider: 'robokassa:smz',
      userId: person.id,
      plan: 'monthly',
      kind: 'initial',
      amountMinor: 39_900,
      currency: 'RUB',
      ref: 'стенд-оплачен',
      status: 'paid',
      autoRenew: true,
      paidAt: new Date(),
    })
    .returning({ id: billingInvoices.id });

  if (paidInvoice === undefined) throw new Error('стенд: счёт не создался');

  // Брошенный счёт: в выручку он попасть не должен.
  await seeded.insert(billingInvoices).values({
    provider: 'robokassa:smz',
    userId: person.id,
    plan: 'yearly',
    kind: 'initial',
    amountMinor: 399_000,
    currency: 'RUB',
    ref: 'стенд-брошен',
    autoRenew: true,
  });

  await seeded.insert(billingSubscriptions).values({
    provider: 'robokassa:smz',
    userId: person.id,
    plan: 'monthly',
    autoRenew: true,
    currentPeriodEnd: new Date('2027-01-15T10:00:00.000Z'),
  });

  /**
   * Сорвавшийся разбор — для журнала ошибок (задача 4.10).
   *
   * Ровно то, что журнал существует показывать: человек сказал мысль
   * и не получил ответа. Кнопка «Перезапустить» возвращает её в
   * очередь — исполнение обещания из §17.
   *
   * **У отдельного человека, а не у Ани.** Её карточка проверяется
   * по одной выгрузке (задача 4.6), и вторая сбила бы ту проверку:
   * посев стенда — общий, и добавленное для одного раздела не должно
   * ломать другой.
   */
  const [unlucky] = await seeded
    .insert(users)
    .values({ tgId: 90_002, firstName: 'Оля' })
    .returning({ id: users.id });

  if (unlucky === undefined) throw new Error('стенд: второй человек не создался');

  await seeded.insert(batches).values({
    userId: unlucky.id,
    status: 'failed',
    attempts: 3,
    error: 'TransientSpeechError: распознавание не ответило',
    combinedText: 'надо купить корм коту',
  });

  /**
   * Неуспешный вызов модели — вторая половина журнала.
   *
   * **Цена ноль, а не пусто, и человек тот же, что у расходов.** 429
   * не тарифится — ноль здесь правда. Но не только: пустая цена
   * сделала бы отчёт о расходах неполным («суммы — нижняя граница»), а
   * новый человек в учёте поделил бы средний расход надвое. Посев
   * стенда общий, и добавленное для одного раздела не должно менять
   * числа в другом.
   */
  await seeded.insert(aiCalls).values({
    userId: person.id,
    stage: 'classifier',
    model: 'yandex:yandexgpt/latest',
    promptVersion: 'classifier@9',
    costMicros: 0,
    costCurrency: 'rub',
    latencyMs: 4_000,
    ok: false,
    error: '429 Too Many Requests',
  });

  /** Числа круглые нарочно: проверка читает их глазами, как человек. */
  await seeded.insert(aiCalls).values([
    {
      userId: person.id,
      batchId: batch.id,
      stage: 'router',
      model: 'yandex:yandexgpt-lite/latest',
      costMicros: 2_000_000,
      costCurrency: 'rub',
      latencyMs: 100,
      ok: true,
    },
    {
      userId: person.id,
      batchId: batch.id,
      stage: 'classifier',
      model: 'yandex:yandexgpt/latest',
      // Версия промпта — то, без чего жалобу не разобрать: промпт
      // меняется без выкладки (§15), и к моменту жалобы он уже другой.
      promptVersion: 'classifier@9',
      costMicros: 8_000_000,
      costCurrency: 'rub',
      latencyMs: 200,
      ok: true,
    },
  ]);
}

/**
 * Контрольный набор для раздела промптов (задача 4.8).
 *
 * Настоящий прогон ходит к живой модели по всему набору и стоит денег;
 * запускать его на каждой браузерной проверке нельзя. Поэтому здесь
 * подставляется заглушка, которая делает ровно то, что проверяется в
 * панели: пишет отчёт на **той версии, которую попросили измерить**.
 *
 * Так проверка проходит весь путь целиком — правка, прогон, включение,
 * откат, — и заслон §10.3 в ней настоящий: без отчёта включение
 * отказывает, с отчётом проходит.
 */
const evalDir = process.env['ADMIN_E2E_EVAL_DIR'] ?? join(tmpdir(), 'vydoh-admin-e2e-eval');

let evalRunner;

if (seeded !== undefined) {
  await rm(evalDir, { recursive: true, force: true });
  await mkdir(join(evalDir, 'runs'), { recursive: true });

  await seeded.delete(promptVersions);

  await seedPrompt(seeded, {
    stage: 'classifier',
    version: 'classifier@1',
    prompt: 'Разбери сказанное на отдельные мысли.',
    schemaName: CLASSIFIER_SCHEMA_NAME,
  });

  await seedPrompt(seeded, {
    stage: 'classifier',
    version: 'classifier@2',
    prompt: 'Разбери сказанное на отдельные мысли, аккуратнее со сроками.',
    schemaName: CLASSIFIER_SCHEMA_NAME,
  });

  await activatePrompt(seeded, 'classifier', 'classifier@1');

  /** Отчёт на том, что включено: страница должна открыться спокойной. */
  await writeFile(
    join(evalDir, 'runs', '2026-09-01T00-00-00-000Z.json'),
    JSON.stringify(passingReport({ classifier: `classifier@1` })),
    'utf8',
  );

  /**
   * Заглушка прогона вместо настоящего: он стоит денег.
   *
   * Отдельным файлом рядом с проверками, а не строкой в `-e`: строку
   * пришлось бы экранировать, а прогон запускается **без** оболочки —
   * нарочно, см. пояснение в `eval-run.ts`.
   */
  const stub =
    process.env['ADMIN_E2E_EVAL_STUB'] ?? join(here, '../../../../tests/admin/eval-stub.mjs');

  evalRunner = createEvalRunner({
    evalDir,
    command: [process.execPath, stub, evalDir],
  });
}

/**
 * Рассылка на стенде: без очереди и без Telegram (задача 4.10).
 *
 * Настоящая рассылка ходит в Telegram и живёт в очереди BullMQ.
 * Браузерной проверке не нужно ни то, ни другое: ей нужно, чтобы
 * предпросмотр показал число, подтверждение запустило отправку, а
 * кнопка «Остановить» её остановила. Всё это — настоящий код рассылки;
 * подменены только отправка и очередь.
 *
 * **Отправка нарочно медленная.** Рассылка на стенде должна успеть
 * побыть «идущей», иначе кнопку «Остановить» не нажать: она исчезает
 * вместе с завершением. Двести миллисекунд на письмо — темп пять в
 * секунду, и десяток адресатов даёт две секунды на нажатие.
 */
const broadcastPace = Number(process.env['ADMIN_E2E_BROADCAST_PER_SECOND'] ?? '5');

let broadcasting: Promise<void> = Promise.resolve();

function runBroadcast(broadcastId: string): Promise<void> {
  if (seeded === undefined) return Promise.resolve();
  const db = seeded;

  /**
   * Заходы идут один за другим — как воркер с одновременностью 1.
   *
   * Иначе две нажатые кнопки дали бы два потока отправки, и стенд
   * перестал бы походить на бой именно там, где это важно.
   */
  broadcasting = broadcasting.then(async () => {
    let step = await sendChunk(
      { db, sender: standSender, perSecond: broadcastPace, chunk: 5 },
      broadcastId,
    );

    while (step.more && !step.stopped) {
      step = await sendChunk(
        { db, sender: standSender, perSecond: broadcastPace, chunk: 5 },
        broadcastId,
      );
    }
  });

  return Promise.resolve();
}

/** Куда «уходят» письма стенда. Проверка их не читает — важен факт. */
const sent: number[] = [];

const standSender: BroadcastSender = {
  send: async ({ tgId }) => {
    sent.push(tgId);
    await Promise.resolve();
  },
};

const app = createServer({
  healthChecks: [],
  adminStaticDir: dist,
  ...(seeded === undefined
    ? {}
    : {
        adminDb: seeded,
        /**
         * Реестр значений без кэша (задача 4.9).
         *
         * Ноль, а не минута: проверка сохраняет значение и сразу читает
         * его обратно. С кэшем она ждала бы истечения и врала бы про
         * «применяется сразу» — панель на боевом сбрасывает кэш сама
         * после записи, и это проверено интеграционным тестом.
         */
        adminSettings: new SettingsRegistry({ db: seeded, ttlMs: 0 }),
        adminEvalDir: evalDir,
        ...(evalRunner === undefined ? {} : { adminEvalRunner: evalRunner }),
        adminEnqueueBroadcast: runBroadcast,
        /**
         * Перезапуск разбора на стенде ничего не разбирает.
         *
         * Разбор ходит к модели за деньги. Проверяется здесь другое:
         * что кнопка вернула выгрузку в очередь и панель это
         * показала, — а это делает сам `restartBatch`.
         */
        adminEnqueueUser: async () => {
          await Promise.resolve();
        },
      }),
  admin: {
    login: LOGIN,
    passwordHash: await hashPassword(PASSWORD),
    totpSecret: TOTP_SECRET,
    sessionSecret: 'секрет-подписи-для-сквозной-проверки-панели',
    // Стенд без сертификата: с `secure` браузер печенье не сохранит.
    secureCookies: false,
  },
});

app.listen(PORT, '127.0.0.1', () => {
  // Строка нужна Playwright: он ждёт готовности адреса, а не этой
  // печати, но человеку, запустившему стенд руками, она полезна.
  process.stdout.write(
    `Стенд панели: http://127.0.0.1:${String(PORT)}/admin/${String.fromCharCode(10)}`,
  );
});

/** Отчёт прогона, проходящий порог, на заданных версиях. */
function passingReport(versions: Record<string, string>): Record<string, unknown> {
  return {
    expected: 40,
    found: 40,
    missed: 0,
    extra: 0,
    typeCorrect: 40,
    priorityCorrect: 40,
    topicCorrect: 40,
    recurrenceCorrect: 40,
    projectCorrect: 40,
    projectChecked: 40,
    deadlineCorrect: 40,
    falseDeadlines: 0,
    falseTasksFromDesires: 0,
    falseTasksFromEmotions: 0,
    retractedKept: 0,
    crisisExpected: 0,
    crisisDetected: 0,
    crisisFalse: 0,
    crisisMissed: 0,
    failed: 0,
    ambiguous: 0,
    cases: 10,
    promptVersions: versions,
  };
}
