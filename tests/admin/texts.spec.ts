import { expect, test } from '@playwright/test';

import { signIn } from './panel.js';

/**
 * Редактор реплик (§13.9; задача 4.13).
 *
 * §13.9 дословно: «Все тексты хранятся в отдельном словаре и меняются
 * **без выкладки новой версии приложения**». Словарь отдельный был со
 * второго этапа, а правился только выкладкой — требование исполнялось
 * наполовину, и план обещал источник из базы «на четвёртом этапе».
 *
 * **Проверяется сквозной путь и главное свойство: отказ говорит словами
 * правила.** Пока реплики менялись выкладкой, их смотрел прогон и чужой
 * взгляд; теперь между набранной фразой и живым человеком стоит только
 * проверка §13 на сервере. Значит панель обязана донести её причину, а не
 * сказать «не удалось сохранить».
 */

const PLAIN = 'limits.trialOver';
const WITH_PLACE = 'resolver.noted';

test.describe('реплики бота (§13.9; задача 4.13)', () => {
  test('показывает реплики, число подстановок и что здесь править нельзя', async ({ page }) => {
    await signIn(page, 'Реплики');

    await expect(page.getByTestId('texts')).toBeVisible();

    // Простая реплика — с полем, готовым к правке.
    await expect(page.getByTestId(`text-input-${PLAIN}`)).toBeVisible();

    // У реплики с подстановкой сказано, что её нельзя терять, — иначе
    // человек сотрёт «{1}» и получит отказ, не поняв, за что.
    await expect(page.getByTestId(`text-${WITH_PLACE}`)).toContainText('{1}');

    // И названо, чего в списке нет: «чего-то нет» читается как потеря,
    // если причина не рядом.
    await expect(page.getByTestId('text-hidden-card.statusName')).toContainText(
      'таблица состояний',
    );
  });

  test('правка сохраняется, помечается и возвращается к словам из кода', async ({ page }) => {
    await signIn(page, 'Реплики');

    const field = page.getByTestId(`text-input-${PLAIN}`);
    const fromCode = (await field.inputValue()).trim();

    await field.fill('Пробные разборы кончились, выбери тариф.');
    await page.getByTestId(`text-save-${PLAIN}`).click();

    await expect(page.getByTestId('texts-saved')).toContainText('уже сейчас');
    await expect(page.getByTestId(`text-edited-${PLAIN}`)).toBeVisible();

    // Слова из кода показаны рядом: человек должен видеть, к чему вернуться.
    await expect(page.getByTestId(`text-${PLAIN}`)).toContainText(fromCode.slice(0, 24));

    // Пустое поле возвращает реплику к словам из кода — отдельной кнопки
    // для этого не нужно.
    await page.getByTestId(`text-input-${PLAIN}`).fill('');
    await page.getByTestId(`text-save-${PLAIN}`).click();

    await expect(page.getByTestId('texts-saved')).toContainText('словами из кода');
    await expect(page.getByTestId(`text-edited-${PLAIN}`)).toHaveCount(0);
    await expect(page.getByTestId(`text-input-${PLAIN}`)).toHaveValue(fromCode);
  });

  test('отказ называет правило §13, а не «не удалось сохранить»', async ({ page }) => {
    /**
     * Главное свойство редактора. «В реплике не бывает двух вопросов, а
     * здесь их два» человек исправит сам; «не удалось сохранить» не
     * исправит ничего, и он либо бросит, либо позовёт разработчика.
     */
    await signIn(page, 'Реплики');

    await page.getByTestId(`text-input-${PLAIN}`).fill('Разобрать дела? Или на сегодня хватит?');
    await page.getByTestId(`text-save-${PLAIN}`).click();

    const refused = page.getByTestId(`text-refused-${PLAIN}`);

    await expect(refused).toBeVisible();
    await expect(refused).toContainText('двух вопросов');

    // Раздел при этом остаётся на экране, и набранный текст никуда не
    // девается: человек правит его же, а не набирает заново.
    await expect(page.getByTestId('texts')).toBeVisible();
    await expect(page.getByTestId(`text-input-${PLAIN}`)).toHaveValue(
      'Разобрать дела? Или на сегодня хватит?',
    );
  });

  test('потерянную подстановку не принимает и говорит, какую', async ({ page }) => {
    await signIn(page, 'Реплики');

    await page.getByTestId(`text-input-${WITH_PLACE}`).fill('Дописала подробность.');
    await page.getByTestId(`text-save-${WITH_PLACE}`).click();

    await expect(page.getByTestId(`text-refused-${WITH_PLACE}`)).toContainText('{1}');
  });

  test('поиск находит реплику по словам', async ({ page }) => {
    // Двести с лишним реплик глазами не перебирают.
    await signIn(page, 'Реплики');

    await page.getByTestId('texts-search').fill('пробн');

    await expect(page.getByTestId(`text-input-${PLAIN}`)).toBeVisible();
    await expect(page.getByTestId(`text-${WITH_PLACE}`)).toHaveCount(0);
  });

  test('раздел реплик закрыт без входа', async ({ request }) => {
    const answer = await request.get('/admin/api/texts', { failOnStatusCode: false });

    expect(answer.status()).toBe(401);
  });
});
