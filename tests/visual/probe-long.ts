import { chromium } from '@playwright/test';
const SESSION = '.data/visual/session.json';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: SESSION, locale: 'ru-RU', timezoneId: 'Europe/Moscow', viewport: { width: 360, height: 780 } });
const page = await context.newPage();
const started = Date.now();
await page.goto('https://web.telegram.org/k/#@aividoh_bot', { waitUntil: 'domcontentloaded', timeout: 120_000 }).catch((e: unknown) => process.stdout.write(`goto: ${String(e).split('\n')[0] ?? ''}\n`));
const composer = page.locator('[contenteditable="true"]').first();
for (let i = 0; i < 30; i++) {
  if (await composer.isVisible()) { process.stdout.write(`поле ввода появилось через ${String(Math.round((Date.now() - started) / 1000))} с\n`); break; }
  await page.waitForTimeout(10_000);
  if (i % 6 === 5) process.stdout.write(`… ${String(Math.round((Date.now() - started) / 1000))} с, ещё нет\n`);
}
await page.screenshot({ path: 'docs/visual/probe-long.png' });
await browser.close();
