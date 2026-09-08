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

/**
 * Придержанный ответ: обещание и рычаг, который его отпускает.
 *
 * Прежде рычаг заводился пустой стрелкой (`let release = () => {}`), и
 * линтер жаловался на неё справедливо: до `new Promise` такой рычаг
 * можно вызвать, и он молча ничего не сделает — проверка тогда ждала бы
 * вечно, а причина была бы не видна. Здесь рычага без обещания не
 * бывает: оба появляются вместе.
 */
function gate(): { readonly wait: Promise<void>; readonly release: () => void } {
  let release: (() => void) | undefined;

  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Тело `new Promise` выполняется сразу, поэтому рычаг уже на месте.
  // Проверка стоит ради типов, а не ради надежды; но если обещание
  // однажды перестанет так себя вести, мы узнаем об этом строкой, а не
  // зависшим прогоном.
  if (release === undefined) throw new Error('обещание не отдало рычаг');

  return { wait, release };
}

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

  test('имя итога не совпадает с обзорным: множества разные', async ({ page }) => {
    /**
     * Ревизия четвёртого этапа. «Разобрано выгрузок» стояло здесь на
     * `count(distinct ai_calls.batch_id)`, а в обзоре — на выгрузках в
     * состоянии «готово». Одно имя на двух разных множествах: числа
     * расходятся систематически (сорвавшаяся с обращениями попадает
     * только сюда, закрытая без обращений — только туда), и человек
     * читает расхождение как ошибку учёта.
     *
     * Проверка держит **имя**, потому что чинилось именно имя.
     */
    await signIn(page, 'Расходы');

    const totals = page.locator('.итоги');

    await expect(totals).toContainText('Выгрузок с обращениями');
    await expect(totals.locator('.итог__имя', { hasText: /^Разобрано выгрузок$/u })).toHaveCount(0);
  });

  test('при смене периода числа прежнего периода не остаются на экране', async ({ page }) => {
    /**
     * Ревизия четвёртого этапа. Эффект сбрасывал только сообщение об
     * отказе: под уже подсвеченной кнопкой «7 дней» оставались числа за
     * 30 дней, и «Считаю…» показывалось лишь на самой первой загрузке.
     * Пара «период с числами» врала — а по среднему на человека
     * назначают цену подписки.
     */
    await signIn(page, 'Расходы');
    await expect(page.locator('.итоги')).toContainText('10.00 ₽');

    // Ответ придержан, чтобы застать окно, в котором дефект и жил.
    const held = gate();

    await page.route('**/admin/api/costs?*days=7*', async (route) => {
      await held.wait;
      await route.continue();
    });

    await page.getByRole('button', { name: '7 дней' }).click();

    // Кнопка уже подсвечена — значит числа рядом с ней обязаны молчать.
    await expect(page.getByRole('button', { name: '7 дней' })).toHaveClass(/--выбран/u);
    await expect(page.getByText('Считаю…')).toBeVisible();
    await expect(page.locator('.итоги')).toHaveCount(0);

    held.release();
    await expect(page.locator('.итоги')).toContainText('10.00 ₽');
  });

  test('опоздавший ответ прежнего периода не закрепляется', async ({ page }) => {
    /**
     * Два быстрых нажатия: ответ первого запроса приходит последним.
     * Прежде `setReport` вызывал любой завершившийся запрос, и на экране
     * закреплялись числа не того периода.
     *
     * Стенд отдаёт одни и те же числа за любой период, поэтому ответ за
     * семь дней здесь **подменяется** заметной суммой. Иначе проверка не
     * смогла бы отличить починенное от сломанного: 10 ₽ на экране
     * означали бы и правильный ответ, и опоздавший.
     */
    await signIn(page, 'Расходы');

    const answered: number[] = [];
    const first = gate();

    await page.route('**/admin/api/costs?*', async (route) => {
      const url = route.request().url();

      if (!url.includes('days=7')) {
        if (url.includes('days=90')) answered.push(90);
        await route.continue();
        return;
      }

      await first.wait;

      const answer = await route.fetch();
      const body = (await answer.json()) as Record<string, unknown>;
      const loud = [{ currency: 'rub', micros: 777_000_000 }];

      answered.push(7);
      await route.fulfill({ json: { ...body, perDump: loud, perUser: loud } });
    });

    await page.getByRole('button', { name: '7 дней' }).click();
    await page.getByRole('button', { name: '90 дней' }).click();

    await expect.poll(() => answered.includes(90)).toBe(true);

    first.release();
    await expect.poll(() => answered.includes(7)).toBe(true);

    // Подсвечен девяностый — и числа на экране обязаны быть его: ни
    // подменённых 777 ₽, ни вечного «Считаю…» вместо итогов.
    await expect(page.getByRole('button', { name: '90 дней' })).toHaveClass(/--выбран/u);
    await expect(page.locator('.итоги')).toContainText('10.00 ₽');
    await expect(page.locator('.итоги')).not.toContainText('777');
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
