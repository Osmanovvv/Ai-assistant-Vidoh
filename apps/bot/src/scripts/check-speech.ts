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
    const result = await provider.transcribe({
      filePath: part.path,
      durationSec: part.endSec - part.startSec,
      language: env.SPEECH_LANGUAGE,
    });

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
