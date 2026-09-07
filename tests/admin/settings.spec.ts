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

  test('промокоды: код заводится, виден и выключается — задача 4.4', async ({ page }) => {
    /**
     * §14: «Поддержка кода на первый период. Нужны для запуска через
     * блогеров». Заводить их обязана заказчица сама — иначе запуск у
     * блогера невозможен без нас, и строка §14 не выполнена.
     *
     * Путь проходится целиком, как человек: посмотреть засеянный код,
     * завести новый, выключить его.
     */
    await signIn(page, 'Настройки');

    const promo = page.getByTestId('promo');

    await expect(promo).toBeVisible();

    // Засеянный код с одной оплатой: видно применения и недополученное.
    const seeded = page.getByRole('row', { name: /BLOGGER7/u });

    await expect(seeded).toContainText('99.00 ₽');
    await expect(seeded).toContainText('40 ⭐');
    await expect(seeded).toContainText('1 из 50');
    await expect(seeded).toContainText('300.00 ₽');
    await expect(seeded).toContainText('Марина');

    // Заводим новый.
    await page.locator('input[name="promoCode"]').fill('осень-2026');
    await page.locator('input[name="promoRub"]').fill('14900');
    await page.locator('input[name="promoStars"]').fill('60');
    await page.locator('button[name="promoSave"]').click();

    // Код приведён к единому виду: кириллица не проходит, и панель
    // говорит об этом, а не молчит.
    await expect(page.getByRole('alert')).toContainText('латиница');

    await page.locator('input[name="promoCode"]').fill('AUTUMN-2026');
    await page.locator('button[name="promoSave"]').click();

    await expect(page.getByTestId('promo-AUTUMN-2026')).toBeVisible();

    // Выключение, а не удаление: по коду считается недополученное.
    const fresh = page.getByRole('row', { name: /AUTUMN-2026/u });

    await fresh.getByRole('button', { name: 'Выключить' }).click();

    await expect(page.getByTestId('promo-AUTUMN-2026')).toContainText('выключен');
  });
});
