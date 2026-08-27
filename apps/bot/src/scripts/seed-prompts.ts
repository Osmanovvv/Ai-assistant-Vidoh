import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { AiStage } from '../db/schema.js';
import { closeDb, getDb } from '../infra/db.js';
import { createLogger } from '../infra/logger.js';
import { SCHEMA_BY_STAGE } from '../modules/ai/schemas/index.js';
import { activatePrompt, seedPrompt } from '../modules/ai/prompts/seed.js';

/**
 * Заливка промптов из файлов в базу (задача 2.1).
 *
 * Тексты промптов лежат вне репозитория — он публичный, а промпты и есть
 * основное ноу-хау продукта. Этот скрипт переносит их в `prompt_versions`,
 * откуда их берёт конвейер.
 *
 * Имя файла задаёт этап и версию: `router@1.md` — этап `router`, версия
 * `router@1`. Схема ответа берётся по этапу из каталога схем в коде.
 *
 * Запуск:
 *   DATABASE_URL=… npx tsx src/scripts/seed-prompts.ts ../../docs/prompts
 *   DATABASE_URL=… npx tsx src/scripts/seed-prompts.ts ../../docs/prompts --activate
 */

const [, , directory, ...flags] = process.argv;

if (directory === undefined) {
  process.stderr.write(
    'Использование: seed-prompts <папка-с-промптами> [--activate]\n' +
      '  --activate — сделать залитые версии активными\n',
  );
  process.exit(2);
}

const activate = flags.includes('--activate');
// Читаемый вывод — только в терминале человека: в контейнере
// без `pino-pretty` он не нужен и раньше ронял скрипт.
const logger = createLogger({ level: 'info', pretty: process.stdout.isTTY });

/** `router@1.md` → этап `router`, версия `router@1`. */
function parseName(fileName: string): { stage: AiStage; version: string } | undefined {
  const version = basename(fileName, '.md');
  const [stage] = version.split('@');

  if (stage === undefined || !(stage in SCHEMA_BY_STAGE)) return undefined;

  return { stage: stage as AiStage, version };
}

const db = getDb();

try {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.md')).sort();

  if (files.length === 0) {
    logger.warn({ directory }, 'В папке нет файлов промптов');
  }

  for (const file of files) {
    const parsed = parseName(file);

    if (!parsed) {
      // Файл, не похожий на промпт, — не повод падать: рядом могут лежать
      // заметки. Но и молча пропускать нельзя.
      logger.warn({ file }, 'Пропускаю: имя не соответствует виду этап@версия');
      continue;
    }

    const { stage, version } = parsed;
    const prompt = (await readFile(join(directory, file), 'utf8')).trim();
    const schemaName = SCHEMA_BY_STAGE[stage];

    if (schemaName === undefined) {
      logger.warn({ stage }, 'Для этапа нет схемы в каталоге, пропускаю');
      continue;
    }

    const { created } = await seedPrompt(db, { stage, version, prompt, schemaName });
    logger.info(
      { stage, version, schemaName, знаков: prompt.length },
      created ? 'Версия залита' : 'Версия уже была, совпадает',
    );

    if (activate) {
      await activatePrompt(db, stage, version);
      logger.info({ stage, version }, 'Версия сделана активной');
    }
  }
} finally {
  await closeDb();
}
