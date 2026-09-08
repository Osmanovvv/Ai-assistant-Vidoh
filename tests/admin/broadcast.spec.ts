import { expect, test, type Page } from '@playwright/test';

import { signIn } from './panel.js';

/**
 * Рассылка (§15; задачи 4.10 и 4.12).
 *
 * План требует «Playwright на предпросмотр и остановку». Оба — про то,
 * что нельзя проверить на сервере: предпросмотр и подтверждение
 * существуют ровно затем, чтобы человек не отправил тысяче людей
 * черновик, а кнопка «Остановить» — чтобы он мог передумать посреди
 * отправки. Это поведение экрана, и проверяется оно в браузере.
 *
 * Отправка на стенде подменена: писем в Telegram нет, но код рассылки
 * настоящий — темп, пропуск заблокировавших, остановка перед следующим
 * письмом.
 */

test.describe.configure({ mode: 'serial' });

async function openBroadcast(page: Page): Promise<void> {
  await signIn(page, 'Рассылка');
  await expect(page.getByTestId('broadcast')).toBeVisible();
}

test.describe('рассылка (§15; задача 4.10)', () => {
  test('предпросмотр показывает число получателей и ничего не отправляет', async ({ page }) => {
    /**
     * §15 требует предпросмотра с подтверждением. Предпросмотр обязан
     * быть безобидным: человек вправе посмотреть, скольким уйдёт, и
     * уйти, не оставив ни черновика, ни письма.
     */
    await openBroadcast(page);

    await page.getByTestId('broadcast-text').fill('Оплата открылась, заходите.');
    await page.getByTestId('broadcast-preview').click();

    const preview = page.getByTestId('preview-result');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Получателей');

    // Подтверждения ещё нет: предпросмотр не создаёт рассылку.
    await expect(page.getByTestId('broadcast-confirm')).toHaveCount(0);
  });

  test('подтверждение показывает, скольким и что именно уйдёт', async ({ page }) => {
    /**
     * Отправленное не отзывается: тысяча человек уже прочла. Поэтому
     * перед отправкой человек видит и число адресатов, и сам текст —
     * тот, что уйдёт, а не тот, что он помнит.
     */
    await openBroadcast(page);

    await page.getByTestId('broadcast-text').fill('Проверочная рассылка про оплату.');
    await page.getByTestId('broadcast-preview').click();
    await page.getByTestId('broadcast-make').click();

    const confirm = page.getByTestId('broadcast-confirm');

    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('человек получат это сообщение');
    await expect(confirm).toContainText('Проверочная рассылка про оплату.');
  });

  test('сегмент без получателей не даёт составить рассылку', async ({ page }) => {
    /**
     * Кнопка «Составить», ведущая к рассылке в ноль адресов, обманывает:
     * человек уверен, что письмо ушло. Панель говорит прямо.
     */
    await openBroadcast(page);

    await page.getByTestId('broadcast-text').fill('Кому-нибудь.');
    await page.getByTestId('broadcast-segment').selectOption('trialSpent');
    await page.getByTestId('broadcast-preview').click();

    const preview = page.getByTestId('preview-result');
    await expect(preview).toContainText('Получателей: 0');
    await expect(preview).toContainText('Отправлять некому');
    await expect(page.getByTestId('broadcast-make')).toHaveCount(0);
  });

  test('останавливается по кнопке — условие готовности 4.10', async ({ page }) => {
    /**
     * **Главная проверка раздела.** Кнопка обязана останавливать
     * рассылку на середине, а не «когда кончится порция».
     *
     * Панель показывает «останавливаю», а «остановлена» — только когда
     * отправка действительно встала: воркер может быть в середине
     * письма. Врать про остановку хуже, чем подождать секунду.
     */
    await openBroadcast(page);

    await page.getByTestId('broadcast-text').fill('Долгая рассылка для остановки.');
    await page.getByTestId('broadcast-preview').click();
    await page.getByTestId('broadcast-make').click();
    await page.getByTestId('broadcast-send').click();

    // Рассылка появилась в списке и идёт.
    const running = page.locator('[data-testid^="broadcast-stop-"]').first();
    await expect(running).toBeVisible();

    await running.click();

    // Через несколько секунд она объявляет себя остановленной, а не
    // «идущей» и не «разосланной».
    const status = page.locator('[data-testid^="broadcast-status-"]').first();

    await expect(status).toHaveText('остановлена', { timeout: 20_000 });

    // И часть людей не получила письма: рассылка встала, а не дошла.
    const row = page.locator('tbody tr').first();
    const left = await row.locator('td').nth(7).textContent();

    expect(Number(left ?? '0')).toBeGreaterThan(0);
  });
});

test.describe('остановленная рассылка не тупик', () => {
  test('продолжается с того места, где встала', async ({ page }) => {
    /**
     * **Без этой кнопки остановка была ловушкой.** Остановил, передумал —
     * и продолжить нечем: пришлось бы составлять новую, а она ушла бы
     * **всем**, включая тех, кто письмо уже прочёл. Кнопка «Остановить»
     * тем самым означала «или доотправить сейчас, или прислать половине
     * людей второе письмо».
     */
    await openBroadcast(page);

    await page.getByTestId('broadcast-text').fill('Рассылка, которую продолжат.');
    await page.getByTestId('broadcast-preview').click();
    await page.getByTestId('broadcast-make').click();
    await page.getByTestId('broadcast-send').click();

    const stop = page.locator('[data-testid^="broadcast-stop-"]').first();
    await expect(stop).toBeVisible();
    await stop.click();

    const status = page.locator('[data-testid^="broadcast-status-"]').first();
    await expect(status).toHaveText('остановлена', { timeout: 20_000 });

    const row = page.locator('tbody tr').first();
    const sentBefore = Number((await row.locator('td').nth(4).textContent()) ?? '0');

    // Продолжаем — и рассылка доходит до конца, никого не задев дважды.
    await page.locator('[data-testid^="broadcast-resume-"]').first().click();

    await expect(status).toHaveText('разослана', { timeout: 20_000 });

    const sentAfter = Number((await row.locator('td').nth(4).textContent()) ?? '0');
    const left = Number((await row.locator('td').nth(7).textContent()) ?? '1');

    expect(sentAfter).toBeGreaterThan(sentBefore);
    expect(left).toBe(0);
  });

  test('черновик не тупик: его видно в списке, можно отправить и можно отменить', async ({
    page,
  }) => {
    /**
     * Ревизия панели. «Составить» заводит и рассылку, и до тысячи строк
     * доставки, а кнопка «Отправить» жила только в состоянии React: уход
     * в другой раздел или обновление страницы стирали её, и у строки со
     * статусом «черновик» не оставалось ни одного действия. Отменить его
     * было нечем вовсе — значит единственным выходом из ошибочного
     * черновика была отправка всем.
     *
     * Проверка нарочно **уходит и возвращается**: без этого блок
     * подтверждения остался бы на экране и дефекта не было бы видно.
     */
    await openBroadcast(page);

    await page.getByTestId('broadcast-text').fill('Черновик, который я передумал отправлять.');
    await page.getByTestId('broadcast-preview').click();
    await page.getByTestId('broadcast-make').click();
    await expect(page.getByTestId('broadcast-confirm')).toBeVisible();

    // Уходим в другой раздел и возвращаемся: блок подтверждения пропал.
    await page.getByRole('button', { name: 'Обзор' }).click();
    await page.getByRole('button', { name: 'Рассылка' }).click();
    await expect(page.getByTestId('broadcast-confirm')).toHaveCount(0);

    // Строка черновика на месте, и у неё есть оба действия.
    const draft = page
      .locator('tr')
      .filter({ hasText: 'Черновик, который я передумал отправлять.' });

    await expect(draft).toHaveCount(1);
    await expect(draft.getByRole('button', { name: 'Отправить' })).toBeVisible();

    await draft.getByRole('button', { name: 'Отменить' }).click();

    // Отменённый черновик уходит из списка вместе со своими доставками.
    await expect(
      page.locator('tr').filter({ hasText: 'Черновик, который я передумал отправлять.' }),
    ).toHaveCount(0);
  });

  test('названную сервером причину отказа панель показывает, а раздел не гасит', async ({
    page,
  }) => {
    /**
     * Ревизия панели. Все семь обработчиков раздела были написаны как
     * `.catch(() => setProblem('…'))`: объект ошибки не принимался, и
     * названная сервером причина — «слишком длинно: N знаков, Telegram
     * принимает 4096» — превращалась в «Не удалось составить рассылку».
     * Первое человек исправит, второе не исправит ничего.
     *
     * Хуже второе: `problem` возвращался **вместо всего раздела**, и
     * набранный текст исчезал с экрана вместе со списком рассылок.
     */
    await openBroadcast(page);

    // 4200 знаков: предел Telegram — 4096, и сервер называет оба числа.
    await page.getByTestId('broadcast-text').fill('я'.repeat(4_200));
    await page.getByTestId('broadcast-preview').click();
    await page.getByTestId('broadcast-make').click();

    const refused = page.getByTestId('broadcast-refused');

    await expect(refused).toBeVisible();
    await expect(refused).toContainText('4096');

    // Раздел на месте: и поле с набранным текстом, и список рассылок.
    await expect(page.getByTestId('broadcast')).toBeVisible();
    await expect(page.getByTestId('broadcast-text')).toHaveValue('я'.repeat(4_200));
  });
});
