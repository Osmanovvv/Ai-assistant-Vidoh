import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { defaultTexts } from '../../apps/bot/src/texts/index.js';

/**
 * Визуальная проверка тем (задача 2.24).
 *
 * Три сценария, не больше — так стоит в плане:
 *
 * 1. ветки видны и подписаны;
 * 2. сводка закреплена и содержит актуальный список;
 * 3. ответ разбора читается без горизонтальной прокрутки на узком экране.
 *
 * **Почему именно они.** Всё остальное про темы уже проверено: создание
 * ветвей, обновление сводки редактированием, потеря ветки, плоский режим
 * — интеграционными тестами и сквозным. Здесь проверяется единственное,
 * чего не видно ни через API, ни через базу: как это выглядит человеку.
 *
 * **На что тест опирается.** На текст, который пишем мы (названия тем,
 * заголовок сводки из словаря), и на геометрию. Не на разметку Telegram:
 * их классы меняются с релизами, и тест, привязанный к ним, краснел бы
 * от чужих правок. Заголовок сводки берётся из словаря, а не повторяется
 * строкой: иначе правка формулировки ломала бы тест на ровном месте.
 *
 * **Что нужно до запуска** (подробно — в рантбуке):
 * - сохранённая сессия тестового аккаунта: вход требует кода из SMS,
 *   и автоматизировать его нельзя;
 * - у этого аккаунта пройден онбординг и разобрана хотя бы одна выгрузка
 *   — иначе ни ветвей, ни сводок, ни ответа на экране просто нет.
 */

const BOT = process.env['VISUAL_BOT'] ?? 'vydoh_dev_bot';
const SESSION = process.env['VISUAL_SESSION'] ?? '.data/visual/session.json';
const SHOTS = process.env['VISUAL_SHOTS'] ?? join('docs', 'visual');

/** Заголовок сводки темы: `<тема> — что здесь есть:`. */
const SUMMARY_MARK = defaultTexts.summary.header('').trim();

/** Строка списка в сводке и в выдаче — тире с пробелом. */
const BULLET = defaultTexts.summary.line('').trim();

test.beforeAll(() => {
  // Понятный отказ вместо непонятного: без сессии Playwright уронил бы
  // тест ошибкой про отсутствующий файл, и разбираться пришлось бы с ней,
  // а не с тем, что надо сделать.
  if (!existsSync(SESSION)) {
    throw new Error(
      `Нет сохранённой сессии Telegram: ${SESSION}\n` +
        'Сначала выполни вход один раз: npm run visual:login\n' +
        'Код из SMS вводит человек — автоматизировать это нельзя.',
    );
  }
});

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

/**
 * Открывает переписку с ботом.
 *
 * Адрес с решёткой и именем бота — обычный способ Telegram Web открыть
 * чат по имени; ссылка того же вида работает и у человека в браузере.
 */
async function openChat(page: Page): Promise<void> {
  await page.goto(`#@${BOT}`);
  await page.waitForLoadState('domcontentloaded');

  // Признак, что чат открылся: поле ввода сообщения на месте.
  const composer = page.locator('[contenteditable="true"]').first();
  await expect(composer, `не открылась переписка с @${BOT}`).toBeVisible({ timeout: 30_000 });
}

test.describe('темы в Telegram Web', () => {
  test('ветки видны и подписаны', async ({ page }) => {
    await openChat(page);

    // Ветка узнаётся по названию темы: их пишем мы, и в интерфейсе они
    // должны читаться как названия сфер жизни, а не как служебные строки.
    const names = (process.env['VISUAL_TOPICS'] ?? 'семья,здоровье,работа,покупки,личное')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');

    const found: string[] = [];
    for (const name of names) {
      if ((await page.getByText(name, { exact: false }).count()) > 0) found.push(name);
    }

    await shot(page, '01-vetki');

    // Двух достаточно: тест проверяет, что ветки видны и подписаны, а не
    // что заказчица выбрала на онбординге именно пять этих сфер.
    expect(
      found.length,
      `на экране не нашлось ни одной подписанной ветки из: ${names.join(', ')}. ` +
        'Проверь, что у аккаунта разобрана хотя бы одна выгрузка',
    ).toBeGreaterThanOrEqual(2);
  });

  test('сводка закреплена и содержит актуальный список', async ({ page }) => {
    await openChat(page);

    const summary = page.getByText(SUMMARY_MARK, { exact: false }).first();
    await expect(
      summary,
      `на экране нет заголовка сводки «${SUMMARY_MARK}» — сводка не закреплена или не создана`,
    ).toBeVisible();

    // Сводка без списка — это заголовок, а не сводка: §6.4 требует
    // актуального перечня дел темы, и пустой заголовок значил бы, что
    // обновление редактированием не доехало.
    const text = (await summary.locator('xpath=ancestor-or-self::*[3]').innerText()).trim();

    await shot(page, '02-svodka');

    expect(text, 'в сводке нет ни одной строки списка').toContain(BULLET);
  });

  test('ответ разбора читается без горизонтальной прокрутки на узком экране', async ({ page }) => {
    // Триста шестьдесят точек — узкий телефон, а не редкий случай:
    // выгрузку наговаривают на ходу, с телефона в руке.
    await page.setViewportSize({ width: 360, height: 740 });
    await openChat(page);

    const answer = page.getByText(defaultTexts.answer.actionsLead, { exact: false }).first();
    await expect(
      answer,
      `на экране нет ответа разбора («${defaultTexts.answer.actionsLead}»)`,
    ).toBeVisible();

    const bubble = answer.locator('xpath=ancestor-or-self::*[3]');

    const overflow = await bubble.evaluate((node: Element) => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }));

    const pageOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

    await shot(page, '03-uzkiy-ekran');

    // Единица допуска — округление точек браузером, а не наша вольность.
    expect(
      overflow.scrollWidth,
      `ответ шире своего места: ${String(overflow.scrollWidth)} против ${String(overflow.clientWidth)}`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);

    expect(
      pageOverflow.scrollWidth,
      'страница прокручивается по горизонтали — значит что-то из нашего ответа её растянуло',
    ).toBeLessThanOrEqual(pageOverflow.clientWidth + 1);
  });
});
