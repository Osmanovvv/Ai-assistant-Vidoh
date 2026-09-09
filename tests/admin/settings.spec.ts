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

    // Пробный период: показано действующее значение.
    await expect(page.getByTestId('now-trialDumps')).toContainText('10');

    /**
     * Пометка «(из кода)» проверяется на настройке, которую **не пишет
     * ни одна проверка** (ревизия четвёртого этапа).
     *
     * Прежде она проверялась на пробном периоде — том самом, куда
     * соседняя проверка пишет семёрку. Вернуть состояние «из кода» через
     * панель нечем: у настроек есть чтение и запись, сброса нет. Значит
     * на втором прогоне против того же стенда эта проверка краснела —
     * то есть держалась на том, что стенд поднимают заново.
     */
    /**
     * Число здесь девять, а не восемь: умолчание свели с числом сфер,
     * которые бот предлагает на опросе (разбор ревизии панели). Восемь
     * при девяти предложенных означало молчаливую обрезку у каждого, кто
     * отметит все.
     *
     * Число списано, и это осознанно: связку «умолчание не ниже числа
     * сфер» держит страж в `apps/bot/src/modules/topics/topics-limit.wiring.test.ts`,
     * а здесь проверяется, что панель печатает действующее значение
     * вместе с пометкой. Разойдутся — покраснеет и то, и это.
     */
    await expect(page.getByTestId('now-maxTopics')).toContainText('9');
    await expect(page.getByTestId('now-maxTopics')).toContainText('из кода');

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

    /**
     * Возвращаем значение, но не состояние: строка в базе остаётся, и
     * пометка «(из кода)» к пробному периоду больше не вернётся —
     * сброса настроек в панели нет. Поэтому проверка пометки живёт на
     * `maxTopics`, которую никто не пишет.
     */
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

  test('отказ называет причину: занятый код и наша поломка выглядят по-разному', async ({
    page,
  }) => {
    /**
     * **Ревизия четвёртого этапа.** Панель не читала тело ответа, и на
     * все отказы показывала одну склеенную строку — включая пятисотые.
     * Отказ базы предъявлялся заказчице как ошибка её ввода.
     */
    await signIn(page, 'Настройки');

    // Засеянный код BLOGGER7 уже есть — заводим его же.
    await page.locator('input[name="promoCode"]').fill('BLOGGER7');
    await page.locator('input[name="promoRub"]').fill('9900');
    await page.locator('input[name="promoStars"]').fill('40');
    await page.locator('button[name="promoSave"]').click();

    await expect(page.getByRole('alert')).toContainText('Такой код уже есть');

    // Наша поломка — своими словами, а не «код не подошёл».
    await page.route('**/admin/api/promo', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }

      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'не удалось завести код' }),
      });
    });

    await page.locator('input[name="promoCode"]').fill('WINTER-2027');
    await page.locator('button[name="promoSave"]').click();

    await expect(page.getByRole('alert')).toContainText('на нашей стороне');
  });

  test('ноль в суточном потолке панель не принимает', async ({ page }) => {
    /**
     * Он выключил бы разбор **всем** людям: потолок сверяется на каждом
     * сообщении. Прежде значение не проверялось вовсе — «Сохранено», и
     * бот молча перестаёт работать.
     */
    await signIn(page, 'Настройки');

    const row = page.locator('tr', { has: page.locator('input[name="dumpsPerDay"]') });

    await row.locator('input[name="dumpsPerDay"]').fill('0');
    await row.getByRole('button', { name: 'Сохранить' }).click();

    await expect(page.getByRole('alert')).toContainText('допустимо от 1');

    // И значение не изменилось: отказ, а не отказ на словах.
    await expect(page.getByTestId('now-dumpsPerDay')).toContainText('30');
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

    /**
     * Кириллица не проходит, и панель говорит **названную сервером**
     * причину, а не склеенную строку про все ошибки сразу.
     *
     * Ревизия четвёртого этапа: тело ответа панель не читала вовсе, и
     * «такой код уже есть», «цены больше нуля» и сбой сервера выглядели
     * одинаково — ошибкой ввода. Заказчица правила то, что было верным.
     */
    await expect(page.getByRole('alert')).toContainText('латиница, цифры и дефис');

    /**
     * Код свой на каждый прогон (ревизия четвёртого этапа).
     *
     * Прежде он был жёстко зашит — `AUTUMN-2026`, — и второй прогон
     * против того же стенда проходил **по чужой строке**: заведение
     * отвергалось («такой код уже есть»), а проверка видимости
     * срабатывала на строке, оставшейся с прошлого раза. Дальше она
     * искала кнопку «Выключить» у уже выключенного кода и падала по
     * таймауту. Выключить код через панель можно, удалить — нет.
     */
    const code = `AUTUMN-${String(Date.now())}`;

    await page.locator('input[name="promoCode"]').fill(code);
    await page.locator('button[name="promoSave"]').click();

    // Строка, а не клетка: цена лежит в соседней клетке той же строки.
    const fresh = page.locator('tr', { has: page.getByTestId(`promo-${code}`) });

    // Заведение подтверждается **ценой в своей строке**, а не одной
    // видимостью: видимость обеспечила бы и чужая строка.
    await expect(fresh).toBeVisible();
    await expect(fresh).toContainText('149.00 ₽');
    await expect(page.getByRole('alert')).toHaveCount(0);

    // Выключение, а не удаление: по коду считается недополученное.
    await fresh.getByRole('button', { name: 'Выключить' }).click();

    await expect(fresh).toContainText('выключен');
    await expect(fresh.getByRole('button', { name: 'Включить' })).toBeVisible();
  });

  test('срок действия кода задаётся и виден — ревизия панели', async ({ page }) => {
    /**
     * Срок был на всём пути, кроме экрана: колонка в базе, разбор тела в
     * маршруте, соблюдение ботом («код истёк»). Форма поля не посылала, а
     * таблица колонки не печатала — значит код с прошедшим сроком
     * показывался живым, с кнопкой «Выключить», пока бот уже отказывал
     * человеку. Жалобу блогера разобрать было нечем.
     */
    await signIn(page, 'Настройки');

    // Засеянный код с прошедшим сроком: помечен «истёк», и срок напечатан.
    await expect(page.getByTestId('promo-SPRING5')).toContainText('истёк');
    await expect(page.getByTestId('promo-until-SPRING5')).toContainText('31.03.2026');

    // Бессрочный код так и назван: пустая клетка читалась бы как факт.
    await expect(page.getByTestId('promo-until-BLOGGER7')).toContainText('без срока');
    await expect(page.getByTestId('promo-BLOGGER7')).not.toContainText('истёк');

    /**
     * Новый код со сроком: дата доезжает до базы и возвращается в таблицу.
     * Дата считается от сегодняшнего дня, а не зашита: зашитая однажды
     * окажется в прошлом, и проверка покраснеет от календаря, а не от
     * кода.
     */
    const soon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const [year = '', month = '', day = ''] = soon.toISOString().slice(0, 10).split('-');
    const code = `AUTUMN-${String(Date.now())}`;

    await page.locator('input[name="promoCode"]').fill(code);
    await page.locator('input[name="promoRub"]').fill('14900');
    await page.locator('input[name="promoStars"]').fill('60');
    await page.locator('input[name="promoUntil"]').fill(`${year}-${month}-${day}`);
    await page.locator('button[name="promoSave"]').click();

    await expect(page.getByTestId(`promo-until-${code}`)).toContainText(`${day}.${month}.${year}`);
    await expect(page.getByRole('alert')).toHaveCount(0);

    // Срок в будущем — код живой, и пометки «истёк» у него нет.
    await expect(page.getByTestId(`promo-${code}`)).not.toContainText('истёк');
  });

  test('отказ чтения настроек не уносит с экрана промокоды — ревизия панели', async ({ page }) => {
    /**
     * Код утёк в публичный канал, выключить его надо срочно — а на экране
     * «Не удалось прочитать настройки», и выключить нечем. Блок промокодов
     * читается своим запросом и мог ответить нормально: отказ чтения
     * обязан печататься на месте таблицы, а не вместо раздела.
     *
     * Истёкший пропуск сюда не попадает: 401 уводит на вход событием.
     * Случай ровно один — пятисотая на `/api/settings` при живом
     * `/api/promo`.
     */
    await page.route('**/admin/api/settings', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }

      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'не удалось прочитать настройки' }),
      });
    });

    await signIn(page, 'Настройки');

    await expect(page.getByRole('alert')).toContainText('Не удалось прочитать настройки');

    // Промокоды на месте, и выключить код есть чем.
    await expect(page.getByTestId('promo')).toBeVisible();
    await expect(page.getByTestId('promo-BLOGGER7')).toBeVisible();
    await expect(
      page.locator('tr', { has: page.getByTestId('promo-BLOGGER7') }).getByRole('button', {
        name: 'Выключить',
      }),
    ).toBeVisible();

    // А таблицы настроек нет — отказ её и подменяет.
    await expect(page.getByTestId('now-trialDumps')).toHaveCount(0);
  });
});
