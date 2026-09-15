import { beforeEach, describe, expect, it } from 'vitest';

import { documents, documentVersions } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import {
  DOCUMENTS,
  documentOf,
  listDocuments,
  MAX_DOCUMENT_BYTES,
  saveDocument,
  sanitizeDocument,
  versionHtml,
  versionsOf,
} from './documents.service.js';

/**
 * Публичные документы продукта — правятся в панели, отдаются ботом.
 * Здесь — хранение и отсев разметки; страница и панель — своими
 * проверками.
 */
beforeEach(async () => {
  await testDb().delete(documentVersions);
  await testDb().delete(documents);
});

describe('список документов закрыт кодом', () => {
  it('четыре публичных документа, у каждого адрес и название', () => {
    expect(DOCUMENTS.map((one) => one.slug)).toEqual([
      'oferta',
      'politika',
      'soglashenie',
      'soglasie',
    ]);
    for (const one of DOCUMENTS) expect(one.title.length).toBeGreaterThan(5);
  });

  it('пока ничего не сохранено — список полный, но пустой: панель показывает, что править', async () => {
    const list = await listDocuments(testDb());

    expect(list.map((one) => one.slug)).toEqual(DOCUMENTS.map((one) => one.slug));
    expect(list.every((one) => one.updatedAt === null)).toBe(true);
    expect(await documentOf(testDb(), 'oferta')).toBeUndefined();
  });

  it('чужой адрес не сохраняется', async () => {
    const outcome = await saveDocument(testDb(), {
      slug: 'chto-ugodno',
      html: '<p>текст</p>',
      editionDate: null,
      by: 'nikita',
    });

    expect(outcome).toEqual({ ok: false, why: expect.stringContaining('нет такого документа') });
  });
});

describe('сохранение', () => {
  it('первое сохранение заводит документ и первую версию', async () => {
    const outcome = await saveDocument(testDb(), {
      slug: 'oferta',
      html: '<h1>Оферта</h1><p>Текст.</p>',
      editionDate: '2026-10-01',
      by: 'nikita',
    });

    expect(outcome).toEqual({ ok: true });

    const saved = await documentOf(testDb(), 'oferta');
    expect(saved?.title).toBe('Публичная оферта');
    expect(saved?.html).toBe('<h1>Оферта</h1><p>Текст.</p>');
    expect(saved?.editionDate).toBe('2026-10-01');
    expect(saved?.updatedBy).toBe('nikita');

    const versions = await versionsOf(testDb(), 'oferta');
    expect(versions).toHaveLength(1);
    expect(versions[0]?.savedBy).toBe('nikita');
  });

  it('каждое сохранение — новая версия, старую можно прочесть и вернуть', async () => {
    await saveDocument(testDb(), {
      slug: 'politika',
      html: '<p>первая</p>',
      editionDate: null,
      by: 'a',
    });
    await saveDocument(testDb(), {
      slug: 'politika',
      html: '<p>вторая</p>',
      editionDate: null,
      by: 'b',
    });

    const versions = await versionsOf(testDb(), 'politika');
    // Свежая — первой: панель показывает историю сверху вниз.
    expect(versions.map((one) => one.savedBy)).toEqual(['b', 'a']);
    expect(await versionHtml(testDb(), 'politika', versions[1]!.id)).toBe('<p>первая</p>');
    // Чужой документ по этому же номеру версии не отдаётся.
    expect(await versionHtml(testDb(), 'oferta', versions[1]!.id)).toBeUndefined();

    expect((await documentOf(testDb(), 'politika'))?.html).toBe('<p>вторая</p>');
  });

  it('пустой документ не сохраняется: одна разметка без слов — тоже пусто', async () => {
    for (const html of ['', '   ', '<p></p>', '<p><br></p><h2></h2>']) {
      const outcome = await saveDocument(testDb(), {
        slug: 'oferta',
        html,
        editionDate: null,
        by: 'nikita',
      });
      expect(outcome.ok, html).toBe(false);
    }
    expect(await versionsOf(testDb(), 'oferta')).toEqual([]);
  });

  it('слишком большой документ не сохраняется, и предел назван', async () => {
    const outcome = await saveDocument(testDb(), {
      slug: 'oferta',
      html: `<p>${'ы'.repeat(MAX_DOCUMENT_BYTES)}</p>`,
      editionDate: null,
      by: 'nikita',
    });

    expect(outcome).toEqual({ ok: false, why: expect.stringContaining('больше') });
  });

  it('дата редакции — только датой', async () => {
    const outcome = await saveDocument(testDb(), {
      slug: 'oferta',
      html: '<p>текст</p>',
      editionDate: 'завтра',
      by: 'nikita',
    });

    expect(outcome).toEqual({ ok: false, why: expect.stringContaining('дата') });
  });
});

describe('отсев разметки — на записи, показ доверяет базе', () => {
  it('оставляет то, что нужно документу: заголовки, абзацы, списки, ссылки, таблицы, выравнивание', () => {
    const html =
      '<h2 style="text-align: center">Раздел</h2>' +
      '<p>Абзац с <strong>жирным</strong>, <em>курсивом</em>, <u>подчёркнутым</u> и ' +
      '<a href="https://vydoh-app.ru/docs/politika">ссылкой</a>.</p>' +
      '<ul><li>пункт</li></ul><ol><li>шаг</li></ol>' +
      '<table><tbody><tr><th colspan="2">Шапка</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>' +
      '<blockquote><p>цитата</p></blockquote><hr>';

    expect(sanitizeDocument(html)).toBe(
      '<h2 style="text-align:center">Раздел</h2>' +
        '<p>Абзац с <strong>жирным</strong>, <em>курсивом</em>, <u>подчёркнутым</u> и ' +
        '<a href="https://vydoh-app.ru/docs/politika" rel="noopener">ссылкой</a>.</p>' +
        '<ul><li>пункт</li></ul><ol><li>шаг</li></ol>' +
        '<table><tbody><tr><th colspan="2">Шапка</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>' +
        '<blockquote><p>цитата</p></blockquote><hr />',
    );
  });

  it('выкидывает скрипты, обработчики, стили и опасные ссылки', () => {
    const html =
      '<p onclick="x()">текст<script>alert(1)</script></p>' +
      '<style>p{display:none}</style>' +
      '<p style="display:none;color:red;text-align:right">скрыто</p>' +
      '<a href="javascript:alert(1)">клик</a>' +
      '<iframe src="https://evil"></iframe><img src="x" onerror="x()">';

    const clean = sanitizeDocument(html);

    expect(clean).not.toMatch(/script|onclick|onerror|iframe|img|display|javascript/u);
    // Разрешённое выравнивание пережило, запрещённые свойства — нет.
    expect(clean).toContain('<p style="text-align:right">скрыто</p>');
    // Ссылка без адреса — текст остался, идти некуда.
    expect(clean).toContain('<a rel="noopener">клик</a>');
  });

  it('вставка из Word: мусорные теги уходят, текст и структура остаются', () => {
    const word =
      '<p class="MsoNormal" style="margin-bottom:0cm;line-height:normal"><span style="font-family:Calibri">Пункт 1.</span></p>' +
      '<o:p></o:p><font face="Arial">шрифт</font>';

    expect(sanitizeDocument(word)).toBe('<p>Пункт 1.</p>шрифт');
  });
});
