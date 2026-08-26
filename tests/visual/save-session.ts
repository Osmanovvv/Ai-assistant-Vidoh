import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';

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
 * После входа возвращайся в терминал и нажми Enter: состояние браузера
 * ляжет в файл, и визуальные проверки смогут им пользоваться.
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
    '  2. Дождись, пока откроется список переписок.',
    `  3. Вернись сюда и нажми Enter — сессия сохранится в ${SESSION}.`,
    '',
    'Файл сессии — это доступ к аккаунту. Он вне репозитория, и обращаться',
    'с ним надо как с паролем.',
    '',
  ].join('\n'),
);

const input = createInterface({ input: process.stdin, output: process.stdout });
await input.question('Готово? Нажми Enter… ');
input.close();

await mkdir(dirname(SESSION), { recursive: true });
await context.storageState({ path: SESSION });

process.stdout.write(`\nСессия сохранена: ${SESSION}\n`);

await browser.close();
