import { expect, test } from '@playwright/test';

import { signIn } from './panel.js';

/**
 * Плитка баланса Yandex Cloud (проджект, 21.09.2026: «сколько на балансе
 * щас»). Стенд отдаёт подменённое число 120,50 ₽ при пороге 300 — ниже
 * порога, чтобы видеть и тревогу. Сквозной путь: запрос → страница, в
 * обоих местах, где плитка стоит.
 */
test.describe('баланс Yandex Cloud в панели', () => {
  test('в обзоре, в блоке «Расходы», рядом с расходом на модели', async ({ page }) => {
    await signIn(page);

    const block = page.getByTestId('overview').locator('.блок', { hasText: 'Расходы' });
    const tile = block.getByTestId('yandex-balance');

    await expect(tile.locator('.итог__число')).toHaveText('120,50 ₽');
    await expect(tile).toHaveAttribute('data-low', 'true');
    await expect(tile).toContainText('ниже порога — пора пополнить');
    await expect(tile).toContainText('порог 300,00 ₽');
    await expect(tile).toContainText('обновлено');
  });

  test('в расходах — среди итогов', async ({ page }) => {
    await signIn(page, 'Расходы');

    const tile = page.getByTestId('costs').getByTestId('yandex-balance');

    await expect(tile.locator('.итог__число')).toHaveText('120,50 ₽');
  });

  test('без ключа плитка объясняет пустоту словами, а не молчит', async ({ page }) => {
    await page.route('**/admin/api/yandex-balance', async (route) => {
      await route.fulfill({ json: { configured: false } });
    });
    await signIn(page);

    const tile = page.getByTestId('overview').getByTestId('yandex-balance');

    await expect(tile.locator('.итог__число')).toHaveText('—');
    await expect(tile).toContainText('не настроено');
  });

  test('облако не ответило — прежнее число с пометкой «устарело»', async ({ page }) => {
    await page.route('**/admin/api/yandex-balance', async (route) => {
      await route.fulfill({
        json: {
          configured: true,
          ok: true,
          balanceRub: 1166.92,
          currency: 'RUB',
          accountName: 'account-788',
          thresholdRub: 300,
          low: false,
          fetchedAt: new Date(Date.now() - 25 * 60_000).toISOString(),
          stale: true,
          why: 'платёжные счета: облако ответило 503',
        },
      });
    });
    await signIn(page);

    const tile = page.getByTestId('overview').getByTestId('yandex-balance');

    await expect(tile.locator('.итог__число')).toHaveText('1 166,92 ₽');
    await expect(tile).toHaveAttribute('data-low', 'false');
    await expect(tile).toContainText('25 мин назад');
    await expect(tile).toContainText('устарело: платёжные счета: облако ответило 503');
  });
});
