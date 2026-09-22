import { closeDb, getDb } from '../infra/db.js';
import { loadActivePrompt, promptFailureAdvice } from '../modules/ai/prompts/registry.js';
import { OPTIONAL_STAGES, SCHEMA_BY_STAGE } from '../modules/ai/schemas/index.js';
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

/** Этап, промпт которого не поднялся: причина и что с ней делать. */
interface Broken {
  readonly stage: AiStage;
  readonly why: string;
  readonly advice: string;
}

const broken: Broken[] = [];
/** Необязательные этапы: без них бот отвечает словарём, а не падает. */
const missing: Broken[] = [];
const found: string[] = [];

for (const stage of stages) {
  try {
    const prompt = await loadActivePrompt(db, stage);
    found.push(`${stage}: ${prompt.version}`);
  } catch (error) {
    /**
     * Причина не теряется.
     *
     * «Заливки не было» — только одна из четырёх, и три остальные
     * заливкой не лечатся: схема в базе разошлась с кодом, схемы нет в
     * коде вовсе, база не ответила. Прежде все четыре сваливались в
     * `catch {}` и печатались одной строкой с одним советом — а бот к
     * этому моменту уже поднят и хоронит выгрузки.
     */
    const failure = {
      stage,
      why: error instanceof Error ? error.message : String(error),
      advice: promptFailureAdvice(error),
    };
    // Живой голос без промпта молчит, а не роняет разбор (22.09.2026).
    if (OPTIONAL_STAGES.has(stage)) missing.push(failure);
    else broken.push(failure);
  }
}

await closeDb();

for (const line of found) process.stdout.write(`  ${line}\n`);

if (missing.length > 0) {
  /**
   * Предупреждение, а не отказ: живой голос без промпта просто молчит,
   * и бот отвечает словарём, как до 22.09.2026. Печатать про него «бот
   * упадёт на первой выгрузке» — неправда, а неправду в выкладке
   * перестанут читать вместе с настоящими отказами.
   */
  process.stdout.write('\nБез промпта — отвечает словарём, это не отказ:\n');
  for (const item of missing) process.stdout.write(`  ${item.stage}: ${item.why}\n`);
  for (const advice of new Set(missing.map((item) => item.advice))) {
    process.stdout.write(`\n  ${advice}\n`);
  }
}

if (broken.length > 0) {
  process.stderr.write('\nРазбор работать не будет:\n');

  for (const item of broken) {
    process.stderr.write(`  ${item.stage}: ${item.why}\n`);
  }

  /**
   * Совет — по одному разу на причину, а не на этап: отказ базы валит
   * все шесть этапов разом, и шесть одинаковых рецептов подряд читать
   * перестанут вместе со всем остальным.
   */
  for (const advice of new Set(broken.map((item) => item.advice))) {
    process.stderr.write(`\n  ${advice}\n`);
  }

  process.stderr.write('\nБот при этом уже поднялся здоровым и упадёт на первой выгрузке.\n');
  process.exit(1);
}

process.stdout.write(
  `\nВсе ${String(stages.length - missing.length)} обязательных этапов разбора обеспечены промптами.\n`,
);
