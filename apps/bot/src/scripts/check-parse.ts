import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { modelEnvSchema } from '../config/env.js';
import { withRetry } from '../infra/retry.js';
import { callCost, formatCost } from '../modules/metering/pricing.js';
import { createLlmProvider } from '../modules/ai/providers/factory.js';
import {
  CLASSIFIER_SCHEMA_NAME,
  EXTRACTOR_SCHEMA_NAME,
  ROUTER_SCHEMA_NAME,
  classifierSchema,
  extractorSchema,
  routerSchema,
  toJsonSchema,
} from '../modules/ai/schemas/index.js';
import { describeNow } from '../modules/classifier/dates.js';

/**
 * Проверка разбора на живой модели (задачи 2.3, 2.4, 2.5).
 *
 * Нужна затем же, зачем нужны сами задачи: провайдер, работающий на
 * тестах с подменённым fetch, ещё не значит работающий провайдер. И тем
 * же скриптом дальше подбираем промпты на контрольном наборе — иначе
 * качество разбора придётся оценивать на глаз.
 *
 * Этап определяется по имени файла промпта, как и при заливке:
 * `router@1.md` — маршрутизатор, `extractor@1.md` — извлечение.
 *
 * Промпт читается из файла, а не берётся из кода: тексты промптов лежат
 * в `docs/`, вне публичного репозитория.
 *
 * База данных здесь не нужна: регистр версий и учёт расхода покрыты
 * интеграционными тестами, а живьём надо проверить именно модель.
 *
 * Запуск:
 *   AI_PROVIDER=yandex YANDEX_API_KEY=… YANDEX_FOLDER_ID=… \
 *     npx tsx src/scripts/check-parse.ts промпт.md выгрузка.txt
 */

const [, , promptPath, inputPath] = process.argv;

if (promptPath === undefined || inputPath === undefined) {
  process.stderr.write('Использование: check-parse <файл-промпта> <файл-с-текстом-выгрузки>\n');
  process.exit(2);
}

/** Что мы проверяем и чем: этап, схема, модель. */
const STAGES = {
  router: {
    schema: routerSchema,
    schemaName: ROUTER_SCHEMA_NAME,
    // Маршрутизатор работает на лёгкой модели (§7.1, задача 2.4).
    light: true,
  },
  extractor: {
    schema: extractorSchema,
    schemaName: EXTRACTOR_SCHEMA_NAME,
    light: false,
  },
  classifier: {
    schema: classifierSchema,
    schemaName: CLASSIFIER_SCHEMA_NAME,
    light: false,
  },
} as const;

/** Базовый набор тем по §6.4 ТЗ. Годится для проверки промпта. */
const TOPICS = ['семья', 'здоровье', 'работа', 'покупки', 'личное'];

const stageName = basename(promptPath, '.md').split('@')[0] ?? '';

if (!(stageName in STAGES)) {
  process.stderr.write(
    `Неизвестный этап «${stageName}». Имя файла должно быть вида этап@версия.md, ` +
      `где этап — один из: ${Object.keys(STAGES).join(', ')}\n`,
  );
  process.exit(2);
}

const stage = STAGES[stageName as keyof typeof STAGES];

const env = modelEnvSchema.parse(process.env);
const provider = createLlmProvider(env, { light: stage.light });

const prompt = (await readFile(promptPath, 'utf8')).trim();
const rawInput = (await readFile(inputPath, 'utf8')).trim();

/**
 * Классификации нужен тот же контекст, что даёт ей сервис: сегодняшняя
 * дата с днём недели и список тем. Иначе проверяли бы не тот промпт,
 * который работает в бою.
 */
const input =
  stageName === 'classifier'
    ? [
        describeNow(new Date(), 'Europe/Moscow'),
        '',
        `Доступные темы: ${TOPICS.join(', ')}.`,
        '',
        'Мысли:',
        rawInput
          .split(/\r?\n/u)
          .map((line, index) => `${String(index + 1)}. ${line.trim()}`)
          .join('\n'),
      ].join('\n')
    : rawInput;

process.stdout.write(
  `Этап: ${stageName} (схема ${stage.schemaName})\n` +
    `Провайдер: ${provider.name}\n` +
    `Промпт: ${basename(promptPath)} (${String(prompt.length)} знаков)\n` +
    `Выгрузка: ${basename(inputPath)} (${String(input.length)} знаков)\n\n`,
);

const startedAt = Date.now();

// Через повтор, а не напрямую: сеть до Яндекса с машины разработчика
// периодически отваливается по таймауту соединения, и разовый обрыв не
// должен выглядеть как отказ модели.
const completion = await withRetry(
  (attempt) => {
    if (attempt > 1) process.stdout.write(`  (попытка ${String(attempt)})\n`);
    return provider.complete({
      prompt,
      input,
      jsonSchema: toJsonSchema(stage.schema),
    });
  },
  { attempts: 3 },
);

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

let payload: unknown;
try {
  payload = JSON.parse(completion.text);
} catch {
  process.stdout.write(`Ответ не разбирается как JSON за ${elapsed} с:\n`);
  process.stdout.write(`${completion.text.slice(0, 1500)}\n`);
  process.exit(1);
}

const parsed = stage.schema.safeParse(payload);

if (!parsed.success) {
  process.stdout.write(`Ответ не прошёл проверку схемы за ${elapsed} с:\n`);
  process.stdout.write(`${completion.text.slice(0, 1500)}\n\n`);
  for (const issue of parsed.error.issues.slice(0, 5)) {
    process.stdout.write(`  ${issue.path.join('.')}: ${issue.message}\n`);
  }
  process.exit(1);
}

if (stageName === 'router') {
  const { segments } = parsed.data as { segments: { intent: string; text: string }[] };
  process.stdout.write(`Сегментов: ${String(segments.length)}\n\n`);

  for (const [index, segment] of segments.entries()) {
    process.stdout.write(
      `${String(index + 1).padStart(2)}. [${segment.intent.padEnd(9)}] ${segment.text}\n`,
    );
  }
} else if (stageName === 'classifier') {
  const { items } = parsed.data as {
    items: {
      text: string;
      type: string;
      priority: string;
      topic: string;
      isProject: boolean;
      deadline: string;
      deadlineAccuracy: string;
    }[];
  };
  process.stdout.write(`Записей: ${String(items.length)}\n\n`);

  for (const [index, item] of items.entries()) {
    const deadline = item.deadline === '' ? '' : `  → ${item.deadline} (${item.deadlineAccuracy})`;
    const project = item.isProject ? ' [проект]' : '';

    process.stdout.write(
      `${String(index + 1).padStart(2)}. [${item.type.padEnd(7)}] [${item.priority.padEnd(5)}] ` +
        `[${item.topic.padEnd(9)}] ${item.text}${project}${deadline}\n`,
    );
  }
} else {
  const { units } = parsed.data as {
    units: { text: string; isProject: boolean; isEmotion: boolean }[];
  };
  process.stdout.write(`Единиц извлечено: ${String(units.length)}\n\n`);

  for (const [index, unit] of units.entries()) {
    const marks = [unit.isProject ? 'проект' : '', unit.isEmotion ? 'эмоция' : '']
      .filter((mark) => mark !== '')
      .join(', ');

    process.stdout.write(
      `${String(index + 1).padStart(2)}. ${unit.text}${marks === '' ? '' : `  [${marks}]`}\n`,
    );
  }
}

const cost = callCost(provider.name, {
  tokensIn: completion.tokensIn,
  tokensOut: completion.tokensOut,
});

process.stdout.write(
  `\n${'─'.repeat(60)}\n` +
    `Время: ${elapsed} с. Токены: ${String(completion.tokensIn)} на вход, ` +
    `${String(completion.tokensOut)} на выход.\n` +
    `Стоимость: ${formatCost(cost)}\n`,
);
