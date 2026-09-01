import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { modelEnvSchema } from '../config/env.js';
import { withRetry } from '../infra/retry.js';
import { createLlmProvider } from '../modules/ai/providers/factory.js';
import { classifierSchema, toJsonSchema } from '../modules/ai/schemas/index.js';
import { describeToday } from '../modules/classifier/dates.js';
import { callCost, formatCost, type Cost } from '../modules/metering/pricing.js';

/**
 * Устойчивость классификации на одном и том же входе (задача 3.23).
 *
 * **Зачем.** На боевом 31.08.2026 один и тот же текст, разобранный три
 * раза, дал разные приоритеты: «съездить в магазин» получило `LATER`,
 * `LATER` и `SOON`. Текст выгрузки был побайтово одинаковый — сверено по
 * `md5`, — промпт и модель те же, все три вызова успешны.
 *
 * Первая мысль была про температуру: §10.2 требует «минимальную», а в бою
 * стояла 0.1. Замер её опроверг — при 0.1 и при 0 ответ совпал четыре
 * раза из четырёх. Значит дело не в температуре.
 *
 * **Дело в том, что в промпт уходят минуты.** `describeToday` пишет «Сейчас
 * понедельник, 31 августа 2026 г., 12:11», и три выгрузки пришли в 11:06,
 * 12:03 и 12:11 — то есть вход у них был **разный**, хотя человек сказал
 * ровно одно и то же. Ни одному решению классификации минута не нужна:
 * «в четверг» и «завтра» считаются от даты.
 *
 * Отсюда две проверки, и обе тут:
 *
 * - **часы стоят** — один вход, много прогонов: дребезжит ли модель сама;
 * - **часы идут** — тот же текст в разное время: дребезжит ли от минут.
 *
 * Запуск:
 *   AI_PROVIDER=yandex YANDEX_API_KEY=… YANDEX_FOLDER_ID=… \
 *     npx tsx src/scripts/check-stability.ts ../../docs/prompts/classifier@4.md
 *
 * Настройки: `PHASE` (`clock`, `temp` или `both`), `RUNS`, `TEMPERATURES`,
 * `WHENS`. Каждый прогон стоит денег заказчицы — отсюда скупые значения
 * по умолчанию.
 */

const [, , promptPath] = process.argv;

if (promptPath === undefined) {
  process.stderr.write('Использование: check-stability <файл-промпта-классификации>\n');
  process.exit(2);
}

const PHASE = process.env['PHASE'] ?? 'both';
const RUNS = Number(process.env['RUNS'] ?? '3');
const TEMPERATURES = (process.env['TEMPERATURES'] ?? '0.1,0')
  .split(',')
  .map((one) => Number(one.trim()));

/**
 * Времена трёх выгрузок с боевого, как они легли в базу.
 *
 * Не выдуманные: `opened_at` тех самых батчей. Разница между вторым и
 * третьим — восемь минут, и именно между ними ответ и изменился.
 */
const WHENS = (
  process.env['WHENS'] ?? '2026-08-31T08:06:49Z,2026-08-31T09:03:55Z,2026-08-31T09:11:55Z'
).split(',');

/**
 * Единицы того самого случая.
 *
 * Берётся вход **классификации**, а не текст выгрузки: дребезг был в
 * приоритетах, и мерить надо тот этап, который их ставит. Разбиение на
 * единицы делал извлекатель, и в бою оно все три раза совпало.
 */
const UNITS = [
  'съездить в магазин',
  'оплатить бухгалтеру налоги',
  'позвонить заказчику',
  'отправить ссылки на сайт',
  'купить себе витамины',
  'заплатить по учёбе',
];

/** Темы того человека — те, что были у него на боевом. */
const TOPICS = [
  'семья',
  'здоровье',
  'работа',
  'покупки',
  'дом',
  'дети',
  'деньги',
  'учёба',
  'личное',
];

const env = modelEnvSchema.parse(process.env);
const provider = createLlmProvider(env, { light: false });
const prompt = (await readFile(promptPath, 'utf8')).trim();

function inputAt(when: Date): string {
  return [
    describeToday(when, 'Europe/Moscow'),
    '',
    `Доступные темы: ${TOPICS.join(', ')}.`,
    '',
    'Мысли:',
    ...UNITS.map((text, index) => `${String(index + 1)}. ${text}`),
  ].join('\n');
}

/** Ответ одного прогона: только то, что влияет на выдачу. */
interface Answer {
  readonly key: string;
  readonly rows: readonly string[];
}

/** Расход копится в микроединицах: складывать рубли с копейками нельзя. */
let spentMicros = 0;
let currency: Cost['currency'] | undefined;

async function once(when: Date, temperature: number): Promise<Answer | undefined> {
  const completion = await withRetry(
    () =>
      provider.complete({
        prompt,
        input: inputAt(when),
        jsonSchema: toJsonSchema(classifierSchema),
        temperature,
      }),
    { attempts: 3 },
  );

  const cost = callCost(provider.name, {
    tokensIn: completion.tokensIn,
    tokensOut: completion.tokensOut,
  });

  if (cost !== null) {
    spentMicros += cost.micros;
    currency = cost.currency;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(completion.text);
  } catch {
    return undefined;
  }

  const parsed = classifierSchema.safeParse(payload);
  if (!parsed.success) return undefined;

  const rows = parsed.data.items.map(
    (item) => `${item.text} · ${item.type} · ${item.priority} · ${item.topic}`,
  );

  return { key: rows.join('|'), rows };
}

/** Что разошлось между наборами ответов — строка за строкой. */
function differences(samples: readonly Answer[]): string[] {
  const found: string[] = [];

  for (let line = 0; line < UNITS.length; line += 1) {
    const variants = new Set(samples.map((one) => one.rows[line] ?? '—'));
    if (variants.size > 1) found.push([...variants].join('   ⇄   '));
  }

  return found;
}

function report(title: string, samples: readonly Answer[]): string {
  const distinct = new Set(samples.map((one) => one.key)).size;
  const differing = differences(samples);

  process.stdout.write(`  разных ответов: ${String(distinct)} из ${String(samples.length)}\n`);
  for (const line of differing) process.stdout.write(`  расходится: ${line}\n`);
  process.stdout.write('\n');

  return (
    `${title}: ${String(distinct)} разных ответов из ${String(samples.length)}, ` +
    `расходится строк: ${String(differing.length)}`
  );
}

process.stdout.write(
  `Промпт: ${basename(promptPath)}\n` +
    `Провайдер: ${provider.name}\n` +
    `Единиц: ${String(UNITS.length)}\n\n`,
);

const summary: string[] = [];

if (PHASE === 'temp' || PHASE === 'both') {
  const when = new Date(WHENS[WHENS.length - 1] ?? '');

  for (const temperature of TEMPERATURES) {
    process.stdout.write(`==> Часы стоят, температура ${String(temperature)}\n`);

    const samples: Answer[] = [];
    for (let run = 1; run <= RUNS; run += 1) {
      const answer = await once(when, temperature);
      if (answer === undefined) {
        process.stdout.write(`  прогон ${String(run)}: ответ не по схеме\n`);
        continue;
      }
      samples.push(answer);
    }

    summary.push(report(`часы стоят, температура ${String(temperature)}`, samples));
  }
}

if (PHASE === 'clock' || PHASE === 'both') {
  const temperature = TEMPERATURES[0] ?? 0.1;

  process.stdout.write(`==> Часы идут, температура ${String(temperature)}\n`);

  const samples: Answer[] = [];
  for (const iso of WHENS) {
    const when = new Date(iso.trim());
    const answer = await once(when, temperature);

    if (answer === undefined) {
      process.stdout.write(`  ${iso}: ответ не по схеме\n`);
      continue;
    }

    process.stdout.write(`  ${describeToday(when, 'Europe/Moscow')}\n`);
    samples.push(answer);
  }

  summary.push(report(`часы идут, температура ${String(temperature)}`, samples));
}

process.stdout.write('Итог\n');
for (const line of summary) process.stdout.write(`  ${line}\n`);

const total = currency === undefined ? null : { micros: spentMicros, currency };
process.stdout.write(`\nПотрачено: ${formatCost(total)}\n`);
