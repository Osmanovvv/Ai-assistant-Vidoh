import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { documents, documentVersions } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { documentOf, saveDocument, versionsOf } from './documents.service.js';
import { importDocuments } from './import.js';

beforeEach(async () => {
  await testDb().delete(documentVersions);
  await testDb().delete(documents);
});

async function folderWith(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vydoh-docs-'));
  for (const [name, html] of Object.entries(files)) {
    await writeFile(join(dir, `${name}.html`), html, 'utf8');
  }
  return dir;
}

describe('первое наполнение документов из файлов', () => {
  it('кладёт то, чего нет, называет, чего не хватило, и не трогает правленое', async () => {
    await saveDocument(testDb(), {
      slug: 'politika',
      html: '<p>правили в панели</p>',
      editionDate: null,
      by: 'оля',
    });
    const dir = await folderWith({
      oferta: '<h1>Оферта</h1><p>Текст.</p>',
      politika: '<p>из файла</p>',
      soglasie: '<p></p>',
    });

    const round = await importDocuments(testDb(), { dir, by: 'импорт' });

    expect(round).toEqual({
      imported: ['oferta'],
      skipped: ['politika'],
      missing: ['soglashenie'],
      refused: [{ slug: 'soglasie', why: expect.stringContaining('пуст') }],
    });
    expect((await documentOf(testDb(), 'politika'))?.html).toBe('<p>правили в панели</p>');
    expect((await documentOf(testDb(), 'oferta'))?.updatedBy).toBe('импорт');
    expect(await versionsOf(testDb(), 'oferta')).toHaveLength(1);
  });

  it('с force перетирает — новой версией, а не потерей старой', async () => {
    await saveDocument(testDb(), {
      slug: 'oferta',
      html: '<p>старая</p>',
      editionDate: null,
      by: 'о',
    });
    const dir = await folderWith({ oferta: '<p>из файла</p>' });

    const round = await importDocuments(testDb(), { dir, by: 'импорт', force: true });

    expect(round.imported).toEqual(['oferta']);
    expect((await documentOf(testDb(), 'oferta'))?.html).toBe('<p>из файла</p>');
    expect(await versionsOf(testDb(), 'oferta')).toHaveLength(2);
  });
});
