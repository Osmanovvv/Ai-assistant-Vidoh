import { createHmac } from 'node:crypto';

import { expect, test } from '@playwright/test';

/**
 * Вход в панель глазами человека (§15 ТЗ, задача 4.5).
 *
 * План просит именно Playwright и именно на три случая: вход, неверный
 * пароль, второй шаг. Проверка «API без пропуска ничего не отдаёт»
 * живёт отдельно и на уровне сервера — там её сорок четыре штуки.
 *
 * **Здесь проверяется то, чего не видно из API:** что два шага человек
 * действительно проходит как два, что отказ выглядит отказом, а не
 * пустым экраном, и что после входа он оказывается в панели. Ошибка в
 * этом месте не ломает ни один серверный тест — окно входа просто
 * перестаёт работать.
 *
 * Стенд поднимает `playwright.config.ts`: тот же сервер, что в бою, с
 * секретом кодов из RFC 6238 — поэтому код здесь считается, а не
 * вводится наугад.
 */

/** Секрет стенда — тот же, что в `admin-e2e-server.ts`. */
const SECRET = Buffer.from('12345678901234567890', 'ascii');

const LOGIN = 'аня';
const PASSWORD = 'очень-длинный-пароль-42';

/**
 * Код на текущую секунду.
 *
 * Считается здесь, а не берётся из кода панели: проверка не должна
 * зависеть от того, что проверяет. Если алгоритм в панели однажды
 * разойдётся со стандартом, эта проверка покраснеет — а взяв её
 * реализацию оттуда же, она осталась бы зелёной.
 */
function currentCode(): string {
  const step = Math.floor(Date.now() / 1000 / 30);

  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step % 2 ** 32, 4);

  const digest = createHmac('sha1', SECRET).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const slice =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return String(slice % 1_000_000).padStart(6, '0');
}

/**
 * Вход целиком и переход в нужный раздел.
 *
 * Одним помощником на весь файл: раньше их было два, и когда панель
 * стала открываться на «Обзоре», один из них перестал работать, а
 * второй нет. Одна дорога — одно место, где её править.
 */
async function signIn(
  page: import('@playwright/test').Page,
  tab?: 'Обзор' | 'Пользователи' | 'Расходы' | 'Настройки',
): Promise<void> {
  await page.goto('/admin/');
  await page.locator('input[name="login"]').fill(LOGIN);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Дальше' }).click();
  await page.locator('input[name="code"]').fill(currentCode());
  await page.getByRole('button', { name: 'Войти' }).click();

  // Панель открывается на «Обзоре»: дождаться его — значит дождаться
  // входа, а не гадать по таймауту.
  await expect(page.getByTestId('overview')).toBeVisible();

  if (tab !== undefined && tab !== 'Обзор') {
    await page.getByRole('button', { name: tab }).click();
  }
}

test.describe('окно входа', () => {
  test('открывается и просит логин с паролем, а не код сразу', async ({ page }) => {
    await page.goto('/admin/');

    await expect(page.getByRole('heading', { name: 'ВЫДОХ' })).toBeVisible();
    await expect(page.getByText('Панель управления')).toBeVisible();
    await expect(page.locator('input[name="login"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();

    // Кода на первом шаге быть не должно: шаги идут по одному.
    await expect(page.locator('input[name="code"]')).toHaveCount(0);
  });

  test('неверный пароль — отказ, и панель не открывается', async ({ page }) => {
    await page.goto('/admin/');

    await page.locator('input[name="login"]').fill(LOGIN);
    await page.locator('input[name="password"]').fill('не тот пароль');
    await page.getByRole('button', { name: 'Дальше' }).click();

    await expect(page.getByRole('alert')).toHaveText('Не получилось войти');

    // Остались на первом шаге: ни кода, ни панели.
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.locator('input[name="code"]')).toHaveCount(0);
    await expect(page.getByText('ВЫДОХ — панель')).toHaveCount(0);
  });

  test('верный пароль ведёт на второй шаг, но панель ещё закрыта', async ({ page }) => {
    /**
     * Главное свойство §15 глазами человека: пароль сошёлся, а панели
     * нет — есть поле для кода. Если бы после пароля открывалась панель,
     * шагов было бы не два, а один.
     */
    await page.goto('/admin/');

    await page.locator('input[name="login"]').fill(LOGIN);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Дальше' }).click();

    await expect(page.getByText('Код из приложения')).toBeVisible();
    await expect(page.locator('input[name="code"]')).toBeVisible();
    await expect(page.getByText('ВЫДОХ — панель')).toHaveCount(0);
  });

  test('неверный код на втором шаге тоже не пускает', async ({ page }) => {
    await page.goto('/admin/');

    await page.locator('input[name="login"]').fill(LOGIN);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Дальше' }).click();

    await page.locator('input[name="code"]').fill('000000');
    await page.getByRole('button', { name: 'Войти' }).click();

    await expect(page.getByRole('alert')).toHaveText('Не получилось войти');
    await expect(page.getByText('ВЫДОХ — панель')).toHaveCount(0);
  });

  test('код открывает панель, и в ней видно, кто вошёл', async ({ page }) => {
    await page.goto('/admin/');

    await page.locator('input[name="login"]').fill(LOGIN);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Дальше' }).click();

    await page.locator('input[name="code"]').fill(currentCode());
    await page.getByRole('button', { name: 'Войти' }).click();

    await expect(page.getByText('ВЫДОХ — панель')).toBeVisible();
    await expect(page.getByText(LOGIN, { exact: false })).toBeVisible();
  });

  test('«Начать заново» возвращает к паролю, а не запирает', async ({ page }) => {
    // Приложение с кодом может оказаться на другом телефоне: тупик без
    // выхода — худшее, что можно сделать с окном входа.
    await page.goto('/admin/');

    await page.locator('input[name="login"]').fill(LOGIN);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Дальше' }).click();

    await expect(page.locator('input[name="code"]')).toBeVisible();
    await page.getByRole('button', { name: 'Начать заново' }).click();

    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.locator('input[name="code"]')).toHaveCount(0);
  });

  test('после выхода панель снова просит вход', async ({ page }) => {
    await page.goto('/admin/');

    await page.locator('input[name="login"]').fill(LOGIN);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Дальше' }).click();
    await page.locator('input[name="code"]').fill(currentCode());
    await page.getByRole('button', { name: 'Войти' }).click();

    await expect(page.getByText('ВЫДОХ — панель')).toBeVisible();
    await page.getByRole('button', { name: 'выйти' }).click();

    await expect(page.locator('input[name="password"]')).toBeVisible();
  });
});

test.describe('панель закрыта от индексации (§15)', () => {
  test('robots.txt запрещает раздел, а страница несёт мета-запрет', async ({ page, request }) => {
    const robots = await request.get('/robots.txt');
    expect(await robots.text()).toContain('Disallow: /admin');

    await page.goto('/admin/');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/u);
  });
});

test.describe('палитра из §12.4', () => {
  test('фон и основной акцент — те, что задал брендбук', async ({ page }) => {
    /**
     * §12.4 задаёт палитру дословно, и она общая для панели, лендинга и
     * графики. Проверка на цвет — не придирка: панель, покрашенная «на
     * глаз», выглядит чужой продукту, а заметить это по коду нельзя.
     */
    await page.goto('/admin/');

    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).toBe('rgb(247, 243, 239)');

    const button = await page
      .getByRole('button', { name: 'Дальше' })
      .evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(button).toBe('rgb(107, 78, 78)');
  });
});

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
