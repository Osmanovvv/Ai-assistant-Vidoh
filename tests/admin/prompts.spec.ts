import { expect, test, type Page } from '@playwright/test';

import { signIn } from './panel.js';

/**
 * Раздел промптов (§15; задачи 4.8 и 4.12).
 *
 * План требует «Playwright на цикл „создать, включить, откатить"» и
 * «тест на предупреждение о непрогнанном наборе». Второе здесь важнее
 * первого: §15 разрешает менять промпт без выкладки, а §10.3 требует
 * прогонять контрольный набор на любом изменении. Панель — единственная
 * дверь, через которую регрессия может дойти до людей минуя заслон.
 * 28.08.2026 такое уже случилось на выкладке: `router@3`, потом
 * `router@4` без прогона, и промпт терял три единицы из сорока трёх.
 *
 * **Прогон в этих проверках — заглушка** (`eval-stub.mjs`): настоящий
 * ходит к живой модели и стоит денег, 05.09.2026 на таких прогонах
 * кончился грант. Всё остальное настоящее — и отказ без отчёта, и
 * разрешение с отчётом, и запись признания в версию.
 *
 * **Каждая проверка заводит себе свежую версию правкой** вместо того,
 * чтобы полагаться на засеянную. Иначе они зависели бы от порядка:
 * первая же прогнавшая набор открыла бы дорогу остальным, и «включить
 * нельзя» стало бы зелёным по чужой заслуге.
 */

/** Проверки идут одна за другой: они правят общее состояние стенда. */
test.describe.configure({ mode: 'serial' });

/** Открыть раздел и дождаться таблицы версий. */
async function openPrompts(page: Page): Promise<void> {
  await signIn(page, 'Промпты');
  await expect(page.getByTestId('prompts')).toBeVisible();
}

/**
 * Завести свежую версию правкой и вернуть её имя.
 *
 * Свежая — значит заведомо непрогнанная: на ней и проверяется заслон.
 */
async function makeHotfix(page: Page, base: string, text: string): Promise<string> {
  await page.getByTestId(`version-${base}`).getByRole('button', { name: 'Текст' }).click();
  await expect(page.getByTestId('prompt-body')).toBeVisible();

  await page.getByTestId('edit').click();
  await page.getByTestId('editor').fill(text);
  await page.getByTestId('save-hotfix').click();

  const done = page.getByTestId('prompt-done');
  await expect(done).toBeVisible();

  const said = (await done.textContent()) ?? '';
  const version = said.replace('Готово:', '').trim();

  expect(version).toContain('hotfix');
  return version;
}

/** Вернуть стенд к исходному: включена classifier@1. */
async function backToFirst(page: Page): Promise<void> {
  const first = page.getByTestId('version-classifier@1');

  if ((await first.getByTestId('active-classifier').count()) === 0) {
    await page.getByTestId('activate-classifier@1').click();
  }

  await expect(first.getByTestId('active-classifier')).toBeVisible();
}

test.describe('промпты (§15; задача 4.8)', () => {
  test('показывает версии, какая включена, и не грузит тексты списком', async ({ page }) => {
    await openPrompts(page);

    await expect(page.getByTestId('version-classifier@1')).toBeVisible();
    await expect(page.getByTestId('version-classifier@2')).toBeVisible();

    // Включена ровно одна — та, что засеяна стендом.
    await expect(page.getByTestId('active-classifier')).toHaveCount(1);
    await expect(
      page.getByTestId('version-classifier@1').getByTestId('active-classifier'),
    ).toBeVisible();

    /**
     * Текстов в списке нет: они — основное ноу-хау продукта, и возить
     * их целиком на каждое открытие страницы незачем.
     */
    await expect(page.getByTestId('prompts')).not.toContainText('Разбери сказанное');

    // Спокойное состояние: набор на включённом прогнан.
    await expect(page.getByTestId('freshness-ok')).toBeVisible();
  });

  test('текст версии открывается отдельно', async ({ page }) => {
    await openPrompts(page);

    await page.getByTestId('version-classifier@1').getByRole('button', { name: 'Текст' }).click();

    await expect(page.getByTestId('prompt-body')).toContainText('Разбери сказанное');
  });

  test('правка заводит новую версию, а старую оставляет как была', async ({ page }) => {
    await openPrompts(page);

    const made = await makeHotfix(page, 'classifier@1', 'Разбери сказанное. Правка из панели.');

    // Правка сама не включается: иначе «сохранил и ушёл» означало бы
    // непрогнанный промпт в бою.
    await expect(page.getByTestId(`version-${made}`)).toBeVisible();
    await expect(
      page.getByTestId('version-classifier@1').getByTestId('active-classifier'),
    ).toBeVisible();

    // И основа осталась прежней: опубликованное не переписывают.
    await page.getByTestId('version-classifier@1').getByRole('button', { name: 'Текст' }).click();
    await expect(page.getByTestId('prompt-body')).toContainText('Разбери сказанное на отдельные');
    await expect(page.getByTestId('prompt-body')).not.toContainText('Правка из панели');
  });

  test('непрогнанную версию включить нельзя — и сказано почему', async ({ page }) => {
    /**
     * Главная проверка раздела. Не «показано предупреждение», а
     * **версия не включилась**: предупреждение, которое можно
     * прокликать не читая, не защищает ни от чего.
     */
    await openPrompts(page);

    const made = await makeHotfix(page, 'classifier@1', 'Разбери сказанное. Непрогнанная.');

    await page.getByTestId(`activate-${made}`).click();

    const refusal = page.getByTestId('refusal');
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText(made);
    await expect(refusal).toContainText('не прогнан');

    // И включённой осталась прежняя.
    await expect(
      page.getByTestId('version-classifier@1').getByTestId('active-classifier'),
    ).toBeVisible();
  });

  test('второе нажатие «Прогнать набор» не подменяет раздел, а называет причину', async ({
    page,
  }) => {
    /**
     * Кнопка гасилась по уже загруженному состоянию, и между нажатием и
     * ответом она оставалась живой. Второе нажатие получало 409 «прогон
     * уже идёт» — правду: прогон запущен и уже тратит деньги, — а панель
     * заменяла весь раздел красной строкой «Не удалось запустить прогон»:
     * без таблицы версий, без отказа, без кнопки. Выйти можно было только
     * сменой вкладки.
     *
     * Отказ подменяется нарочно: добиться его от стенда можно только
     * гонкой двух нажатий, и такая проверка краснела бы от расписания, а
     * не от поломки. Форма ответа настоящая — та же, что у сервера.
     */
    await page.route('**/admin/api/prompts/run-eval', async (route) => {
      await route.fulfill({
        status: 409,
        json: { started: false, error: 'прогон уже идёт', run: { kind: 'idle' } },
      });
    });

    await openPrompts(page);

    const made = await makeHotfix(page, 'classifier@1', 'Разбери сказанное. Второе нажатие.');

    await page.getByTestId(`activate-${made}`).click();
    await expect(page.getByTestId('refusal')).toBeVisible();

    await page.getByTestId('measure').click();

    // Причина — словами сервера, рядом с отказом.
    const problem = page.getByTestId('run-problem');

    await expect(problem).toBeVisible();
    await expect(problem).toContainText('прогон уже идёт');

    // И раздел на месте целиком: таблица версий и сам отказ.
    await expect(page.getByTestId('prompts')).toBeVisible();
    await expect(page.getByTestId('version-classifier@1')).toBeVisible();
    await expect(page.getByTestId('refusal')).toBeVisible();
  });

  test('раздела нет — панель объясняет почему, а не краснеет', async ({ page }) => {
    /**
     * Состояние достижимо на любом новом сервере: без отчётов прогонов
     * путей `/api/prompts*` не объявлялось, и запрос ловила отдача файлов
     * панели — приходил `index.html` с кодом 200, разбор спотыкался, и
     * человек читал «Не удалось прочитать промпты», то есть шёл искать
     * поломку, которой нет.
     *
     * На стенде отчёты есть нарочно — без них не проверить заслон §10.3,
     * — поэтому выключенный раздел подменяется ответом. Форма настоящая:
     * та же, что отдаёт сервер без папки набора.
     */
    await page.route('**/admin/api/prompts', async (route) => {
      await route.fulfill({
        json: {
          enabled: false,
          why: 'на сервере нет ни одного отчёта прогона контрольного набора, а без них раздел не может судить о §10.3',
          how: './ops/seed-prompts.sh (можно без --activate)',
        },
      });
    });

    await signIn(page, 'Промпты');

    const off = page.getByTestId('prompts-off');

    await expect(off).toBeVisible();
    await expect(off).toContainText('отчёт');
    await expect(page.getByTestId('prompts-off-how')).toContainText('seed-prompts.sh');

    // И ни слова про поломку: раздела нет нарочно.
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('стадии названы по-человечески: ключей из базы на экране нет', async ({ page }) => {
    /**
     * `Prompts.tsx` объявляет: «Ключи из базы — не для глаз», — но строка
     * «Набор не мерит: …» печатала их как есть («presenter»). В таблице
     * рядом та же стадия называется «Ответ человеку», и читающий должен
     * был догадаться, что это одно и то же.
     *
     * Стенд сеет включённую версию представления нарочно: набор мерит
     * разбор, а не ответ, и без такой версии строка не появляется вовсе —
     * то есть проверять было бы нечего.
     */
    await openPrompts(page);

    const ok = page.getByTestId('freshness-ok');

    await expect(ok).toContainText('Набор не мерит: Ответ человеку');
    await expect(ok).not.toContainText('presenter');
  });

  test('цикл целиком: создать, прогнать, включить, откатить', async ({ page }) => {
    /**
     * Условие плана дословно. Рядом с отказом лежит кнопка прогона:
     * заслон, который только запрещает, обходят — заслон, рядом с
     * которым лежит способ сделать правильно, соблюдают.
     *
     * Откат в конце проходит **без** нового прогона: прежнее сочетание
     * версий уже мерили и оно прошло. Заслон, мешающий откатиться,
     * опаснее отсутствующего — откатываются в аварию.
     */
    await openPrompts(page);

    const made = await makeHotfix(page, 'classifier@1', 'Разбери сказанное. Цикл целиком.');

    await page.getByTestId(`activate-${made}`).click();
    await expect(page.getByTestId('refusal')).toBeVisible();

    await page.getByTestId('measure').click();

    // Прогон идёт: панель говорит об этом, пока он не кончится.
    await expect(page.getByTestId('run-state')).toBeVisible();
    await expect(page.getByTestId('run-state')).toContainText('порог пройден', {
      timeout: 60_000,
    });

    await page.getByTestId(`activate-${made}`).click();

    await expect(
      page.getByTestId(`version-${made}`).getByTestId('active-classifier'),
    ).toBeVisible();
    await expect(page.getByTestId('refusal')).toHaveCount(0);

    // Откат.
    await page.getByTestId('activate-classifier@1').click();

    await expect(
      page.getByTestId('version-classifier@1').getByTestId('active-classifier'),
    ).toBeVisible();
    await expect(page.getByTestId('active-classifier')).toHaveCount(1);
  });

  test('включить без прогона можно, но только назвав это вслух', async ({ page }) => {
    /**
     * Заслон, который нельзя обойти вовсе, однажды снимут целиком —
     * вместе с защитой. Обойти можно, но не одним кликом: слово
     * набирается руками, и признание уходит в примечание версии
     * навсегда.
     */
    await openPrompts(page);

    const made = await makeHotfix(page, 'classifier@2', 'Разбери сказанное. Без прогона.');

    await page.getByTestId(`activate-${made}`).click();
    await expect(page.getByTestId('refusal')).toBeVisible();

    // Пока слово не набрано — кнопка не нажимается.
    await expect(page.getByTestId('force')).toBeDisabled();

    await page.getByTestId('ack-word').fill('да ладно');
    await expect(page.getByTestId('force')).toBeDisabled();

    await page.getByTestId('ack-word').fill('включаю без прогона');
    await page.getByTestId('force').click();

    await expect(
      page.getByTestId(`version-${made}`).getByTestId('active-classifier'),
    ).toBeVisible();

    // И это записано в версию — видно прямо в таблице.
    await expect(page.getByTestId(`version-${made}`)).toContainText('без прогона набора');

    await backToFirst(page);
  });
});
