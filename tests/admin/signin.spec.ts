import { createHmac } from 'node:crypto';

import { expect, test } from '@playwright/test';

/**
 * Вход в панель глазами человека (§15 ТЗ, задача 4.5).
 *
 * План просит именно Playwright и именно на три случая: вход, неверный
 * пароль, второй шаг. Проверка «API без пропуска ничего не отдаёт»
 * живёт отдельно и на уровне сервера — там её сорок четыре штуки.
 *
 * **Здесь проверяется то, чего не видно из API:** что два шага человек
 * действительно проходит как два, что отказ выглядит отказом, а не
 * пустым экраном, и что после входа он оказывается в панели. Ошибка в
 * этом месте не ломает ни один серверный тест — окно входа просто
 * перестаёт работать.
 *
 * Стенд поднимает `playwright.config.ts`: тот же сервер, что в бою, с
 * секретом кодов из RFC 6238 — поэтому код здесь считается, а не
 * вводится наугад.
 */

/** Секрет стенда — тот же, что в `admin-e2e-server.ts`. */
const SECRET = Buffer.from('12345678901234567890', 'ascii');

const LOGIN = 'аня';
const PASSWORD = 'очень-длинный-пароль-42';

/**
 * Код на текущую секунду.
 *
 * Считается здесь, а не берётся из кода панели: проверка не должна
 * зависеть от того, что проверяет. Если алгоритм в панели однажды
 * разойдётся со стандартом, эта проверка покраснеет — а взяв её
 * реализацию оттуда же, она осталась бы зелёной.
 */
function currentCode(): string {
  const step = Math.floor(Date.now() / 1000 / 30);

  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step % 2 ** 32, 4);

  const digest = createHmac('sha1', SECRET).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const slice =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return String(slice % 1_000_000).padStart(6, '0');
}

test.describe('окно входа', () => {
  test('открывается и просит логин с паролем, а не код сразу', async ({ page }) => {
    await page.goto('/admin/');

    await expect(page.getByRole('heading', { name: 'ВЫДОХ' })).toBeVisible();
    await expect(page.getByText('Панель управления')).toBeVisible();
    await expect(page.locator('input[name="login"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();

    // Кода на первом шаге быть не должно: шаги идут по одному.
    await expect(page.locator('input[name="code"]')).toHaveCount(0);
  });

  test('неверный пароль — отказ, и панель не открывается', async ({ page }) => {
    await page.goto('/admin/');

    await page.locator('input[name="login"]').fill(LOGIN);
    await page.locator('input[name="password"]').fill('не тот пароль');
    await page.getByRole('button', { name: 'Дальше' }).click();

    await expect(page.getByRole('alert')).toHaveText('Не получилось войти');

    // Остались на первом шаге: ни кода, ни панели.
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.locator('input[name="code"]')).toHaveCount(0);
    await expect(page.getByText('ВЫДОХ — панель')).toHaveCount(0);
  });

  test('верный пароль ведёт на второй шаг, но панель ещё закрыта', async ({ page }) => {
    /**
     * Главное свойство §15 глазами человека: пароль сошёлся, а панели
     * нет — есть поле для кода. Если бы после пароля открывалась панель,
     * шагов было бы не два, а один.
     */
    await page.goto('/admin/');

    await page.locator('input[name="login"]').fill(LOGIN);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Дальше' }).click();

    await expect(page.getByText('Код из приложения')).toBeVisible();
    await expect(page.locator('input[name="code"]')).toBeVisible();
    await expect(page.getByText('ВЫДОХ — панель')).toHaveCount(0);
  });

  test('неверный код на втором шаге тоже не пускает', async ({ page }) => {
    await page.goto('/admin/');

    await page.locator('input[name="login"]').fill(LOGIN);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Дальше' }).click();

    await page.locator('input[name="code"]').fill('000000');
    await page.getByRole('button', { name: 'Войти' }).click();

    await expect(page.getByRole('alert')).toHaveText('Не получилось войти');
    await expect(page.getByText('ВЫДОХ — панель')).toHaveCount(0);
  });

  test('код открывает панель, и в ней видно, кто вошёл', async ({ page }) => {
    await page.goto('/admin/');

    await page.locator('input[name="login"]').fill(LOGIN);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Дальше' }).click();

    await page.locator('input[name="code"]').fill(currentCode());
    await page.getByRole('button', { name: 'Войти' }).click();

    await expect(page.getByText('ВЫДОХ — панель')).toBeVisible();
    await expect(page.getByText(LOGIN, { exact: false })).toBeVisible();
  });

  test('«Начать заново» возвращает к паролю, а не запирает', async ({ page }) => {
    // Приложение с кодом может оказаться на другом телефоне: тупик без
    // выхода — худшее, что можно сделать с окном входа.
    await page.goto('/admin/');

    await page.locator('input[name="login"]').fill(LOGIN);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Дальше' }).click();

    await expect(page.locator('input[name="code"]')).toBeVisible();
    await page.getByRole('button', { name: 'Начать заново' }).click();

    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.locator('input[name="code"]')).toHaveCount(0);
  });

  test('после выхода панель снова просит вход', async ({ page }) => {
    await page.goto('/admin/');

    await page.locator('input[name="login"]').fill(LOGIN);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Дальше' }).click();
    await page.locator('input[name="code"]').fill(currentCode());
    await page.getByRole('button', { name: 'Войти' }).click();

    await expect(page.getByText('ВЫДОХ — панель')).toBeVisible();
    await page.getByRole('button', { name: 'выйти' }).click();

    await expect(page.locator('input[name="password"]')).toBeVisible();
  });
});

test.describe('панель закрыта от индексации (§15)', () => {
  test('robots.txt запрещает раздел, а страница несёт мета-запрет', async ({ page, request }) => {
    const robots = await request.get('/robots.txt');
    expect(await robots.text()).toContain('Disallow: /admin');

    await page.goto('/admin/');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/u);
  });
});

test.describe('палитра из §12.4', () => {
  test('фон и основной акцент — те, что задал брендбук', async ({ page }) => {
    /**
     * §12.4 задаёт палитру дословно, и она общая для панели, лендинга и
     * графики. Проверка на цвет — не придирка: панель, покрашенная «на
     * глаз», выглядит чужой продукту, а заметить это по коду нельзя.
     */
    await page.goto('/admin/');

    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).toBe('rgb(247, 243, 239)');

    const button = await page
      .getByRole('button', { name: 'Дальше' })
      .evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(button).toBe('rgb(107, 78, 78)');
  });
});
