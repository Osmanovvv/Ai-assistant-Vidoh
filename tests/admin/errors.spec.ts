import { expect, test } from '@playwright/test';

import { signIn } from './panel.js';

/**
 * Журнал сбоев (§15; задачи 4.10 и 4.12).
 *
 * §15: «журнал неуспешных вызовов и сбоев с возможностью повторного
 * запуска». Главное здесь — кнопка перезапуска: сбойные выгрузки
 * намеренно не переподхватываются, и до этой задачи человек, чей разбор
 * сорвался, не получал его никогда. Текст извинения (§17) обещал ему
 * «админку, из которой их перезапускают» — вот она, и вот проверка, что
 * обещание исполнено.
 */

test.describe('журнал сбоев (§15; задача 4.10)', () => {
  test('показывает сорвавшийся разбор: у кого, на чём и сколько попыток', async ({ page }) => {
    await signIn(page, 'Ошибки');

    await expect(page.getByTestId('errors')).toBeVisible();

    const failed = page.locator('[data-testid^="failed-batch-"]').first();

    await expect(failed).toBeVisible();
    await expect(failed).toContainText('Оля');
    await expect(failed).toContainText('распознавание не ответило');
  });

  test('текстов расшифровок в журнале нет', async ({ page }) => {
    /**
     * Видно, что разбор сорвался, у кого и на чём. Сказанное человеком —
     * в его карточке, где доступ к нему пишется в журнал §16. Журнал
     * ошибок читают часто и мимоходом, и чужим мыслям в нём делать
     * нечего.
     */
    await signIn(page, 'Ошибки');

    /**
     * **Утверждение привязано к видимой строке** — правка ревизии
     * четвёртого этапа.
     *
     * Прежде проверка читала весь раздел на отсутствие текста. Сорвавшийся
     * разбор на стенде ровно один, и соседняя проверка перезапуска его
     * съедает: на втором прогоне против того же стенда список пуст, и
     * «текстов расшифровок нет» становится утверждением о пустоте. То
     * есть проверка §16 переставала проверять §16, оставаясь зелёной.
     */
    const failed = page.locator('[data-testid^="failed-batch-"]').first();

    await expect(failed).toBeVisible();
    await expect(failed).toContainText('Оля');
    await expect(failed).not.toContainText('корм коту');
    await expect(page.getByTestId('errors')).not.toContainText('корм коту');

    // И об этом сказано словами, а не оставлено на догадку.
    await expect(page.getByText('Текстов расшифровок здесь нет')).toBeVisible();
  });

  test('неуспешный вызов модели виден вместе с тем, платили ли за него', async ({ page }) => {
    /**
     * Различие не косметическое: 403 не тарифится, а таймаут после
     * отправки — да (задача 3.82). Без этой колонки «неуспешный вызов»
     * читался бы как «бесплатный».
     */
    await signIn(page, 'Ошибки');

    await expect(page.getByText('429 Too Many Requests')).toBeVisible();
    await expect(page.getByText('classifier@9')).toBeVisible();
  });

  test('перезапуск возвращает разбор в очередь', async ({ page }) => {
    /**
     * Условие §15 «с возможностью повторного запуска» — и исполнение
     * обещания §17. После перезапуска выгрузка уходит из журнала:
     * она больше не сорвана.
     */
    await signIn(page, 'Ошибки');

    const restart = page.locator('[data-testid^="restart-"]').first();
    await expect(restart).toBeVisible();
    await restart.click();

    await expect(page.getByTestId('restart-done')).toBeVisible();
    await expect(page.getByTestId('no-failed-batches')).toBeVisible();
  });

  test('неудачный платёж виден с обеими суммами — задача 4.2', async ({ page }) => {
    /**
     * Самая дорогая строка журнала: человек заплатил и не получил
     * доступ. Разница между «ждали» и «пришло» и есть весь разбор —
     * показать одну сумму значило бы отправить разбирающего в журнал
     * провайдера за второй.
     *
     * И отдельно проверяется, что сказано про отсутствие повтора:
     * повторить списание — значит взять деньги второй раз, и молчание
     * об этом читалось бы как «кнопку забыли сделать».
     */
    await signIn(page, 'Ошибки');

    await expect(page.getByTestId('failed-payments')).toBeVisible();

    /**
     * **Строка ищется внутри своего разреза.**
     *
     * Прежде она искалась по всей странице (`page.getByRole('row', {name:
     * /Оля/})`), и это работало по случайности: у Оли была ровно одна
     * строка во всём журнале. Ревизия панели добавила ей и не дошедшее
     * письмо рассылки, и сорвавшееся напоминание — три строки на одно
     * имя, и строгий режим Playwright уронил бы проверку не по делу.
     */
    const payments = page.locator('.разрез').filter({ hasText: 'Неудачные платежи' });
    const row = payments.getByRole('row', { name: /Оля/u });

    await expect(row).toContainText('399.00 ₽');
    await expect(row).toContainText('1.00');
    await expect(row).toContainText('карта');

    await expect(page.getByText('повтора нет и не будет', { exact: false })).toBeVisible();
  });

  test('у неуспешного вызова модели видно, у кого он сорвался', async ({ page }) => {
    /**
     * Ревизия панели. Жалоба приходит от конкретного человека и в
     * конкретное время, а связать с ним строку было нечем: у соседней
     * таблицы сорвавшихся разборов имя есть, здесь его не было вовсе —
     * `userId` в выборку не входил, хотя в базе лежит и уже читается в
     * разрезах расходов. Вместо имени возился `batchId`, который не
     * рисовался нигде.
     *
     * Вторая строка того же разреза — вызов человека, удалившего данные:
     * §16 обнуляет `user_id`, и пустая клетка читалась бы как «имя
     * потеряли мы». Сказано словами.
     */
    await signIn(page, 'Ошибки');

    const calls = page.locator('.разрез').filter({ hasText: 'Неуспешные вызовы модели' });

    await expect(calls.getByRole('columnheader', { name: 'У кого' })).toBeVisible();
    await expect(calls.getByRole('row', { name: /429 Too Many Requests/u })).toContainText('Аня');
    await expect(calls.getByRole('row', { name: /DeadlineExceeded/u })).toContainText(
      'данные удалены',
    );
  });

  test('вид напоминания назван словом, а не кодом из базы', async ({ page }) => {
    /**
     * Ревизия панели. В колонке «Какое» стоял код `reminder_kind` —
     * «morning» в русской панели, — при том что соседние клетки того же
     * журнала переводят и рельс («карта»), и тариф («месяц»). Заказчица
     * читает такие строки как чужой отладочный вывод и перестаёт верить
     * колонке.
     *
     * Сорвавшихся напоминаний на стенде прежде не было ни одного, поэтому
     * словарь видов проверить было нечем: разрез показывал «за этот срок
     * нет», и проверка читала бы пустоту как «код больше не печатается».
     */
    await signIn(page, 'Ошибки');

    const reminders = page.locator('.разрез').filter({ hasText: 'Сорвавшиеся напоминания' });

    await expect(reminders.getByTestId('failed-reminders')).toBeVisible();
    await expect(reminders).toContainText('утреннее');
    await expect(reminders).not.toContainText('morning');
  });

  test('не дошедшее письмо названо вместе со своей рассылкой и получателем', async ({ page }) => {
    /**
     * Ревизия панели. Подпись велела идти к «нужной рассылке», а в строке
     * не было ни её времени, ни текста: `broadcastId` приезжал и не
     * рисовался, а раздел рассылки идентификаторов не печатает. «Кому»
     * было сырым телеграмным номером — по нему человека в панели не
     * найти, поиск в «Пользователях» идёт по имени и @имени.
     *
     * И совет назван вместе с условием: кнопка «Повторить неудачные» есть
     * только у законченной рассылки, у остановленной вместо неё
     * «Продолжить». Безусловный совет посылал бы человека нажимать
     * кнопку, которой нет.
     */
    await signIn(page, 'Ошибки');

    const sends = page.locator('.разрез').filter({ hasText: 'Не дошедшие письма рассылки' });

    await expect(sends.getByRole('columnheader', { name: 'Из какой рассылки' })).toBeVisible();

    const letter = sends.getByRole('row', { name: /message is too long/u });

    await expect(letter).toContainText('Оля');
    await expect(letter).toContainText('Оплата открылась');

    await expect(sends).toContainText('только у законченной');
    await expect(sends).toContainText('«Продолжить»');
  });

  test('неудачные платежи отбираются по времени отказа, а не по дате счёта', async ({ page }) => {
    /**
     * Ревизия панели, с новым столбцом в базе. Счёт заводится в момент
     * нажатия кнопки и живёт до `expires_at`, а недоплата приходит
     * уведомлением провайдера тогда, когда человек соберётся заплатить.
     * Отбор шёл по дате счёта — и продление, отвергнутое банком сегодня
     * по счёту трёхдневной давности, при выборе «сутки» в журнал не
     * попадало вовсе: самое свежее событие было не видно именно там, где
     * его ищут. В колонке «Когда» при этом стояла дата счёта, то есть не
     * время разбираемого события.
     *
     * Стенд сеет ровно эту строку: `created_at` — три дня назад,
     * `failed_at` — сейчас.
     */
    await signIn(page, 'Ошибки');

    await page.getByRole('button', { name: 'сутки' }).click();

    const payments = page.locator('.разрез').filter({ hasText: 'Неудачные платежи' });
    const refused = payments.getByRole('row', { name: /банк отклонил списание/u });

    // Под прежним отбором строки здесь не было бы вовсе.
    await expect(refused).toBeVisible();
    await expect(refused).toContainText('продление');

    /**
     * И «Когда» — сегодня, а не три дня назад.
     *
     * Дата считается в поясе, который задан проверкам
     * (`playwright.config.ts`), а не в поясе машины: панель печатает
     * время по часам браузера, и на машине в другом поясе проверка
     * краснела бы от переезда, а не от поломки.
     */
    const today = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      dateStyle: 'short',
    }).format(new Date());

    await expect(refused.locator('td').first()).toContainText(today);
  });

  test('пустой разрез называет пустоту словами, а не исчезает с заголовком', async ({ page }) => {
    /**
     * Ревизия панели. Три разреза из шести были обёрнуты в `length > 0`:
     * при пустом списке с экрана пропадал и заголовок. Проджект,
     * разбирающий «я заплатил, доступ не дали», не видел раздела платежей
     * вовсе и не мог отличить «неудачных платежей за сутки не было» от
     * «журнал платежей не показывает» — то есть шёл спрашивать нас.
     *
     * Пустота подменяется нарочно: на стенде каждый источник посеян
     * непустым (иначе не проверить сами таблицы), а добиться пустоты
     * можно только удалением посева. Форма ответа настоящая — та же, что
     * отдаёт сервер на периоде без сбоев.
     */
    await page.route('**/admin/api/errors?*', async (route) => {
      await route.fulfill({
        json: {
          days: 1,
          batches: [],
          calls: [],
          sends: [],
          payments: [],
          reminders: [],
          batchesTotal: 0,
          callsTotal: 0,
          paymentsTotal: 0,
          sendsTotal: 0,
          remindersTotal: 0,
          missing: [],
        },
      });
    });

    await signIn(page, 'Ошибки');

    await expect(page.getByTestId('no-failed-batches')).toBeVisible();
    await expect(page.getByTestId('no-failed-payments')).toBeVisible();
    await expect(page.getByTestId('no-failed-sends')).toBeVisible();
    await expect(page.getByTestId('no-failed-reminders')).toBeVisible();
    await expect(page.getByText('Неуспешных вызовов за этот срок нет.')).toBeVisible();

    // Заголовки на месте: пустой журнал — это ответ, а не отсутствие
    // раздела. И совет про повтор у пустого списка спрятан: повторять
    // нечего.
    await expect(page.getByRole('heading', { name: /Неудачные платежи/u })).toBeVisible();
    await expect(page.getByTestId('errors')).not.toContainText('Повторить их можно в разделе');
  });

  test('под каждым списком сказано, сколько строк скрыла обрезка', async ({ page }) => {
    /**
     * Ревизия панели. Сервер отдаёт последние пятьдесят строк и число за
     * период рядом, но словами об этом говорил только журнал доступа §16.
     * В сбое, который и порождает сотни срывов (модель лежала час),
     * разбирающий решил бы, что перезапустил всех, а перезапустил
     * последних пятьдесят.
     *
     * Итог подменяется, а списки берутся настоящие: пятидесяти одной
     * строки на стенде нет и заводить их ради подписи значило бы сеять
     * то, чего в бою в таком количестве не бывает. Пять журналов плюс
     * журнал доступа — шесть строк об обрезке, все одними словами.
     */
    await page.route('**/admin/api/errors?*', async (route) => {
      const answer = await route.fetch();
      const body = (await answer.json()) as Record<string, unknown>;

      await route.fulfill({
        json: {
          ...body,
          batchesTotal: 137,
          callsTotal: 137,
          paymentsTotal: 137,
          sendsTotal: 137,
          remindersTotal: 137,
        },
      });
    });

    await page.route('**/admin/api/access?*', async (route) => {
      const answer = await route.fetch();
      const body = (await answer.json()) as Record<string, unknown>;

      await route.fulfill({ json: { ...body, total: 137 } });
    });

    await signIn(page, 'Ошибки');

    await expect(page.getByTestId('errors')).toBeVisible();
    await expect(
      page.locator('p.оговорка', { hasText: /Показаны последние \d+ из 137\./u }),
    ).toHaveCount(6);
  });
});

test.describe('журнал доступа к персональным данным (§16, обещание задачи 4.10)', () => {
  /**
   * **Обещание, которое ревизия четвёртого этапа нашла неисполненным.**
   * План сказал дословно: «И сам журнал как раздел панели (§15 не просит
   * его показывать, но разбирать инцидент по SQL неудобно) — это 4.10,
   * где живут журналы». Задачу закрыли, раздел не появился, а читателей
   * у таблицы не было ни одного вне тестов. Журнал без читателя исполняет
   * §16 на бумаге: он отвечает на вопрос «кто смотрел данные этого
   * человека» только тому, у кого есть SQL к боевой базе.
   */

  test('обращение к карточке видно в журнале доступа — с тем, на кого смотрели', async ({
    page,
  }) => {
    // Сначала настоящее обращение: открываем карточку человека.
    await signIn(page, 'Пользователи');
    await page.getByRole('button', { name: 'Аня' }).click();
    await expect(page.getByTestId('card')).toBeVisible();

    await page.getByRole('button', { name: 'Ошибки' }).click();

    const log = page.getByTestId('access');

    await expect(log).toBeVisible();
    await expect(log.getByRole('row', { name: /people\/:userId/u }).first()).toBeVisible();
  });

  test('у списка стоит настоящее число людей, а не выдуманная единица', async ({ page }) => {
    /**
     * Столбец стоял `not null default 1`, а записывать в него было нечему:
     * умолчание базы утверждало «в ответ попал один человек» про каждую
     * страницу списка. Разбирающий инцидент сделал бы из этого вывод,
     * обратный правде.
     */
    await signIn(page, 'Пользователи');
    await expect(page.getByTestId('people')).toBeVisible();

    await page.getByRole('button', { name: 'Ошибки' }).click();

    const log = page.getByTestId('access');

    // Строка ищется по клетке пути, а не по имени строки: имя строки —
    // это все её клетки слитно, и «оканчивается на /api/people» в нём не
    // проверить.
    const people = log
      .locator('tr', { has: page.locator('td', { hasText: /^\/api\/people$/u }) })
      .first();

    await expect(people).toBeVisible();

    /**
     * На стенде посеян один человек — значит и в журнале единица, но
     * взятая **с ответа**. Отличить её от прежней выдуманной единицы
     * можно на разделе, где число людей не известно: там теперь стоит «не
     * установлено», а прежде стояла та же единица.
     */
    const errorsRow = log
      .locator('tr', { has: page.locator('td', { hasText: /^\/api\/errors$/u }) })
      .first();

    await expect(errorsRow).toContainText('не установлено');
  });

  test('имён людей в журнале доступа нет', async ({ page }) => {
    /**
     * Раздел про обращения, а не про людей. Покажи он имена — журнал
     * доступа сам стал бы вторым списком людей, то есть новой утечкой
     * вместо защиты.
     */
    await signIn(page, 'Ошибки');

    await expect(page.getByTestId('access')).toBeVisible();
    await expect(page.getByTestId('access')).not.toContainText('Оля');
  });

  test('отказ перезапуска назван словами сервера, а журнал остаётся на экране', async ({
    page,
  }) => {
    /**
     * Ревизия панели. Обработчик был написан как
     * `.catch(() => setProblem('Не удалось перезапустить'))`: аргумент
     * ошибки не принимался, хотя сервер называет три разные причины —
     * «такой выгрузки нет», «выгрузка в состоянии done, а не failed» и
     * «выгрузку уже перезапустили». Последняя показывалась как
     * «Не удалось перезапустить», то есть панель говорила неправду о
     * том, что сама же и сделала.
     *
     * Хуже второе: `problem` возвращался **вместо всего раздела** — с
     * экрана уходили и сорвавшиеся разборы, и журнал доступа §16, до
     * перезагрузки страницы.
     *
     * Отказ подменяется нарочно: проверяется поведение панели, а не
     * сервера — у того свои проверки, и добиться от него 409 на стенде
     * можно только вторым нажатием, когда кнопки уже нет.
     */
    /**
     * Сорвавшаяся выгрузка **досеивается в ответ**, а не берётся со
     * стенда: единственную посеянную забирает соседняя проверка
     * («перезапуск возвращает разбор в очередь»), и тест, опирающийся на
     * её остаток, краснел бы от порядка запуска, а не от поломки. Форма
     * ответа при этом настоящая — своя строка добавляется к тому, что
     * отдал сервер.
     */
    await page.route('**/admin/api/errors?*', async (route) => {
      const answer = await route.fetch();
      const body = (await answer.json()) as { batches?: unknown[]; batchesTotal?: number };
      const batches = [
        ...(body.batches ?? []),
        {
          id: '00000000-0000-4000-8000-000000000042',
          userId: null,
          who: 'Проверочный',
          tgId: null,
          status: 'failed',
          attempts: 3,
          error: 'модель не ответила',
          openedAt: new Date(0).toISOString(),
          length: 12,
        },
      ];

      await route.fulfill({
        json: { ...body, batches, batchesTotal: batches.length },
      });
    });

    await page.route('**/admin/api/errors/batch/*/restart', async (route) => {
      await route.fulfill({
        status: 409,
        json: { error: 'выгрузку уже перезапустили' },
      });
    });

    await signIn(page, 'Ошибки');

    const restart = page.getByTestId('restart-00000000-0000-4000-8000-000000000042');
    await expect(restart).toBeVisible();
    await restart.click();

    const refused = page.getByTestId('batch-refused');

    await expect(refused).toBeVisible();
    await expect(refused).toContainText('уже перезапустили');

    // Раздел на месте целиком: и журнал сбоев, и журнал доступа.
    await expect(page.getByTestId('errors')).toBeVisible();
    await expect(page.getByTestId('access')).toBeVisible();
  });
});
