import { expect, test } from '@playwright/test';

import { signIn } from './panel.js';

/**
 * Раздел настроек (§15; задачи 4.9 и 4.12).
 *
 * Условие готовности 4.9 — «изменение окна тишины применяется без
 * перезапуска» — проверено интеграционным тестом на самом боте. Здесь
 * браузерная половина: сохранение работает, панель показывает новое
 * значение и предупреждает о значениях, полученных замером.
 */

test.describe('настройки (§15; задача 4.9)', () => {
  /**
   * §15 просит менять числа продукта без выкладки. Условие готовности
   * названо про окно тишины: правка применяется без перезапуска —
   * это проверено интеграционным тестом на самом боте. Здесь браузерная
   * половина: сохранение работает, и панель показывает новое значение.
   */

  test('показывает текущее значение, умолчание и предупреждение о замере', async ({ page }) => {
    await signIn(page, 'Настройки');

    await expect(page.getByTestId('settings')).toBeVisible();

    // Пробный период: пока не задан, работает умолчание из кода.
    await expect(page.getByTestId('now-trialDumps')).toContainText('10');
    await expect(page.getByTestId('now-trialDumps')).toContainText('из кода');

    /**
     * И предупреждение у измеренных значений — до поля ввода, а не
     * после. Иначе «настройка без выкладки» становится способом молча
     * уронить качество.
     */
    await expect(
      page.getByText('Значение получено замером', { exact: false }).first(),
    ).toBeVisible();
  });

  test('сохранение меняет значение и панель это показывает', async ({ page }) => {
    await signIn(page, 'Настройки');

    /**
     * Строка ищется по полю ввода, а не по названию.
     *
     * Название лежит во вложенных блоках вместе с подсказкой и
     * предупреждением, и доступное имя строки складывается из всего
     * подряд — поиск по нему оказался хрупким. Поле с именем настройки
     * однозначно и не зависит от того, как переписали подсказку.
     */
    const row = page.locator('tr', { has: page.locator('input[name="trialDumps"]') });
    const field = row.locator('input[name="trialDumps"]');

    await field.fill('7');
    await row.getByRole('button', { name: 'Сохранить' }).click();

    // Новое значение и больше не «из кода»: строка в базе появилась.
    await expect(page.getByTestId('now-trialDumps')).toContainText('7');
    await expect(page.getByTestId('now-trialDumps')).not.toContainText('из кода');

    // Возвращаем как было: стенд общий на все проверки файла.
    await field.fill('10');
    await row.getByRole('button', { name: /Сохран/u }).click();
    await expect(page.getByTestId('now-trialDumps')).toContainText('10');
  });

  test('говорит, чего в настройках ещё нет', async ({ page }) => {
    // Настройка, которую никто не читает, обманывает: человек меняет
    // число, видит «сохранено» и ждёт, что что-то изменится.
    await signIn(page, 'Настройки');

    await expect(page.getByText('Цены тарифов', { exact: false })).toBeVisible();
  });

  test('раздел настроек закрыт без входа', async ({ request }) => {
    const response = await request.get('/admin/api/settings', { failOnStatusCode: false });
    expect(response.status()).toBe(401);
  });
});
