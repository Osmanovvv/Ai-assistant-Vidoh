import { readdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { signIn } from './panel.js';

/**
 * Покрыт ли каждый раздел §15 (задача 4.12).
 *
 * Условие готовности задачи — «набор зелёный в CI, покрыт каждый раздел
 * из §15». Восемь разделов, и с задачей 4.10 покрыты все восемь.
 *
 * **Проверка остаётся, хотя дыр больше нет.** У каждого раздела записано,
 * каким файлом он покрыт; новый раздел без проверок покраснеет здесь
 * сразу, а не выяснится на приёмке. И обратное тоже: раздел, чей файл
 * проверок однажды опустеет, покраснеет — файл без единого вызова test
 * считается непокрытым.
 *
 * **Зачем так, а не списком в голове.** Список, живущий в плане, к
 * следующему разделу устареет; список, живущий здесь, сам напомнит о себе
 * красным.
 */

/** Восемь разделов §15 и их состояние. */
const SECTIONS = [
  { title: 'Обзор', spec: 'people.spec.ts' },
  { title: 'Пользователи', spec: 'people.spec.ts' },
  { title: 'Карточка пользователя', spec: 'people.spec.ts' },
  { title: 'Расходы', spec: 'costs.spec.ts' },
  { title: 'Реплики', spec: 'texts.spec.ts' },
  { title: 'Настройки', spec: 'settings.spec.ts' },
  { title: 'Промпты', spec: 'prompts.spec.ts' },
  { title: 'Рассылка', spec: 'broadcast.spec.ts' },
  { title: 'Ошибки', spec: 'errors.spec.ts' },
] as const;

const HERE = dirname(fileURLToPath(import.meta.url));

test.describe('покрытие разделов §15', () => {
  test('у каждого существующего раздела есть свои проверки', async () => {
    const files = await readdir(HERE);
    const missing: string[] = [];

    for (const section of SECTIONS) {
      if (!files.includes(section.spec)) {
        missing.push(`${section.title}: обещан файл ${section.spec}, а его нет`);
        continue;
      }

      const source = await readFile(`${HERE}/${section.spec}`, 'utf8');

      // Файл есть — но в нём должны быть проверки, а не пустая оболочка.
      if (!source.includes('test(')) {
        missing.push(`${section.title}: файл ${section.spec} без единой проверки`);
      }
    }

    expect(missing, ['Раздел §15 остался без проверок.', '', ...missing].join('\n')).toEqual([]);
  });

  test('у каждой вкладки панели есть свои проверки', async ({ page }) => {
    /**
     * **Переписано ревизией четвёртого этапа: прежняя проверка не могла
     * покраснеть ни от какой правки продукта.** Она утверждала свойство
     * литерала в этом же файле — «у каждой записи `SECTIONS` есть поле
     * `spec`», — то есть проверяла саму себя. Появись в панели девятая
     * вкладка без проверок, она осталась бы зелёной.
     *
     * Теперь список берётся **из панели**: читаются отрисованные вкладки
     * (`nav.вкладки`), и у каждой обязан быть раздел в `SECTIONS` с
     * непустым файлом проверок. Список в коде проверки больше не
     * источник правды — он ответчик перед панелью.
     */
    await signIn(page);

    const tabs = (await page.locator('nav.вкладки .вкладка').allInnerTexts()).map((one) =>
      one.trim(),
    );

    // Страж стража: вкладок должно быть найдено хоть сколько-то, иначе
    // сломанный поиск сделал бы проверку вечно зелёной.
    expect(tabs.length).toBeGreaterThan(5);

    const files = await readdir(HERE);
    const naked: string[] = [];

    for (const title of new Set(tabs)) {
      const section = SECTIONS.find((one) => one.title === title);

      if (section === undefined) {
        naked.push(`${title}: вкладка есть в панели, а раздела в списке проверок нет`);
        continue;
      }

      if (!files.includes(section.spec)) {
        naked.push(`${title}: обещан файл ${section.spec}, а его нет`);
        continue;
      }

      const source = await readFile(`${HERE}/${section.spec}`, 'utf8');

      if (!source.includes('test(')) naked.push(`${title}: файл ${section.spec} без проверок`);
    }

    expect(naked, ['Вкладка панели без проверок.', '', ...naked].join('\n')).toEqual([]);

    /**
     * И обратное: раздел из списка, которому не соответствует ни одна
     * вкладка, обязан быть назван — иначе список тихо разойдётся с
     * панелью в другую сторону.
     *
     * «Карточка пользователя» — единственный такой: §15 просит её
     * отдельным разделом, а живёт она внутри «Пользователей», куда её и
     * открывают.
     */
    const WITHOUT_TAB = new Set(['Карточка пользователя']);
    const orphans = SECTIONS.filter(
      (one) => !tabs.includes(one.title) && !WITHOUT_TAB.has(one.title),
    );

    expect(
      orphans.map((one) => one.title),
      'Раздел из списка проверок не соответствует ни одной вкладке панели.',
    ).toEqual([]);
  });

  test('вход и внешний вид проверены отдельно от разделов', async () => {
    // Они не разделы §15, но без них панель не открыть и не показать:
    // §15 требует вход в два шага, §12.4 — палитру, план 4.12 — снимки
    // и телефон.
    const files = await readdir(HERE);

    expect(files).toContain('signin.spec.ts');
    expect(files).toContain('looks.spec.ts');
  });
});
