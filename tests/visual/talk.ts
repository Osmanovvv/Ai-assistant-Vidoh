import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { chromium, type Page } from '@playwright/test';

/**
 * Разговор с боевым ботом через настоящий Telegram (задача 3.31).
 *
 * **Зачем, если есть сквозной прогон.** Сквозной поднимает своего бота с
 * заглушкой вместо Telegram — там не видно ни раскладки кнопок, ни ветвей,
 * ни того, как реплика выглядит человеку. Ровно там и жили дефекты, за
 * которые было стыдно: обрезанные подписи, затёртое подтверждение, пустая
 * ветка «здоровье». Здесь настоящий клиент и настоящий бот.
 *
 * **Пишет в живой аккаунт и живую базу.** Это не песочница: записи
 * появляются у человека по-настоящему. Прогон рассчитан на то, что за ним
 * приберут — сам он ничего не удаляет, потому что удалять чужое молча
 * нельзя.
 *
 * Сессия берётся из `.data/visual/session.json` — её кладёт
 * `npm run visual:login`. Файл сессии это доступ к аккаунту, обращаться с
 * ним надо как с паролем.
 *
 * Запуск:
 *   npx tsx tests/visual/talk.ts "текст сообщения"
 *   npx tsx tests/visual/talk.ts --scenario ./путь-к-сценарию.json
 *
 * Без аргументов — только читает последнюю реплику и уходит.
 */

const SESSION = process.env['VISUAL_SESSION'] ?? '.data/visual/session.json';
const BOT = process.env['VISUAL_BOT'] ?? 'aividoh_bot';
const SHOTS = process.env['VISUAL_SHOTS'] ?? join('docs', 'visual');
const BASE = process.env['VISUAL_BASE_URL'] ?? 'https://web.telegram.org/k/';

/** Сколько ждать ответа бота: разбор идёт через модель и небыстр. */
const REPLY_TIMEOUT_MS = Number(process.env['VISUAL_REPLY_MS'] ?? 180_000);

/** Окно склейки выгрузки — 30 секунд, значит ответа раньше не будет. */
const SILENCE_MS = 32_000;

interface Reply {
  /** Текст последней реплики бота. */
  readonly text: string;
  /** Кнопки под ней — **строками**, а не одним списком. */
  readonly rows: readonly (readonly string[])[];
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Реплики бота и кнопки под последней — прямо из страницы.
 *
 * Селекторы Telegram Web живут в одном месте и снабжены запасными: их
 * классы меняются с релизами, и разбираться придётся здесь, а не по всему
 * сценарию.
 */
/**
 * Читалка страницы — **строкой, а не функцией**, и это не причуда.
 *
 * `tsx` переписывает вложенные стрелки и подставляет свой помощник
 * `__name`, которого в браузере нет: первый же запуск упал на
 * `ReferenceError: __name is not defined`. Строка уезжает в страницу как
 * есть, мимо транспиляции.
 *
 * Селекторы Telegram Web собраны здесь одним куском со запасными путями:
 * их классы меняются с релизами, и разбираться придётся в одном месте.
 */
const READ_CHAT = `(() => {
  var textOf = function (node) {
    if (!node) return '';
    var body = node.querySelector('.message');
    var raw = ((body || node).textContent || '').trim();
    // Telegram дописывает время в тот же узел: «…Ленке09:0009:00».
    return raw.replace(/(?:[0-9]{1,2}:[0-9]{2})+$/, '').trim();
  };

  var labelsIn = function (node) {
    return Array.prototype.slice
      .call(node.querySelectorAll('button, .reply-markup-button'))
      .map(function (button) { return (button.textContent || '').trim(); })
      .filter(function (label) { return label.length > 0; });
  };

  var rowsOf = function (node) {
    if (!node) return [];

    var rows = Array.prototype.slice.call(node.querySelectorAll('.reply-markup-row'));
    if (rows.length > 0) return rows.map(labelsIn);

    var flat = labelsIn(node);
    return flat.length > 0 ? [flat] : [];
  };

  var incoming = Array.prototype.slice
    .call(document.querySelectorAll('.bubble'))
    .filter(function (one) { return one.classList.contains('is-in'); });

  var last = incoming[incoming.length - 1];
  var own = rowsOf(last);

  return {
    text: textOf(last),
    rows: own.length > 0 ? own : rowsOf(last ? last.parentElement : null),
    seen: incoming.length,
  };
})()`;

async function readChat(page: Page): Promise<Reply> {
  const raw: unknown = await page.evaluate(READ_CHAT);
  const shape = raw as { text?: unknown; rows?: unknown };

  return {
    text: typeof shape.text === 'string' ? shape.text : '',
    rows: Array.isArray(shape.rows) ? (shape.rows as readonly (readonly string[])[]) : [],
  };
}

/**
 * Ждёт, пока в чате появится непустая реплика.
 *
 * Без этого чтение сразу после открытия возвращало пустоту: список
 * сообщений Telegram рисует не мгновенно, и первый же запуск это поймал.
 */
async function readSettled(page: Page): Promise<Reply> {
  for (let attempt = 0; attempt < 15; attempt++) {
    const reply = await readChat(page);
    if (reply.text.length > 0) return reply;
    await page.waitForTimeout(1000);
  }

  return await readChat(page);
}

async function openChat(page: Page): Promise<void> {
  await page.goto(`${BASE}#@${BOT}`);
  await page.waitForLoadState('domcontentloaded');

  const composer = page.locator('[contenteditable="true"]').first();
  const loginScreen = page.getByText('Log in by QR Code', { exact: false }).first();

  await Promise.race([
    composer.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => undefined),
    loginScreen.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => undefined),
  ]);

  if (await loginScreen.isVisible()) {
    throw new Error(
      [
        'Сессия Telegram истекла: на экране форма входа.',
        'Выполни вход заново: npm run visual:login (QR со своего телефона).',
      ].join(String.fromCharCode(10)),
    );
  }

  if (!(await composer.isVisible())) {
    throw new Error(`Не открылась переписка с @${BOT}`);
  }
}

/** Отправляет текст и ждёт, пока бот ответит чем-то новым. */
async function send(page: Page, text: string): Promise<Reply> {
  const before = await readSettled(page);

  const composer = page.locator('[contenteditable="true"]').first();
  await composer.click();
  await composer.fill('');
  await composer.pressSequentially(text, { delay: 10 });
  await page.keyboard.press('Enter');

  say(`  → ${text}`);

  /**
   * Ждём именно **новую** реплику, а не любую.
   *
   * Сравнение с прежним текстом надёжнее ожидания числа сообщений:
   * статусное сообщение бот **правит**, и число не меняется, а текст —
   * меняется. На этом и держится вся проверка «правка или новое
   * сообщение».
   */
  /**
   * Сперва выждать окно склейки, и только потом верить прочитанному.
   *
   * Первый запуск вернул «Слушаю.» и решил, что это ответ: бот
   * подтверждает приём сразу, а разбор дописывает в **то же** сообщение
   * минутой позже. Любая проверка, читающая раньше, мерит статус, а не
   * ответ.
   */
  await page.waitForTimeout(SILENCE_MS + 8000);

  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  let stable = await readChat(page);
  let sameTimes = 0;

  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    const now = await readChat(page);

    if (now.text === stable.text && now.text !== before.text && now.text.length > 0) {
      sameTimes += 1;
      // Три совпадения подряд: текст перестал меняться, разбор дописан.
      if (sameTimes >= 3) return now;
      continue;
    }

    stable = now;
    sameTimes = 0;
  }

  // Молчание тоже результат: пусть будет видно, что ответа не дождались.
  return { text: '(бот не ответил за отведённое время)', rows: [] };
}

function show(reply: Reply): void {
  say('');
  for (const line of reply.text.split('\n')) say(`  │ ${line}`);
  if (reply.rows.length > 0) {
    say('');
    for (const row of reply.rows) say(`  [ ${row.join(' ] [ ')} ]`);
  }
  say('');
}

// ── Прогон ────────────────────────────────────────────────────────────────

if (!existsSync(SESSION)) {
  say(`Нет сохранённой сессии: ${SESSION}`);
  say('Сначала выполни вход: npm run visual:login');
  process.exit(1);
}

const messages = process.argv.slice(2).filter((one) => one.trim().length > 0);

const browser = await chromium.launch({ headless: process.env['VISUAL_HEADED'] !== '1' });
const context = await browser.newContext({
  storageState: SESSION,
  locale: 'ru-RU',
  timezoneId: 'Europe/Moscow',
  viewport: { width: 420, height: 900 },
});
const page = await context.newPage();

try {
  await openChat(page);
  say(`Переписка с @${BOT} открыта.`);

  if (messages.length === 0) {
    say('Сообщений не задано — читаю последнюю реплику.');
    show(await readSettled(page));
  }

  for (const message of messages) {
    show(await send(page, message));
  }

  await mkdir(SHOTS, { recursive: true });
  const shot = join(SHOTS, 'talk.png');
  await page.screenshot({ path: shot, fullPage: false });
  say(`Снимок: ${shot}`);
} finally {
  await browser.close();
}
