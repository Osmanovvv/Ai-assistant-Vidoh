import { gte } from 'drizzle-orm';

import { aiCalls } from '../db/schema.js';
import { closeDb, getDb } from '../infra/db.js';
import { collectCost } from '../modules/metering/cost-per-dump.js';
import { formatCost, PRICING } from '../modules/metering/pricing.js';

/**
 * Себестоимость выгрузки (задача 2.21).
 *
 * Запуск:
 *   DATABASE_URL=… npx tsx src/scripts/cost-report.ts [дней]
 *
 * По умолчанию берёт весь учёт; аргументом можно ограничить последними
 * днями — например, посчитать месяц после запуска тестовой группы.
 *
 * Отчёт печатается, а не складывается в файл: числа меняются с каждой
 * выгрузкой, и хранить снимок значило бы однажды сослаться на устаревший.
 * Итог этапа пишется руками в `docs/05-sebestoimost.md` — с датой и
 * версиями промптов, на которых он получен.
 */

const [, , daysArg] = process.argv;
const days = daysArg === undefined ? undefined : Number(daysArg);

if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
  process.stderr.write('Использование: cost-report [дней]\n');
  process.exit(2);
}

const db = getDb();

try {
  const since = days === undefined ? undefined : new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      batchId: aiCalls.batchId,
      stage: aiCalls.stage,
      model: aiCalls.model,
      tokensIn: aiCalls.tokensIn,
      tokensOut: aiCalls.tokensOut,
      audioSeconds: aiCalls.audioSeconds,
      costMicros: aiCalls.costMicros,
      costCurrency: aiCalls.costCurrency,
    })
    .from(aiCalls)
    .where(since === undefined ? undefined : gte(aiCalls.createdAt, since));

  // Колонка объявлена bigint в режиме числа, преобразование делает
  // drizzle: микроединицы расхода в число двойной точности укладываются
  // с запасом в четыре порядка.
  const report = collectCost(rows);

  const number = (value: number): string => value.toFixed(0);
  const period = days === undefined ? 'весь учёт' : `последние ${String(days)} дн.`;

  const lines = [
    '',
    `Себестоимость выгрузки — ${period}`,
    `Выгрузок: ${String(report.dumps)}, вызовов вне выгрузки: ${String(report.unlinkedCalls)}`,
    '',
    '                   средняя      90-й проц.   максимум',
    `Звук, сек:         ${number(report.audioSeconds.average).padEnd(12)} ${number(report.audioSeconds.p90).padEnd(12)} ${number(report.audioSeconds.max)}`,
    `Входных токенов:   ${number(report.tokensIn.average).padEnd(12)} ${number(report.tokensIn.p90).padEnd(12)} ${number(report.tokensIn.max)}`,
    `Выходных токенов:  ${number(report.tokensOut.average).padEnd(12)} ${number(report.tokensOut.p90).padEnd(12)} ${number(report.tokensOut.max)}`,
  ];

  if (report.cost === undefined) {
    lines.push('', 'Стоимость не считается: цена ни одной выгрузки не известна целиком.');
  } else {
    const money = (micros: number): string =>
      formatCost({ micros: Math.round(micros), currency: report.cost?.currency ?? 'rub' });

    lines.push(
      '',
      `Стоимость выгрузки (по ${String(report.cost.dumps)} выгрузкам с известной ценой):`,
      `  средняя:      ${money(report.cost.average)}`,
      `  90-й проц.:   ${money(report.cost.p90)}`,
      `  максимум:     ${money(report.cost.max)}`,
    );
  }

  if (report.dumpsWithUnknownPrice > 0) {
    lines.push(
      `Выгрузок с неизвестной ценой хотя бы одного вызова: ${String(report.dumpsWithUnknownPrice)}`,
    );
  }

  lines.push('', 'На одну выгрузку по стадиям:');

  for (const stage of report.byStage) {
    const volume =
      stage.audioSeconds > 0
        ? `${number(stage.audioSeconds)} сек`
        : `${number(stage.tokensIn)} вх. / ${number(stage.tokensOut)} вых. токенов`;

    const price =
      stage.micros === undefined
        ? 'цена неизвестна'
        : formatCost({ micros: Math.round(stage.micros), currency: stage.currency ?? 'rub' });

    lines.push(
      `  ${stage.stage.padEnd(11)} ${number(stage.calls)} выз.  ${volume.padEnd(34)} ${price}`,
    );
  }

  if (report.modelsWithoutPrice.length > 0) {
    lines.push(
      '',
      `Моделей без цены в прайс-листе: ${report.modelsWithoutPrice.join(', ')}`,
      'Пока цена не задана в modules/metering/pricing.ts, себестоимость в рублях не считается.',
      `Сейчас в прайс-листе моделей: ${String(Object.keys(PRICING).length)}`,
    );
  }

  process.stdout.write(`${lines.join('\n')}\n`);
} finally {
  await closeDb();
}
