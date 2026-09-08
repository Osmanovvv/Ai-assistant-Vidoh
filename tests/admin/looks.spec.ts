import { expect, test } from '@playwright/test';

import { signIn } from './panel.js';

/**
 * Как панель выглядит: снимки и телефон (§15 ТЗ, задача 4.12).
 *
 * План просит «скриншотные проверки на ключевых экранах» и «проверку
 * адаптивности: админкой пользуются и с телефона».
 *
 * **Снимки сравниваются с эталоном, а не просто делаются.** Снимок,
 * который никто не сравнивает, — это приложение к отчёту, а не
 * проверка: он не краснеет никогда. Эталон кладётся в репозиторий и
 * обновляется осознанно, командой `--update-snapshots`.
 *
 * **Что снимается — экраны без чужих данных.** Карточка человека
 * показывает его слова; класть их в репозиторий картинкой значило бы
 * вынести содержимое выгрузок из базы в git, где нет ни удаления по
 * §16, ни журнала доступа. Снимаются вход, обзор и настройки: там
 * только числа продукта и наши же подписи.
 *
 * **Телефон проверяется поведением, а не снимком.** Снимок узкого
 * экрана краснел бы от каждой правки текста; важно другое — что на
 * телефоне ничего не уезжает за край и до кнопок можно дотянуться.
 */

/** Ширина телефона, на котором и правда читают: iPhone SE. */
const PHONE = { width: 375, height: 667 };

test.describe('снимки ключевых экранов', () => {
  /**
   * **Сравнение снимков идёт только там, где сняты эталоны.**
   *
   * Шрифты на Windows и на Linux рисуются по-разному — до нескольких
   * пикселей на каждой букве, — и один и тот же экран даёт разные
   * картинки. Сравнение, которое на сервере краснеет всегда, учит не
   * смотреть на красное; это дороже, чем отсутствие сравнения. Та же
   * причина, по которой визуальные проверки Telegram не гоняются на
   * каждый коммит.
   *
   * Что от этого не теряется: сама панель в CI проверяется тридцатью с
   * лишним сценариями, а на телефоне — поведением, а не картинкой.
   * Эталоны служат приёмке (§21 просит показать, как это выглядит) и
   * ловят правку вёрстки у того, кто её делает.
   *
   * Как обновить после осознанной правки:
   *   npx playwright test --project admin --update-snapshots
   */
  test.skip(process.env['CI'] !== undefined, 'эталоны сняты на другой системе');

  test('окно входа', async ({ page }) => {
    await page.goto('/admin/');
    await expect(page.locator('input[name="password"]')).toBeVisible();

    await expect(page).toHaveScreenshot('вход.png', { fullPage: true });
  });

  test('обзор', async ({ page }) => {
    await signIn(page);
    await expect(page.getByTestId('overview')).toBeVisible();

    await expect(page).toHaveScreenshot('обзор.png', { fullPage: true });
  });

  test('настройки', async ({ page }) => {
    await signIn(page, 'Настройки');
    await expect(page.getByTestId('settings')).toBeVisible();

    /**
     * Блок промокодов закрывается маской — правка ревизии этапа.
     *
     * Промокод, заведённый проверкой раздела настроек, остаётся в базе:
     * панель умеет его выключить, но не удалить. Значит снимок зависел
     * от того, в каком порядке шли файлы проверок и запускали ли стенд
     * заново, — а снимок, краснеющий от чужой проверки, учит не смотреть
     * на красное.
     *
     * Сами промокоды при этом проверены поведением, в своём файле: их
     * заведение, вид и выключение.
     */
    await expect(page).toHaveScreenshot('настройки.png', {
      fullPage: true,
      mask: [page.getByTestId('promo')],
    });
  });
});

test.describe('с телефона (§15: панелью пользуются и с него)', () => {
  test.use({ viewport: PHONE });

  test('окно входа помещается по ширине', async ({ page }) => {
    /**
     * Горизонтальная прокрутка на телефоне — это не «некрасиво», это
     * поле ввода, до которого не дотянуться пальцем.
     */
    await page.goto('/admin/');
    await expect(page.locator('input[name="password"]')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('вход проходится целиком', async ({ page }) => {
    // Кнопки должны быть нажимаемы, а не просто присутствовать: на
    // узком экране их легко увести за край.
    await signIn(page);

    await expect(page.getByTestId('overview')).toBeVisible();
  });

  test('таблица расходов прокручивается, а не рвёт страницу', async ({ page }) => {
    /**
     * Широкую таблицу на телефоне не показать целиком, и это нормально.
     * Ненормально — когда из-за неё уезжает **вся страница**: тогда
     * заголовок и вкладки уходят вбок вместе с ней.
     */
    await signIn(page, 'Расходы');
    await expect(page.getByTestId('costs')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('вкладки доступны и переключаются', async ({ page }) => {
    await signIn(page);

    await page.getByRole('button', { name: 'Настройки' }).click();
    await expect(page.getByTestId('settings')).toBeVisible();
  });
});
