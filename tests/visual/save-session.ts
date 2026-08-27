import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { chromium } from '@playwright/test';

/**
 * Разовый вход в Telegram Web с сохранением сессии (задача 2.24).
 *
 * Запуск:
 *   npm run visual:login
 *
 * Открывается настоящее окно браузера. Человек входит своим тестовым
 * аккаунтом сам — проще всего по QR-коду с телефона, тогда вводить
 * вообще ничего не нужно. **Вход делает человек, а не мы:**
 * автоматизировать вход в чужой аккаунт нельзя, да и незачем — сессия
 * сохраняется один раз и живёт месяцами.
 *
 * Нажимать ничего не надо: сценарий сам замечает вход и сохраняет
 * состояние браузера в файл. Так пришлось сделать после 27.08.2026:
 * команду запустили кнопкой из интерфейса, где ввода в терминал нет, и
 * ожидание Enter сделало вход бесполезным.
 *
 * **Файл сессии — это доступ к аккаунту.** Он лежит в `.data`, которая не
 * входит в репозиторий, и обращаться с ним надо как с паролем.
 */

const SESSION = process.env['VISUAL_SESSION'] ?? '.data/visual/session.json';
const URL = process.env['VISUAL_BASE_URL'] ?? 'https://web.telegram.org/k/';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
const page = await context.newPage();

await page.goto(URL);

process.stdout.write(
  [
    '',
    'Открыто окно Telegram Web.',
    '',
    '  1. Войди тестовым аккаунтом. Проще всего по QR: открой Telegram на',
    '     телефоне, Настройки → Устройства → Подключить устройство и наведи',
    '     камеру на код в окне. Ввод номера и кода из SMS — запасной путь.',
    '  2. Всё. Нажимать ничего не надо: как только вход случится, сессия',
    '     сохранится сама, и окно закроется.',
    '',
    'Файл сессии — это доступ к аккаунту. Он вне репозитория, и обращаться',
    'с ним надо как с паролем.',
    '',
    'Жду входа…',
    '',
  ].join('\n'),
);

/**
 * Признак входа — ключ авторизации в хранилище страницы.
 *
 * Не текст на экране: он зависит от языка интерфейса и от версии клиента,
 * а ключ ставит сам Telegram Web ровно в момент, когда сессия появилась.
 *
 * Ожидание вместо «нажми Enter» — не украшение. Команду запускают из
 * кнопки в интерфейсе, где ввода в терминал нет вовсе: человек входит,
 * а сохранить сессию нечем. На этом и споткнулись 27.08.2026.
 */
async function loggedIn(): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.includes('user_auth') || key.includes('dc1_auth_key')) return true;
      }
      return false;
    });
  } catch {
    // Страница перезагружается после входа — это не ошибка, это ожидание.
    return false;
  }
}

const WAIT_MINUTES = 5;
let saved = false;

for (let second = 0; second < WAIT_MINUTES * 60; second++) {
  if (await loggedIn()) {
    // Небольшая пауза: Telegram дописывает ключи в хранилище не мгновенно.
    await page.waitForTimeout(3000);

    await mkdir(dirname(SESSION), { recursive: true });
    await context.storageState({ path: SESSION });

    process.stdout.write(`
Вход есть, сессия сохранена: ${SESSION}
`);
    saved = true;
    break;
  }

  await page.waitForTimeout(1000);
}

if (!saved) {
  process.stdout.write(
    `
Вход так и не случился за ${String(WAIT_MINUTES)} минут. Окно закрываю, попробуй ещё раз.
`,
  );
}

await browser.close();
process.exit(saved ? 0 : 1);
