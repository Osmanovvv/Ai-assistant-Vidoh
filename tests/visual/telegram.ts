import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { chromium, type Browser, type Page } from '@playwright/test';

/**
 * Работа с боевым ботом через настоящий Telegram Web (задача 3.31).
 *
 * Общая часть для двух сценариев: `talk.ts` — одна реплика из командной
 * строки, `walkthrough.ts` — приёмочный прогон целиком. Держать её в
 * одном месте пришлось после того, как оба начали расходиться в
 * ожиданиях: ловушки здесь такие, что второй раз на них наступать не
 * хочется.
 *
 * **Пишет в живой аккаунт и живую базу.** Записи появляются
 * по-настоящему. За собой надо прибирать — сами эти функции ничего не
 * удаляют, потому что удалять чужое молча нельзя.
 *
 * **Файл сессии — это доступ к аккаунту.** Лежит вне репозитория,
 * обращаться с ним надо как с паролем.
 */

export const SESSION = process.env['VISUAL_SESSION'] ?? '.data/visual/session.json';
export const BOT = process.env['VISUAL_BOT'] ?? 'aividoh_bot';
export const SHOTS = process.env['VISUAL_SHOTS'] ?? join('docs', 'visual');

const BASE = process.env['VISUAL_BASE_URL'] ?? 'https://web.telegram.org/k/';

/** Окно склейки выгрузки: раньше него разбора не будет (§9.1). */
export const SILENCE_MS = 32_000;

/** Сколько ждать разбор после закрытия выгрузки: он идёт через модель. */
const REPLY_TIMEOUT_MS = Number(process.env['VISUAL_REPLY_MS'] ?? 180_000);

/** Нажатие обрабатывается вне очереди выгрузок — ждать столько не нужно. */
const PRESS_TIMEOUT_MS = 60_000;

export interface Reply {
  /** Текст последней реплики бота. */
  readonly text: string;
  /** Кнопки под ней — **строками**, а не одним списком. */
  readonly rows: readonly (readonly string[])[];
}

/**
 * Читалка страницы — **строкой, а не функцией**, и это не причуда.
 *
 * `tsx` переписывает вложенные стрелки и подставляет свой помощник
 * `__name`, которого в браузере нет: первый же запуск упал на
 * `ReferenceError: __name is not defined`. Строка уезжает в страницу как
 * есть, мимо транспиляции.
 *
 * Селекторы Telegram Web собраны здесь одним куском: их классы меняются
 * с релизами, и разбираться придётся в одном месте.
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
      .call(node.querySelectorAll('.reply-markup-button, button'))
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
  };
})()`;

export async function readChat(page: Page): Promise<Reply> {
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
 * сообщений Telegram рисует не мгновенно.
 */
export async function readSettled(page: Page): Promise<Reply> {
  for (let attempt = 0; attempt < 15; attempt++) {
    const reply = await readChat(page);
    if (reply.text.length > 0) return reply;
    await page.waitForTimeout(1000);
  }

  return await readChat(page);
}

export async function openChat(page: Page): Promise<void> {
  /**
   * Ждём только разметку, а не полную загрузку: Telegram Web тянет
   * ресурсы долго и не всегда доводит `load` до конца — 03.09.2026 драйвер
   * дважды упал на этом, хотя переписка была на экране. Готовность
   * проверяется ниже по полю ввода, а не по событию страницы.
   */
  await page.goto(`${BASE}#@${BOT}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  const composer = page.locator('[contenteditable="true"]').first();
  const loginScreen = page.getByText('Log in by QR Code', { exact: false }).first();

  /**
   * Две минуты, а не сорок пять секунд. Снимок отказа 03.09.2026 показал
   * одни обои чата: страница ещё грузилась, ни поля ввода, ни формы
   * входа. Telegram Web в медленный час рисует список сообщений долго, и
   * ронять прогон раньше времени — значит путать медленную сеть с
   * поломкой.
   */
  await Promise.race([
    composer.waitFor({ state: 'visible', timeout: 120_000 }).catch(() => undefined),
    loginScreen.waitFor({ state: 'visible', timeout: 120_000 }).catch(() => undefined),
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
    // Снимок при отказе: без него непонятно, что именно было на экране —
    // пустая страница, другая раскладка или просьба войти заново.
    const failure = await shot(page, 'open-failed');
    throw new Error(`Не открылась переписка с @${BOT}. Снимок: ${failure}`);
  }
}

/**
 * Ждёт реплику, отличную от прежней, и дожидается, пока она перестанет
 * меняться.
 *
 * **Сперва выждать, потом верить.** Бот подтверждает приём сразу
 * («Слушаю.»), а разбор дописывает в **то же** сообщение минутой позже:
 * первый запуск принял статус за ответ. Поэтому сначала пауза, и только
 * потом три совпадения подряд.
 */
async function waitForReply(page: Page, before: Reply, settle: number): Promise<Reply> {
  await page.waitForTimeout(settle);

  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  let stable = await readChat(page);
  let sameTimes = 0;

  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    const now = await readChat(page);

    if (now.text === stable.text && now.text !== before.text && now.text.length > 0) {
      sameTimes += 1;
      if (sameTimes >= 3) return now;
      continue;
    }

    stable = now;
    sameTimes = 0;
  }

  return { text: '(бот не ответил за отведённое время)', rows: [] };
}

/**
 * Отправляет текст и ждёт разбор.
 *
 * **Команды через это не отправить, и это не наша недоделка.** При вводе
 * слэша Telegram Web открывает список команд, а Enter выбирает из него
 * **первую**, а не набранную. 03.09.2026 вместо `/menu` ушёл `/start` —
 * и проверка «команды проходят мимо потолка выгрузок» показала бы не то,
 * что проверяет. Такие вещи надёжнее проверять тестом на обработчике.
 */
export async function send(page: Page, text: string): Promise<Reply> {
  const before = await readSettled(page);

  const composer = page.locator('[contenteditable="true"]').first();
  await composer.click();
  await composer.fill('');
  await composer.pressSequentially(text, { delay: 8 });
  await page.keyboard.press('Enter');

  return await waitForReply(page, before, SILENCE_MS + 8000);
}

/**
 * Отправляет команду вроде `/menu` — в обход подсказки Telegram Web.
 *
 * Обычный `send` для команд не годится: при вводе слэша открывается
 * список команд, и Enter выбирает из него **первую**, а не набранную
 * (03.09.2026 вместо `/menu` ушёл `/start`). Escape закрывает список,
 * текст в поле остаётся, и Enter отправляет именно его.
 */
export async function sendCommand(page: Page, command: string): Promise<Reply> {
  const before = await readSettled(page);

  const composer = page.locator('[contenteditable="true"]').first();
  await composer.click();
  await composer.fill('');
  await composer.pressSequentially(command, { delay: 8 });
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');

  // Команда обрабатывается сразу, мимо окна склейки.
  const deadline = Date.now() + PRESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2500);
    const now = await readChat(page);
    if (now.text !== before.text && now.text.length > 0) return now;
  }

  return { text: '(бот не ответил на команду за отведённое время)', rows: [] };
}

/**
 * Нажимает кнопку по подписи и ждёт, что изменится.
 *
 * Нажатие идёт мимо очереди выгрузок, поэтому ждать окно склейки не надо
 * — но и мгновенного ответа тоже не бывает.
 */
export async function press(page: Page, label: string): Promise<Reply> {
  const before = await readSettled(page);

  /**
   * Подпись сверяется **целиком**, а не как подстрока. Иначе «Удалить»
   * находит и «Удалить мои данные» — 03.09.2026 прогон удаления нажал не
   * ту кнопку и сбился на шаг.
   */
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const exact = new RegExp(`^\\s*${escaped}\\s*$`, 'u');
  const button = page.locator('.reply-markup-button', { hasText: exact }).last();
  if ((await button.count()) === 0) {
    throw new Error(`Кнопки «${label}» нет на экране. Есть: ${before.rows.flat().join(', ')}`);
  }

  await button.click();

  const deadline = Date.now() + PRESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2500);
    const now = await readChat(page);
    if (now.text !== before.text || JSON.stringify(now.rows) !== JSON.stringify(before.rows)) {
      return now;
    }
  }

  return before;
}

export async function shot(page: Page, name: string): Promise<string> {
  await mkdir(SHOTS, { recursive: true });
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  return path;
}

export interface Session {
  readonly browser: Browser;
  readonly page: Page;
}

/** Поднимает браузер с сохранённой сессией и открывает переписку. */
export async function connect(): Promise<Session> {
  if (!existsSync(SESSION)) {
    throw new Error(
      [`Нет сохранённой сессии: ${SESSION}`, 'Сначала выполни вход: npm run visual:login'].join(
        String.fromCharCode(10),
      ),
    );
  }

  await mkdir(dirname(SESSION), { recursive: true });

  const browser = await chromium.launch({ headless: process.env['VISUAL_HEADED'] !== '1' });
  const context = await browser.newContext({
    storageState: SESSION,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    // Узкий телефон: ровно та ширина, на которой обрезались кнопки.
    viewport: { width: 360, height: 780 },
  });

  const page = await context.newPage();
  await openChat(page);

  return { browser, page };
}
