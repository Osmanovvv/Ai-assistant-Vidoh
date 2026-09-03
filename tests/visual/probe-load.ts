import { chromium } from '@playwright/test';

/**
 * Зонд загрузки Telegram Web: чистый контекст против сохранённого сеанса.
 * Нужен, когда драйвер не открывает переписку: отличить сеть от
 * испорченного состояния сеанса.
 */
const SESSION = process.env['VISUAL_SESSION'] ?? '.data/visual/session.json';
const URL = 'https://web.telegram.org/k/';

async function probe(label: string, storageState?: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(storageState === undefined ? {} : { storageState });
  const page = await context.newPage();
  const started = Date.now();
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const dom = Date.now() - started;
    const composer = page.locator('[contenteditable="true"]').first();
    const login = page.getByText('Log in by QR Code', { exact: false }).first();
    const seen = await Promise.race([
      composer.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'поле ввода'),
      login.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'форма входа'),
    ]).catch(() => 'ничего за минуту');
    process.stdout.write(
      `${label}: DOM за ${String(dom)} мс, дальше — ${seen} (${String(Date.now() - started)} мс)\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${label}: не загрузилось за ${String(Date.now() - started)} мс — ${String(error).split('\n')[0] ?? ''}\n`,
    );
  } finally {
    await browser.close();
  }
}

await probe('чистый контекст');
await probe('сохранённый сеанс', SESSION);
