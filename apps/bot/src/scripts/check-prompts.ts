import { closeDb, getDb } from '../infra/db.js';
import { loadActivePrompt } from '../modules/ai/prompts/registry.js';
import { SCHEMA_BY_STAGE } from '../modules/ai/schemas/index.js';
import type { AiStage } from '../db/schema.js';

/**
 * Сторож активных промптов (открытый хвост 16).
 *
 * **Этот сторож существует из-за случившегося.** При выкладке этапа 2 бот
 * поднялся здоровым и упал на первой же выгрузке: активной версии промпта
 * в базе не было. Тексты промптов лежат вне репозитория и в архив выкладки
 * не попадают, поэтому заливка — отдельный шаг, о котором легко забыть.
 * Проверка готовности его не ловит: без обращения к модели бот вполне
 * здоров.
 *
 * Список этапов берётся из кода, а не переписывается сюда руками. Иначе
 * седьмой этап, добавленный завтра, молча выпадет из проверки — ровно так
 * же, как выпадал сам шаг заливки.
 *
 * Запуск (в контейнере, после выкладки):
 *   node apps/bot/dist/scripts/check-prompts.js
 */

const db = getDb();
const stages = Object.keys(SCHEMA_BY_STAGE) as AiStage[];

const missing: string[] = [];
const found: string[] = [];

for (const stage of stages) {
  try {
    const prompt = await loadActivePrompt(db, stage);
    found.push(`${stage}: ${prompt.version}`);
  } catch {
    missing.push(stage);
  }
}

await closeDb();

for (const line of found) process.stdout.write(`  ${line}\n`);

if (missing.length > 0) {
  process.stderr.write(
    `\nНет активного промпта: ${missing.join(', ')}.\n` +
      'Бот поднимется здоровым и упадёт на первой выгрузке.\n' +
      'Залить: ./ops/seed-prompts.sh --activate\n',
  );
  process.exit(1);
}

process.stdout.write(`\nВсе ${String(stages.length)} этапов разбора обеспечены промптами.\n`);
