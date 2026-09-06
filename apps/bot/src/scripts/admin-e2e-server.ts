import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aiCalls, batches, users } from '../db/schema.js';
import { hashPassword } from '../http/admin/password.js';
import { createServer } from '../http/server.js';
import type { Database } from '../infra/db.js';
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

  await seeded.delete(aiCalls);
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
      costMicros: 8_000_000,
      costCurrency: 'rub',
      latencyMs: 200,
      ok: true,
    },
  ]);
}

const app = createServer({
  healthChecks: [],
  adminStaticDir: dist,
  ...(seeded === undefined ? {} : { adminDb: seeded }),
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
