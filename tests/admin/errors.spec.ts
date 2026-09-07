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

    await expect(page.getByTestId('errors')).toBeVisible();
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

    const section = page.getByTestId('failed-payments');

    await expect(section).toBeVisible();

    const row = page.getByRole('row', { name: /Оля/u });

    await expect(row).toContainText('399.00 ₽');
    await expect(row).toContainText('1.00');
    await expect(row).toContainText('карта');

    await expect(page.getByText('повтора нет и не будет', { exact: false })).toBeVisible();
  });
});
