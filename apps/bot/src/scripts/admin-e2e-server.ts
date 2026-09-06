import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword } from '../http/admin/password.js';
import { createServer } from '../http/server.js';

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

const app = createServer({
  healthChecks: [],
  adminStaticDir: dist,
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
