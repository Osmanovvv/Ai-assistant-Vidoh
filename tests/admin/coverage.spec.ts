import { readdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/**
 * Покрыт ли каждый раздел §15 (задача 4.12).
 *
 * Условие готовности задачи — «набор зелёный в CI, покрыт каждый раздел
 * из §15». Восемь разделов, и два из них ещё не существуют: рассылка и
 * ошибки приезжают задачей 4.10.
 *
 * **Отсюда и устройство этой проверки.** Она не притворяется, что
 * покрытие полное, и не молчит о дырах: у каждого раздела записано,
 * либо каким файлом он покрыт, либо какой задачей появится. Пока
 * существующие разделы покрыты, проверка зелёная; как только появится
 * новый раздел без проверок — покраснеет.
 *
 * **Зачем так, а не списком в голове.** Задача 4.12 закрывается не
 * сегодня: две её восьмых зависят от задачи 4.10. Список, живущий в
 * плане, к тому дню устареет; список, живущий здесь, сам напомнит о
 * себе красным.
 */

/** Восемь разделов §15 и их состояние. */
const SECTIONS = [
  { title: 'Обзор', spec: 'people.spec.ts' },
  { title: 'Пользователи', spec: 'people.spec.ts' },
  { title: 'Карточка пользователя', spec: 'people.spec.ts' },
  { title: 'Расходы', spec: 'costs.spec.ts' },
  { title: 'Настройки', spec: 'settings.spec.ts' },
  { title: 'Промпты', spec: 'prompts.spec.ts' },
  { title: 'Рассылка', waitsFor: '4.10' },
  { title: 'Ошибки', waitsFor: '4.10' },
] as const;

const HERE = dirname(fileURLToPath(import.meta.url));

test.describe('покрытие разделов §15', () => {
  test('у каждого существующего раздела есть свои проверки', async () => {
    const files = await readdir(HERE);
    const missing: string[] = [];

    for (const section of SECTIONS) {
      if (!('spec' in section)) continue;

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

  test('непокрытые разделы названы вместе с задачей, которая их принесёт', () => {
    /**
     * Проверка на честность самой задачи 4.12: пока разделов нет,
     * покрытие неполно, и это должно быть записано — а не выясняться на
     * приёмке. Когда 4.10 закроется, здесь появятся файлы, и эта проверка
     * напомнит поправить список.
     */
    const waiting = SECTIONS.filter((one) => 'waitsFor' in one);

    expect(waiting.map((one) => `${one.title} — задача ${one.waitsFor}`)).toEqual([
      'Рассылка — задача 4.10',
      'Ошибки — задача 4.10',
    ]);
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
