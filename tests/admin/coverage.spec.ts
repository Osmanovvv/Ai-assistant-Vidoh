import { readdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

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

  test('непокрытых разделов не осталось', () => {
    /**
     * Проверка на честность самой задачи 4.12. Полтора месяца она
     * говорила «трёх разделов ещё нет, вот какими задачами придут», и это
     * было правдой; с задачей 4.10 пришли последние два.
     *
     * Строка остаётся не для порядка: она краснеет, если раздел
     * когда-нибудь снова окажется «в работе». Тогда его надо будет либо
     * покрыть, либо назвать вслух — как называли эти.
     */
    // Через hasOwn, а не «in»: «in» сужает тип до пустого — все восемь
    // разделов покрыты, — и проверка стала бы непроверяемой.
    const waiting = SECTIONS.filter((one) => !Object.hasOwn(one, 'spec'));

    expect(waiting.map((one) => one.title)).toEqual([]);
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
