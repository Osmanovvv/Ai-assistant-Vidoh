import { modelEnvSchema } from '../config/env.js';
import { closeDb, getDb } from '../infra/db.js';
import { createLogger } from '../infra/logger.js';
import { withRetry } from '../infra/retry.js';
import { EXPECTED_MODEL_VERSIONS } from '../modules/ai/providers/versions.js';
import { YandexLlmProvider } from '../modules/ai/providers/yandex.js';
import { meterCall } from '../modules/metering/ai-calls.repo.js';
import { callCost, formatCost } from '../modules/metering/pricing.js';
import { createRunGuard } from '../modules/metering/run-guard.js';

/**
 * Проба сборки модели (22.09.2026, закрепление модели по имени).
 *
 * Yandex отвечает на каждый вызов датой сборки. Прежде чем переводить
 * бой с ветки `yandexgpt/latest` на явное имя `yandexgpt-5-pro`, надо
 * знать, что за явным именем стоит **та же** сборка, на которой мерился
 * порог, — иначе «закрепление» тихо сменило бы модель. Один крошечный
 * вызов на имя: вопрос на десяток токенов, ответ по схеме из одного слова.
 *
 * Учёт и потолок — как у всех живых скриптов (урок 05.09.2026): вызов
 * ложится в `ai_calls`, цена печатается по прайсу, потолок расхода
 * действует.
 *
 * Запуск (имена — необязательные; без них берутся модели из окружения):
 *   npx tsx src/scripts/check-model-version.ts yandexgpt-5-pro yandexgpt-5-lite
 *
 * Код выхода 1 — если хотя бы одна сборка не совпала с ожидаемой.
 */

const env = modelEnvSchema.parse(process.env);

if (env.YANDEX_API_KEY === undefined || env.YANDEX_FOLDER_ID === undefined) {
  process.stderr.write('Нужны YANDEX_API_KEY и YANDEX_FOLDER_ID\n');
  process.exit(2);
}

const names =
  process.argv.length > 2
    ? process.argv.slice(2)
    : [...new Set([env.YANDEX_LLM_MODEL, env.YANDEX_LLM_MODEL_LIGHT, env.YANDEX_LLM_MODEL_ROUTER])];

const logger = createLogger({ level: 'warn' });
const db = getDb();
const guard = createRunGuard({ db, env, logger, startedAt: new Date() });
const refusedByCeiling = await guard.checkBefore();

if (refusedByCeiling !== undefined) {
  process.stderr.write(`Проба не начата: ${refusedByCeiling}\n`);
  await closeDb();
  process.exit(3);
}

/** Схема из одного слова: ответ короткий, а не обрезанный по лимиту. */
const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

let mismatched = 0;

for (const name of names) {
  const provider = new YandexLlmProvider({
    apiKey: env.YANDEX_API_KEY,
    folderId: env.YANDEX_FOLDER_ID,
    model: name,
  });

  let completion;
  try {
    completion = await meterCall(
      db,
      { stage: 'router', model: provider.name, promptVersion: 'проба-сборки' },
      async () => {
        const result = await withRetry(
          () =>
            provider.complete({
              stage: 'router',
              prompt: 'Ответь по схеме одним словом.',
              input: 'Скажи «да».',
              jsonSchema: SCHEMA,
              maxTokens: 40,
            }),
          { attempts: 3 },
        );

        return {
          value: result,
          usage: { tokensIn: result.tokensIn, tokensOut: result.tokensOut },
          ...(result.modelVersion === undefined ? {} : { modelVersion: result.modelVersion }),
        };
      },
      { guard: guard.spendGuard },
    );
  } catch (error) {
    // Отказ — тоже ответ пробы: имени нет, ключ не тот, сеть. Печатается
    // словами провайдера, ключ в них уже замаскирован.
    const words = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${name} → отказ: ${words}\n`);
    mismatched += 1;
    continue;
  }

  const expected = EXPECTED_MODEL_VERSIONS[provider.name];
  const actual = completion.modelVersion ?? '(версии в ответе нет)';
  const verdict =
    expected === undefined
      ? 'ожидание не назначено'
      : actual === expected
        ? 'совпадает с ожидаемой'
        : `НЕ совпадает: ожидалась ${expected}`;
  if (expected !== undefined && actual !== expected) mismatched += 1;

  const cost = callCost(provider.name, {
    tokensIn: completion.tokensIn,
    tokensOut: completion.tokensOut,
  });

  process.stdout.write(
    `${name} → сборка ${actual} — ${verdict}; токены ${String(completion.tokensIn)}/` +
      `${String(completion.tokensOut)}, цена ${formatCost(cost)}\n`,
  );
}

process.stdout.write(`\n${await guard.costReport()}\n`);
await closeDb();
// Без process.exit: на Windows он обрывает закрытие пула базы и роняет
// процесс проверкой libuv уже после напечатанного итога.
process.exitCode = mismatched === 0 ? 0 : 1;
