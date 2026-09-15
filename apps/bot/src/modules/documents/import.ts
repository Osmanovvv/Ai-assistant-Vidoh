import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Executor } from '../../infra/db.js';
import { DOCUMENTS, documentOf, saveDocument } from './documents.service.js';

/**
 * Первое наполнение документов из файлов `<папка>/<slug>.html` — по
 * одному на документ. Кладётся только то, чего в базе ещё нет: документ,
 * который уже правили в панели, файлом не перетирается — иначе импорт,
 * запущенный второй раз, стёр бы чужую работу. Перетереть нарочно можно
 * флагом `force`.
 */
export interface ImportRound {
  readonly imported: readonly string[];
  readonly skipped: readonly string[];
  readonly missing: readonly string[];
  readonly refused: readonly { readonly slug: string; readonly why: string }[];
}

export async function importDocuments(
  db: Executor,
  params: { readonly dir: string; readonly by: string; readonly force?: boolean | undefined },
): Promise<ImportRound> {
  const imported: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];
  const refused: { slug: string; why: string }[] = [];

  for (const { slug } of DOCUMENTS) {
    let html: string;
    try {
      html = await readFile(join(params.dir, `${slug}.html`), 'utf8');
    } catch {
      missing.push(slug);
      continue;
    }

    if (params.force !== true && (await documentOf(db, slug)) !== undefined) {
      skipped.push(slug);
      continue;
    }

    const outcome = await saveDocument(db, { slug, html, editionDate: null, by: params.by });
    if (outcome.ok) imported.push(slug);
    else refused.push({ slug, why: outcome.why });
  }

  return { imported, skipped, missing, refused };
}
