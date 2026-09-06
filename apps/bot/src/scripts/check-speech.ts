import { closeDb, getDb } from '../infra/db.js';
import { createLogger } from '../infra/logger.js';
import { meterCall } from '../modules/metering/ai-calls.repo.js';
import { createRunGuard } from '../modules/metering/run-guard.js';
import { basename } from 'node:path';

import { modelEnvSchema } from '../config/env.js';
import {
  DEFAULT_AUDIO_LIMITS,
  prepareAudio,
  withTempDir,
} from '../modules/speech/audio.service.js';
import { callCost, formatCost } from '../modules/metering/pricing.js';
import { createSpeechProvider } from '../modules/speech/providers/factory.js';

/**
 * Проверка расшифровки на живом файле (задача 1.15).
 *
 * Нужна затем же, зачем нужна сама задача: провайдер, работающий на
 * тестах с подменённым fetch, ещё не значит работающий провайдер.
 * Скрипт гоняет настоящий файл через настоящий ffmpeg и настоящий API
 * и показывает, что получилось и сколько это стоило.
 *
 * Останется полезным и после первого этапа: приёмка ждёт голосовых
 * выгрузок заказчицы, и качество распознавания на её записях — а не на
 * синтезированной речи — проверять будем этим же скриптом.
 *
 * Запуск:
 *   SPEECH_PROVIDER=yandex YANDEX_API_KEY=… npx tsx src/scripts/check-speech.ts запись.ogg
 */

const [, , filePath] = process.argv;

if (filePath === undefined) {
  process.stderr.write('Укажите путь к файлу: npx tsx src/scripts/check-speech.ts запись.ogg\n');
  process.exit(2);
}

const env = modelEnvSchema.parse(process.env);

/** Обвязке нужен журнал; сам скрипт говорит с человеком печатью. */
const speechLogger = createLogger({ level: 'warn' });

/**
 * Учёт и потолок расхода (задача 3.82).
 *
 * Поштучно дёшево — около 0,65 ₽ за минуту звука, — но это инструмент
 * подбора: им разбирают живые записи подряд, и в шапке прямо обещано
 * проверять им голосовые на приёмке. Ни одна из этих трат не попадала
 * ни в учёт, ни в отчёт по базам: счёт Yandex всегда был больше, чем
 * показывал отчёт, и на сколько именно — неизвестно.
 */
const db = getDb();
const guard = createRunGuard({ db, env, logger: speechLogger, startedAt: new Date() });
const refusedByCeiling = await guard.checkBefore();

if (refusedByCeiling !== undefined) {
  process.stderr.write(`Замер не начат: ${refusedByCeiling}${String.fromCharCode(10)}`);
  await closeDb();
  process.exit(3);
}

const provider = createSpeechProvider(env);

process.stdout.write(`Провайдер: ${provider.name}\nФайл: ${basename(filePath)}\n\n`);

await withTempDir(async (dir) => {
  const startedAt = Date.now();
  const prepared = await prepareAudio(filePath, dir, DEFAULT_AUDIO_LIMITS);

  process.stdout.write(
    `Длительность: ${prepared.durationSec.toFixed(1)} с, частей: ${String(prepared.parts.length)}` +
      `${prepared.truncated ? ' (хвост обрезан по потолку)' : ''}\n\n`,
  );

  const texts: string[] = [];

  for (const [index, part] of prepared.parts.entries()) {
    const partStartedAt = Date.now();
    const seconds = part.endSec - part.startSec;

    const result = await meterCall(
      db,
      { stage: 'speech', model: provider.name },
      async () => {
        const transcribed = await provider.transcribe({
          filePath: part.path,
          durationSec: seconds,
          language: env.SPEECH_LANGUAGE,
        });

        return { value: transcribed, usage: { audioSeconds: Math.ceil(seconds) } };
      },
      { guard: guard.spendGuard },
    );

    const elapsed = ((Date.now() - partStartedAt) / 1000).toFixed(1);
    process.stdout.write(
      `Часть ${String(index + 1)} (${part.startSec.toFixed(1)}–${part.endSec.toFixed(1)} с, ` +
        `${elapsed} с на распознавание):\n${result.text || '(пусто)'}\n\n`,
    );

    texts.push(result.text);
  }

  const seconds = Math.round(prepared.durationSec);
  process.stdout.write(
    `${'─'.repeat(60)}\nИтоговый текст:\n${texts.filter((text) => text !== '').join(' ')}\n\n` +
      `Всего: ${((Date.now() - startedAt) / 1000).toFixed(1)} с работы, ` +
      // Цена берётся из прайс-листа. Пока она там не заполнена, здесь
      // честно написано «неизвестна», а не выдуманный ноль.
      `стоимость ${formatCost(callCost(provider.name, { audioSeconds: seconds }))}\n`,
  );
});

process.stdout.write(
  String.fromCharCode(10) + (await guard.costReport()) + String.fromCharCode(10),
);
await closeDb();
