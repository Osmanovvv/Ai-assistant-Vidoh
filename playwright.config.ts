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

/**
 * Проверок две, и они устроены по-разному (задачи 2.24 и 4.5).
 *
 * `visual` работает в **чужом** интерфейсе — Telegram Web, — с живым
 * аккаунтом и сохранённой заранее сессией. Гоняется перед приёмкой.
 *
 * `admin` работает в **нашей** панели на своём стенде: поднимается тот
 * же сервер, что в бою, ничего живого не нужно, коды предсказуемы.
 * Значит её можно и нужно гонять на каждый коммит — в отличие от
 * первой, которая краснеет от релизов Telegram.
 */
export default defineConfig({
  projects: [
    {
      name: 'admin',
      testDir: 'tests/admin',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env['ADMIN_E2E_URL'] ?? 'http://127.0.0.1:3100',
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
        // Пропуск живёт в печенье: сессия между проверками не должна
        // протекать, иначе «неверный пароль» пройдёт на уже вошедшем.
        storageState: { cookies: [], origins: [] },
      },
    },
    {
      name: 'visual',
      testDir: 'tests/visual',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env['VISUAL_BASE_URL'] ?? 'https://web.telegram.org/k/',
        storageState: SESSION,
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
      },
    },
  ],

  /**
   * Стенд панели поднимается сам.
   *
   * `reuseExistingServer` в разработке: перезапуск сервера на каждый
   * прогон стоит секунд, а поднятый руками стенд удобно держать открытым.
   * В CI — всегда свой, чтобы прогон не зависел от чужого состояния.
   */
  webServer: {
    command: 'npm run build --workspace @vydoh/admin && npm run admin:e2e --workspace @vydoh/bot',
    /**
     * Своя база для стенда, и только своя.
     *
     * Стенд чистит таблицу учёта перед посевом: адрес задаётся отдельной
     * переменной нарочно, чтобы никакая общая настройка не привела его к
     * боевой базе.
     */
    env: {
      ADMIN_E2E_DATABASE_URL:
        process.env['ADMIN_E2E_DATABASE_URL'] ??
        'postgres://vydoh:vydoh@localhost:5434/vydoh_admin_e2e',
    },
    url: 'http://127.0.0.1:3100/admin/',
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },

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
    // Скриншоты и трасса — приложение к приёмке: §21 требует показать,
    // как это выглядит, а не утверждать, что выглядит хорошо.
    screenshot: 'on',
    trace: 'retain-on-failure',
    video: 'off',
  },
});
