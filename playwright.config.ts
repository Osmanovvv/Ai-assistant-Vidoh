import { defineConfig, devices } from '@playwright/test';

/**
 * Визуальная проверка тем в Telegram Web (задача 2.24).
 *
 * Проверяет то единственное, что не видно ни через API, ни через GramJS:
 * как ветки тем и закреплённые сводки выглядят живому человеку.
 *
 * **Гоняется перед приёмкой этапа, а не на каждый коммит.** Это чужой
 * фронтенд: Telegram меняет разметку своими релизами, и красный прогон
 * означал бы «у них релиз», а не «у нас поломка». Тест, который краснеет
 * не по делу, приучает не смотреть на красное — а это дороже, чем
 * отсутствие теста.
 *
 * **Сессия сохраняется заранее**, руками, один раз: вход в Telegram
 * требует кода из SMS, и автоматизировать его нельзя. Как — в рантбуке.
 */

const SESSION = process.env['VISUAL_SESSION'] ?? '.data/visual/session.json';

export default defineConfig({
  testDir: 'tests/visual',
  // Один за другим: тесты работают с одним живым аккаунтом Telegram, и
  // параллельные щелчки по одному интерфейсу мешали бы друг другу.
  workers: 1,
  fullyParallel: false,
  // Повторов нет намеренно. Упавший визуальный тест — это либо релиз
  // Telegram, либо наша поломка, и в обоих случаях надо смотреть глазами,
  // а не надеяться на вторую попытку.
  retries: 0,
  // Живой интерфейс грузится не мгновенно, а сообщения бота ждут своей
  // очереди в конвейере: минута на проверку — не щедрость, а реальность.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env['VISUAL_BASE_URL'] ?? 'https://web.telegram.org/k/',
    storageState: SESSION,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    // Скриншоты и трасса — приложение к приёмке: §21 требует показать,
    // как это выглядит, а не утверждать, что выглядит хорошо.
    screenshot: 'on',
    trace: 'retain-on-failure',
    video: 'off',
  },
});
