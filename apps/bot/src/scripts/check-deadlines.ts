import { readFile } from 'node:fs/promises';

import { modelEnvSchema } from '../config/env.js';
import { closeDb, getDb } from '../infra/db.js';
import { createLogger } from '../infra/logger.js';
import { requestStructured } from '../modules/ai/client.js';
import { PromptRegistry } from '../modules/ai/prompts/registry.js';
import { createLlmProvider } from '../modules/ai/providers/factory.js';
import type { ClassifiedItems } from '../modules/ai/schemas/index.js';
import { correctItems } from '../modules/classifier/classifier.service.js';
import { describeToday } from '../modules/classifier/dates.js';
import { extractUnits } from '../modules/extractor/extractor.service.js';

/**
 * Что стало со сроками на одной выгрузке (задача 3.37).
 *
 * **Зачем, если есть контрольный набор.** Набор говорит «точность срока
 * 96,4%» и не говорит, где именно потеря: модель не назвала день, назвала
 * не тот или назвала верно, а проверка §2.7 его отбросила. Три разные
 * неполадки с тремя разными починками, и в отчёте они выглядят одинаково.
 *
 * Здесь видно построчно: что вернула модель, какую цитату привела и что
 * решил код. Именно этим 02.09.2026 нашлась причина потерянных дней —
 * шесть верных дат за сутки отброшены как выдуманные.
 *
 * Идёт тем же путём, что бой: настоящее извлечение, потом классификация.
 * Иначе мерили бы не то, что работает (см. 3.23 и 3.35).
 *
 * Запуск:
 *   DATABASE_URL=… AI_PROVIDER=yandex YANDEX_API_KEY=… YANDEX_FOLDER_ID=… \
 *     npx tsx src/scripts/check-deadlines.ts ../../docs/eval/dump-3.json
 */

const [, , file] = process.argv;

if (file === undefined) {
  process.stderr.write('Использование: check-deadlines <случай-из-набора.json>\n');
  process.exit(2);
}

interface Case {
  readonly text: string;
  readonly now: string;
  readonly timeZone: string;
  readonly topics: readonly string[];
  readonly defaultTopic: string;
}

const item = JSON.parse(await readFile(file, 'utf8')) as Case;
const now = new Date(item.now);

const env = modelEnvSchema.parse(process.env);
const db = getDb();

/** Предупреждения проверки собираем сами: они и есть ответ на вопрос. */
const rejected: string[] = [];
const logger = createLogger({ level: 'silent', pretty: false });
const collecting = {
  ...logger,
  warn: (payload: unknown) => {
    const reason = (payload as { reason?: unknown }).reason;
    if (typeof reason === 'string') rejected.push(reason);
  },
} as unknown as typeof logger;

try {
  const deps = { db, provider: createLlmProvider(env), prompts: new PromptRegistry(db), logger };

  const extracted = await extractUnits(deps, { input: item.text });
  if (!extracted.ok) throw new Error(`извлечение не удалось: ${extracted.problem}`);

  const units = extracted.units.map((unit, index) => `${String(index + 1)}. ${unit.text}`);
  const answer = await requestStructured<ClassifiedItems>(deps, {
    stage: 'classifier',
    input: [
      describeToday(now, item.timeZone),
      '',
      `Доступные темы: ${item.topics.join(', ')}.`,
      '',
      'Человек сказал так:',
      item.text,
      '',
      'Мысли:',
      ...units,
    ].join('\n'),
  });

  if (!answer.ok) throw new Error(`классификация не удалась: ${answer.problem}`);

  const { items } = correctItems(answer.value, {
    spoken: item.text,
    topics: item.topics,
    defaultTopic: item.defaultTopic,
    timeZone: item.timeZone,
    now,
    said: extracted.units.map((unit) => unit.text),
    promptVersion: answer.promptVersion,
    logger: collecting,
  });

  process.stdout.write(
    `\nПромпты: извлечение ${extracted.promptVersion}, классификация ${answer.promptVersion}\n` +
      `Единиц: ${String(extracted.units.length)}\n\n`,
  );

  answer.value.items.forEach((raw, index) => {
    const decided = items[index];
    const model = raw.deadline === '' ? '—' : `${raw.deadline} ${raw.deadlineAccuracy}`;
    /**
     * Дата — в поясе человека, а не в UTC.
     *
     * Первый же прогон напугал зря: «модель 2026-09-05, код 2026-09-04».
     * Никакого сдвига не было — `at` это начало дня по Москве, то есть
     * 21:00 UTC предыдущих суток, а печаталось оно через `toISOString`.
     */
    const code =
      decided?.deadline === undefined
        ? '—'
        : new Intl.DateTimeFormat('sv-SE', { timeZone: item.timeZone }).format(decided.deadline.at);
    const verdict = model !== '—' && code === '—' ? ' ОТБРОШЕН' : '';

    process.stdout.write(
      `${String(index + 1).padStart(3)}. ${raw.text}\n` +
        `     модель: ${model.padEnd(16)} цитата: «${raw.deadlineText}»\n` +
        `     код:    ${code}${verdict}\n`,
    );
  });

  process.stdout.write(`\nОтброшено сроков: ${String(rejected.length)}\n`);
  for (const reason of rejected) process.stdout.write(`  — ${reason}\n`);
} finally {
  await closeDb();
}
