import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { aiCalls } from '../../db/schema.js';
import { rublesOf } from '../../modules/metering/account-spend.js';
import { callCost, SPEECH_BILLING_BLOCK_SEC } from '../../modules/metering/pricing.js';
import { createRunGuard } from '../../modules/metering/run-guard.js';
import { withTempDir } from '../../modules/speech/audio.service.js';
import { probeDurationSec } from '../../modules/speech/ffmpeg.js';
import type {
  SpeechProvider,
  TranscriptionRequest,
  TranscriptionResult,
} from '../../modules/speech/providers/types.js';
import { makeAudio } from '../../test/audio.js';
import { testDb } from '../../test/db.js';
import { checkSpeechFile } from './check-speech-file.js';

/**
 * Служебная проверка речи называет одну цену — ту, что записана в учёт
 * (ревизия этапов 1–2, дефект №18).
 *
 * Скрипт `check-speech.ts` существует затем, чтобы мерить цену на живых
 * записях заказчицы. Он печатал свою строку «стоимость …» — один
 * `callCost` на всю длительность записи, — а в учёт каждая часть уходила
 * отдельной строкой с округлением до блока в 15 секунд. Две строки рядом
 * противоречили друг другу, и та, что печаталась первой, была меньше
 * настоящей.
 *
 * Обстановка дефекта воспроизводится целиком: настоящая запись в 200
 * секунд, настоящий ffmpeg режет её по паузам на три части, каждая часть
 * проходит через учёт с боевым прайсом. Провайдер поддельный: денег
 * проверка не тратит.
 */

/** Ключ прайса, под которым провайдер пишет в учёт: цена берётся боевая. */
const MODEL = 'yandex:general';

/** Провайдер без сети: отвечает мгновенно и считает секунды как боевой. */
class FreeProvider implements SpeechProvider {
  readonly name = MODEL;

  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    return Promise.resolve({
      text: 'часть',
      model: MODEL,
      audioSeconds: Math.round(request.durationSec),
    });
  }
}

/** Исходник без комментариев: прежний приём тут описан словами. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/u, '$1'))
    .join('\n');
}

describe('служебная проверка речи называет одну цену — из учёта', () => {
  it('разбор файла цену не считает сам, а счёт сходится с записанным по частям', async () => {
    const db = testDb();
    const guard = createRunGuard({
      db,
      env: { ACCOUNT_SPEND_WARN_SHARE: 0.8 },
      startedAt: new Date(),
    });
    const printed: string[] = [];

    const rows = await withTempDir(async (dir) => {
      const source = join(dir, 'source.wav');
      // Речь, пауза, речь, пауза, речь: 200 секунд, режется на три части
      // около 81, 82 и 37 секунд — как в разборе дефекта (82/82/36).
      await makeAudio(source, [
        { kind: 'tone', sec: 80 },
        { kind: 'silence', sec: 2 },
        { kind: 'tone', sec: 80 },
        { kind: 'silence', sec: 2 },
        { kind: 'tone', sec: 36 },
      ]);

      await checkSpeechFile({
        db,
        provider: new FreeProvider(),
        spendGuard: guard.spendGuard,
        filePath: source,
        language: 'ru',
        write: (text) => {
          printed.push(text);
        },
      });

      const recorded = await db
        .select({ audioSeconds: aiCalls.audioSeconds, costMicros: aiCalls.costMicros })
        .from(aiCalls)
        .where(eq(aiCalls.stage, 'speech'))
        .orderBy(asc(aiCalls.id));

      return { recorded, wholeSec: Math.round(await probeDurationSec(source)) };
    });

    // Каждая часть — своя строка учёта, и у каждой есть цена.
    expect(rows.recorded).toHaveLength(3);
    const seconds = rows.recorded.map((row) => row.audioSeconds ?? Number.NaN);
    const ledgerMicros = rows.recorded.reduce((sum, row) => sum + (row.costMicros ?? 0), 0);
    expect(rows.recorded.every((row) => row.costMicros !== null)).toBe(true);

    /**
     * Страж стража: обстановка действительно та, в которой дефект виден.
     *
     * Округление до блока у каждой части даёт на один блок больше, чем
     * округление всей записи разом: 6+6+3 против 14. Совпади они — и
     * проверка ниже не отличала бы починенное дерево от сломанного.
     */
    const blocksByPart = seconds.reduce(
      (sum, sec) => sum + Math.ceil(sec / SPEECH_BILLING_BLOCK_SEC),
      0,
    );
    expect(blocksByPart, `части ${seconds.join('/')} с`).toBe(15);
    const wholeCost = callCost(MODEL, { audioSeconds: rows.wholeSec });
    expect(wholeCost?.micros, 'цена всей записи разом совпала с учётом по частям').not.toBe(
      ledgerMicros,
    );

    // Сам разбор цену не называет: своя строка и была той, что расходилась.
    const output = printed.join('');
    expect(output).toContain('частей: 3');
    expect(
      output,
      'разбор файла напечатал свою цену — а цена должна быть одна, из учёта',
    ).not.toMatch(/₽|стоимост|цена/iu);

    // Единственная цена — счёт обвязки, и это ровно сумма записанного.
    const report = await guard.costReport();
    expect(report).toContain(`Этот прогон: ${rublesOf(ledgerMicros)} ₽ за 3 обращений.`);
    expect(report).not.toContain('нижняя оценка');
  }, 120_000);

  it('скрипт зовёт разбор и печатает счёт, а своей цены не считает', async () => {
    /**
     * Связка — по исходнику: скрипт живёт на верхнем уровне с побочными
     * действиями, и позвать его проверка не может. Разбор, который скрипт
     * не зовёт, — «написано, покрыто тестами и недостижимо»; строка
     * `callCost`/`formatCost` в скрипте — второй способ посчитать то же
     * число, то есть сам дефект.
     */
    const here = dirname(fileURLToPath(import.meta.url));
    const script = code(await readFile(resolve(here, '../check-speech.ts'), 'utf8'));

    expect(script, 'скрипт не зовёт разбор файла').toContain('checkSpeechFile(');
    expect(script, 'скрипт не печатает счёт из учёта').toContain('costReport(');
    expect(script, 'скрипт считает цену сам, мимо учёта').not.toMatch(
      /\b(callCost|formatCost)\s*\(/u,
    );
  });
});
