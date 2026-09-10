import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { escapeMarkdown } from './markdown.js';

/**
 * Имя из Telegram не рвёт первый экран (ревизия этапов 1–2).
 *
 * Молчаливый отказ, и самый ранний из возможных: первый экран §13.1 уходит
 * с разметкой — она нужна ровно для ссылки на политику, — и подставлял имя
 * из Telegram как есть. Имя человек задаёт себе сам, и `Ann_a`, `*K*`,
 * `[Ю` в нём не редкость.
 *
 * Telegram отвечал «can't parse entities», отправка падала, а повтор
 * доставки глушился дедупликацией апдейтов: первый экран терялся
 * **навсегда**, а не «до повтора». Человек на самое первое `/start`
 * получал ноль байт. Мониторинг молчал — один человек с неудобным именем
 * даёт долю ошибок много ниже порога тревоги.
 */

describe('экранирование имени', () => {
  it('прячет все четыре знака разметки', () => {
    expect(escapeMarkdown('Ann_a *K* [Ю `код`')).toBe('Ann\\_a \\*K\\* \\[Ю \\`код\\`');
  });

  it('обычное имя не трогает', () => {
    // Слеши в имени, которому они не нужны, человек прочтёт как поломку.
    expect(escapeMarkdown('Аня')).toBe('Аня');
  });

  it('после экранирования знаков разметки не остаётся', () => {
    /**
     * Проверка по существу, а не по образцу: любой знак разметки в
     * выходе обязан стоять после слеша. Так страж переживёт правку
     * набора знаков и покраснеет на настоящем промахе.
     */
    const escaped = escapeMarkdown('_*[`_*[`');

    for (let i = 0; i < escaped.length; i++) {
      if (!'_*[`'.includes(escaped[i] ?? '')) continue;
      expect(escaped[i - 1], `знак ${escaped[i] ?? ''} не экранирован`).toBe('\\');
    }
  });
});

describe('связка: имя на пути с разметкой экранировано', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, 'handlers/start.ts'), 'utf8');

  it('в вопрос первого экрана имя уходит экранированным', () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '');

    expect(code, 'имя снова уходит в разметку как есть').toContain(
      'name: escapeMarkdown(state.name)',
    );
  });

  it('разметка на этом экране и правда включена — иначе стеречь нечего', () => {
    // Пропади `parse_mode`, и экранирование стало бы обрядом: пусть тогда
    // краснеет эта проверка, а не человек через полгода.
    expect(source).toContain("parse_mode: 'Markdown'");
  });
});
