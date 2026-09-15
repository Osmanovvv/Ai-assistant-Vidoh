import { expect, test } from '@playwright/test';

import { signIn } from './panel.js';

/**
 * Документы в панели (15.09.2026).
 *
 * Заказчица правит оферту, политику, соглашение и согласие сама, в
 * редакторе «как в Word», а страницу отдаёт бот по `/docs/<документ>`.
 * Проверяется сквозной путь глазами заказчицы: набрала — сохранила —
 * открыла страницу — увидела свой текст; вернула прежнюю версию — на
 * странице прежний текст. Всё остальное (чистка разметки, отказы,
 * история) покрыто проверками сервера.
 */

const FIRST = 'Первая редакция оферты, набранная в панели.';
const SECOND = 'Вторая редакция: абзац дописан.';

test.describe('документы (15.09.2026)', () => {
  test('незаполненный документ открывается, сохраняется и сразу виден по ссылке', async ({
    page,
  }) => {
    await signIn(page, 'Документы');

    await expect(page.getByTestId('documents')).toBeVisible();
    await expect(page.getByTestId('document-open-oferta')).toBeVisible();

    await page.getByTestId('document-open-oferta').click();
    await expect(page.getByTestId('document')).toBeVisible();

    // Пока не сохранено — сохранять нечего и открывать нечего.
    await expect(page.getByTestId('document-save')).toBeDisabled();
    await expect(page.getByTestId('document-public')).toHaveCount(0);

    const editor = page.getByTestId('document-editor').locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type(FIRST);
    await page.getByTestId('document-date').fill('2026-10-01');

    await expect(page.getByTestId('document-save')).toBeEnabled();
    await page.getByTestId('document-save').click();

    await expect(page.getByTestId('document-said')).toContainText('опубликовано');
    await expect(page.getByTestId('document-public')).toHaveAttribute('href', '/docs/oferta');
    await expect(page.getByTestId('document-version')).toHaveCount(1);

    // Страница отдаёт этот текст уже сейчас — ровно то, что обещает панель.
    const published = await page.request.get('/docs/oferta');
    expect(published.status()).toBe(200);
    const html = await published.text();
    expect(html).toContain(FIRST);
    expect(html).toContain('Редакция от 1 октября 2026');
  });

  test('прежняя версия возвращается в редактор, и после сохранения она на странице', async ({
    page,
  }) => {
    await signIn(page, 'Документы');
    await page.getByTestId('document-open-oferta').click();

    const editor = page.getByTestId('document-editor').locator('.ProseMirror');
    await expect(editor).toContainText(FIRST);

    // Дописать абзац и сохранить — вторая версия.
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type(SECOND);
    await page.getByTestId('document-save').click();
    await expect(page.getByTestId('document-said')).toContainText('опубликовано');
    await expect(page.getByTestId('document-version')).toHaveCount(2);
    expect(await (await page.request.get('/docs/oferta')).text()).toContain(SECOND);

    // Вернуть первую: в редакторе прежний текст, сохранить нужно отдельно.
    await page.getByTestId('document-restore').first().click();
    await expect(page.getByTestId('document-said')).toContainText('Прежняя версия');
    await expect(editor).not.toContainText(SECOND);
    await expect(page.getByTestId('document-save')).toBeEnabled();

    await page.getByTestId('document-save').click();
    await expect(page.getByTestId('document-said')).toContainText('опубликовано');
    await expect(page.getByTestId('document-version')).toHaveCount(3);

    const html = await (await page.request.get('/docs/oferta')).text();
    expect(html).toContain(FIRST);
    expect(html).not.toContain(SECOND);
  });

  test('пустой документ не сохраняется, и отказ назван словами', async ({ page }) => {
    await signIn(page, 'Документы');
    await page.getByTestId('document-open-politika').click();

    const editor = page.getByTestId('document-editor').locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('а');
    await page.keyboard.press('Backspace');
    await expect(page.getByTestId('document-save')).toBeEnabled();

    await page.getByTestId('document-save').click();

    await expect(page.getByTestId('document-refused')).toContainText('пуст');
    expect((await page.request.get('/docs/politika')).status()).toBe(404);
  });
});
