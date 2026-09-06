import { expect, test } from '@playwright/test';

import { signIn } from './panel.js';

/**
 * Раздел расходов (§15, §21 п.14; задачи 4.7 и 4.12).
 *
 * Проверяется **сквозной путь**: база → запрос → страница. Агрегаты
 * покрыты своими четырнадцатью проверками, страница нарисована
 * отдельно, а между ними шов — имена полей в ответе. Переименуй поле в
 * одном месте, и обе половины останутся зелёными, а панель покажет
 * пустоту.
 */

test.describe('расходы (§15, §21 п.14; задача 4.7)', () => {
  /**
   * §21 п.14 — прямой критерий приёмки: «в админ-панели виден расход по
   * каждому пользователю и по этапам».
   *
   * Проверяется **сквозной путь**: база → запрос → страница. Агрегаты
   * покрыты своими четырнадцатью проверками, страница нарисована
   * отдельно, а между ними шов — имена полей в ответе. Переименуй поле
   * в одном месте, и обе половины останутся зелёными, а панель покажет
   * пустоту.
   *
   * Стенд сеет две строки учёта: маршрутизатор на 2 ₽ и классификация на
   * 8 ₽, одна выгрузка, один человек по имени Аня. Числа круглые
   * нарочно — проверка читает их так же, как человек.
   */

  test('видно расход по этапам', async ({ page }) => {
    await signIn(page, 'Расходы');

    const stages = page.locator('.разрез', { hasText: 'По этапам' });

    await expect(stages.getByRole('row', { name: /router/u })).toContainText('2.00 ₽');
    await expect(stages.getByRole('row', { name: /classifier/u })).toContainText('8.00 ₽');
  });

  test('видно расход по каждому человеку — с именем, а не кодом', async ({ page }) => {
    await signIn(page, 'Расходы');

    const people = page.locator('.разрез', { hasText: 'По людям' });

    await expect(people.getByRole('row', { name: /Аня/u })).toContainText('10.00 ₽');
  });

  test('видно расход по моделям', async ({ page }) => {
    await signIn(page, 'Расходы');

    const models = page.locator('.разрез', { hasText: 'По моделям' });

    await expect(models.getByRole('row', { name: /yandexgpt-lite/u })).toContainText('2.00 ₽');
    await expect(models.getByRole('row', { name: /yandexgpt\/latest/u })).toContainText('8.00 ₽');
  });

  test('видны средние: на выгрузку и на человека', async ({ page }) => {
    // Одна выгрузка и один человек на 10 ₽ — значит по 10 ₽ и там и там.
    await signIn(page, 'Расходы');

    const totals = page.locator('.итоги');

    await expect(totals).toContainText('Обращений к моделям');
    await expect(totals.locator('.итог', { hasText: 'На выгрузку' })).toContainText('10.00 ₽');
    await expect(totals.locator('.итог', { hasText: 'На человека' })).toContainText('10.00 ₽');
  });

  test('период переключается и запрос уходит с новым числом дней', async ({ page }) => {
    await signIn(page, 'Расходы');

    const asked: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/admin/api/costs')) asked.push(request.url());
    });

    await page.getByRole('button', { name: '7 дней' }).click();

    await expect.poll(() => asked.some((url) => url.includes('days=7'))).toBe(true);
  });

  test('раздел расходов закрыт без входа', async ({ request }) => {
    // §21 п.14 про то, что расход **виден в панели**, а не всякому.
    const response = await request.get('/admin/api/costs', { failOnStatusCode: false });

    expect(response.status()).toBe(401);
  });
});
