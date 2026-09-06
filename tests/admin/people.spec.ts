import { expect, test } from '@playwright/test';

import { signIn } from './panel.js';

/**
 * Обзор, список людей и карточка (§15; задачи 4.6 и 4.12).
 *
 * Условие готовности 4.6 — «по жалобе „бот неправильно понял“ можно за
 * минуту найти выгрузку, версию промпта и результат». Проверка проходит
 * этот путь целиком, как человек: открыть панель, найти человека,
 * открыть карточку, прочитать.
 */

test.describe('обзор, люди и карточка (§15; задача 4.6)', () => {
  /**
   * Условие готовности задачи — не «экран есть», а «по жалобе „бот
   * неправильно понял“ можно за минуту найти выгрузку, версию промпта и
   * результат». Проверка проходит этот путь целиком, как человек:
   * открыть панель, найти человека, открыть карточку, прочитать.
   */

  test('обзор показывает числа и честно говорит, чего в нём нет', async ({ page }) => {
    await signIn(page);

    const totals = page.locator('.итоги');

    await expect(totals.locator('.итог', { hasText: 'Всего людей' })).toContainText('1');
    await expect(totals.locator('.итог', { hasText: 'Выгрузок разобрано' })).toContainText('1');
    await expect(totals.locator('.итог', { hasText: 'Расход на модели' })).toContainText('10.00 ₽');

    // §15 просит переход в оплату и выручку; их нет до задачи 4.2, и
    // панель говорит это словами, а не пустой колонкой.
    await expect(page.getByText('4.2', { exact: false })).toBeVisible();
  });

  test('список людей показывает выгрузки и расход', async ({ page }) => {
    await signIn(page, 'Пользователи');

    const row = page.getByRole('row', { name: /Аня/u });

    await expect(row).toContainText('10.00 ₽');
    await expect(row).toContainText('1');
  });

  test('поиск находит человека по имени', async ({ page }) => {
    // Жалоба приходит от человека, и искать его по коду неудобно.
    await signIn(page, 'Пользователи');

    await page.locator('input[name="q"]').fill('Ан');
    await expect(page.getByRole('row', { name: /Аня/u })).toBeVisible();

    await page.locator('input[name="q"]').fill('никого такого нет');
    await expect(page.getByText('Никого не нашлось.')).toBeVisible();
  });

  test('карточка отвечает на жалобу: слова, разбор и версия промпта', async ({ page }) => {
    /**
     * **Условие готовности 4.6 целиком.** Из карточки видно, что человек
     * сказал, что из этого вышло и каким промптом это сделано — всё на
     * одном экране, без ssh и без SQL.
     */
    await signIn(page, 'Пользователи');
    await page.getByRole('button', { name: 'Аня' }).click();

    await expect(page.getByTestId('card')).toBeVisible();

    // Слова человека.
    await expect(page.locator('.выгрузка__слова')).toContainText(
      'надо записать сына к врачу в четверг',
    );

    // Что из них вышло.
    await expect(page.locator('.выгрузка__итог')).toContainText('Записать сына к врачу');

    // И чем это разобрано — без версии промпта жалобу не разобрать.
    await expect(page.locator('.выгрузка__шапка')).toContainText('classifier@9');
  });

  test('из карточки можно вернуться к списку', async ({ page }) => {
    // Тупик без выхода — то же, что сломанная кнопка.
    await signIn(page, 'Пользователи');
    await page.getByRole('button', { name: 'Аня' }).click();

    await expect(page.getByTestId('card')).toBeVisible();
    await page.getByRole('button', { name: 'Назад к списку' }).click();

    await expect(page.getByTestId('people')).toBeVisible();
  });

  test('разделы людей закрыты без входа', async ({ request }) => {
    for (const path of ['/admin/api/overview', '/admin/api/people']) {
      const response = await request.get(path, { failOnStatusCode: false });
      expect(response.status(), path).toBe(401);
    }
  });
});
