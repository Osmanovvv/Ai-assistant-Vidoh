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

  test('цены есть, и подсказки говорят про копейки и про ноль', async ({ page }) => {
    /**
     * До задачи 4.2 цен здесь не было, и панель честно говорила об этом
     * строкой: настройка, которую никто не читает, обманывает — человек
     * меняет число, видит «сохранено» и ждёт, что что-то изменится.
     *
     * Теперь цены читаются настоящим кодом, и проверка сменила предмет.
     * Главное в ней — подсказки: поле в **копейках** без подсказки
     * означает, что кто-нибудь введёт «399» и продаст месяц за три
     * рубля. А ноль означает «не продаётся», и об этом тоже надо
     * сказать, иначе оставивший ноль будет искать, почему бот не берёт
     * денег.
     */
    await signIn(page, 'Настройки');

    await expect(page.getByText('39900 = 399 ₽', { exact: false })).toBeVisible();
    await expect(
      page.getByText('Ноль — тариф не продаётся', { exact: false }).first(),
    ).toBeVisible();

    // Звёзды — штуками, и годовой тариф в них автопродлением не бывает.
    await expect(page.getByText('Штуками, не копейками', { exact: false })).toBeVisible();
    await expect(page.getByText('разовый платёж', { exact: false })).toBeVisible();

    // Ни одна настройка не показывается ключом из базы.
    await expect(page.getByTestId('settings')).not.toContainText('price.');
    await expect(page.getByTestId('settings')).not.toContainText('broadcast.');
  });

  test('раздел настроек закрыт без входа', async ({ request }) => {
    const response = await request.get('/admin/api/settings', { failOnStatusCode: false });
    expect(response.status()).toBe(401);
  });
});
