import { closeDb, getDb } from '../infra/db.js';
import { importDocuments } from '../modules/documents/import.js';

/**
 * Первое наполнение публичных документов из файлов (15.09.2026).
 *
 *   node apps/bot/dist/scripts/import-documents.js <папка> [--force]
 *
 * В папке — `oferta.html`, `politika.html`, `soglashenie.html`,
 * `soglasie.html` (собираются из docs/legal/*.md скриптом md2html).
 * Документ, который уже есть в базе, не трогается — его правили в
 * панели; `--force` перетирает новой версией, старая остаётся в истории.
 */
const [, , dir, flag] = process.argv;

if (dir === undefined || dir === '') {
  process.stderr.write('Использование: import-documents <папка> [--force]\n');
  process.exit(2);
}

const db = getDb();

try {
  const round = await importDocuments(db, {
    dir,
    by: 'импорт',
    force: flag === '--force',
  });

  process.stdout.write(
    [
      `Загружено: ${round.imported.join(', ') || '—'}`,
      `Пропущено (уже есть): ${round.skipped.join(', ') || '—'}`,
      `Файла нет: ${round.missing.join(', ') || '—'}`,
      ...round.refused.map((one) => `Отказ ${one.slug}: ${one.why}`),
      '',
    ].join('\n'),
  );

  if (round.refused.length > 0) process.exitCode = 1;
} finally {
  await closeDb();
}
