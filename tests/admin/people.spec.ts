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

  test('обзор показывает числа', async ({ page }) => {
    await signIn(page);

    const totals = page.locator('.итоги');

    await expect(totals.locator('.итог', { hasText: 'Всего людей' })).toContainText('1');
    await expect(totals.locator('.итог', { hasText: 'Выгрузок разобрано' })).toContainText('1');
    await expect(totals.locator('.итог', { hasText: 'Расход на модели' })).toContainText('10.00 ₽');
  });

  test('выручка идёт по оплаченным счетам, а брошенный в неё не попадает', async ({ page }) => {
    /**
     * **Шов между базой и страницей.** Агрегат выручки покрыт своими
     * проверками, страница нарисована отдельно, но имена полей в ответе
     * их связывают: переименуй `minor` — и обе половины останутся
     * зелёными, а панель покажет `NaN ₽`.
     *
     * На стенде два счёта: оплаченный на 399 ₽ и брошенный на 3990 ₽.
     * Увидеть в выручке второй значило бы показать заказчице деньги,
     * которых нет.
     */
    await signIn(page);

    /**
     * На стенде два оплаченных счёта: обычный на 399 ₽ и по промокоду на
     * 99 ₽ (задача 4.4). Брошенный на 3990 ₽ в выручку не попадает.
     */
    await expect(page.getByTestId('revenue')).toHaveText('498.00 ₽');
    await expect(page.getByTestId('payments')).toHaveText('2 платежа');
    await expect(page.getByTestId('revenue')).not.toContainText('3990');
    await expect(page.getByTestId('payers')).toHaveText('1');
  });

  test('переход в оплату не выдумывается, а объясняется', async ({ page }) => {
    /**
     * Пробный период на стенде — десять выгрузок (умолчание из кода), а
     * разобрана одна. Значит до границы никто не дошёл, и «0 из 0» —
     * правда, а не отсутствие данных. Рядом стоит оговорка, объясняющая
     * знаменатель: без неё ноль читался бы как «никто не покупает».
     */
    await signIn(page);

    /**
     * На стенде у Ани записан момент конца пробного периода при пределе
     * один и есть оплаченный счёт — то есть переход у неё случился.
     * Рядом обязана стоять дата начала ведения моментов: без неё ноль в
     * этом месте читался бы как «никто не дошёл», а не «записей нет».
     */
    await expect(page.getByTestId('conversion')).toHaveText('1 из 1');
    await expect(page.getByTestId('moments-since')).toContainText('пределы: 1');
  });

  test('список людей показывает выгрузки и расход', async ({ page }) => {
    await signIn(page, 'Пользователи');

    const row = page.getByRole('row', { name: /Аня/u });

    await expect(row).toContainText('10.00 ₽');
    await expect(row).toContainText('1');
  });

  test('в списке видно подписку: тариф, рельс, срок и продление', async ({ page }) => {
    /**
     * Первый вопрос по жалобе «бот перестал разбирать» — платит ли
     * человек. Уходить за ответом в базу означало бы ровно тот путь
     * через ssh, ради отмены которого панель и существует.
     *
     * У Оли подписки нет вовсе, и это отдельная строка: «не платил» и
     * «кончилась» — разные состояния, и путать их нельзя.
     */
    await signIn(page, 'Пользователи');

    const anya = page.getByRole('row', { name: /Аня/u });

    await expect(anya).toContainText('месяц');
    await expect(anya).toContainText('карта');
    await expect(anya).toContainText('продлевается');

    await expect(page.getByRole('row', { name: /Оля/u })).toContainText('—');
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

  test('воронка по источникам: четыре шага и названный прямой заход', async ({ page }) => {
    /**
     * Условие готовности 4.4: «в админке виден срез по источникам и
     * воронка „регистрация, первая выгрузка, конец пробного, оплата“».
     *
     * Между агрегатом и страницей есть шов — имена полей в ответе, — и
     * покрыт он только здесь: переименуй `paidAfterTrial` и обе половины
     * останутся зелёными, а панель покажет пустые ячейки.
     *
     * Отдельно проверяется, что прямой заход **назван словом**: пустая
     * ячейка читается как «нет данных», а человек-то есть.
     */
    await signIn(page);

    const funnel = page.getByTestId('funnel');

    await expect(funnel).toBeVisible();

    const all = funnel.getByRole('row', { name: /Все вместе/u });

    await expect(all).toBeVisible();

    // На стенде одиннадцать человек, у Ани разобранная выгрузка,
    // записанный момент конца пробного и оплаченный счёт.
    await expect(funnel.getByRole('row', { name: /blogger7/u })).toBeVisible();
    await expect(funnel.getByRole('row', { name: /без источника/u })).toBeVisible();

    // И сказано, с какого дня ведутся моменты: ноль без этого читался бы
    // как «никто не дошёл».
    await expect(page.getByTestId('moments-since')).toBeVisible();
  });
});
