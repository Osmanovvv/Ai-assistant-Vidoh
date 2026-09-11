import { closeDb, getDb } from '../infra/db.js';
import { createLogger } from '../infra/logger.js';
import { createRunGuard } from '../modules/metering/run-guard.js';

import { modelEnvSchema } from '../config/env.js';
import { createSpeechProvider } from '../modules/speech/providers/factory.js';
import { checkSpeechFile } from './lib/check-speech-file.js';

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

/**
 * Цена файла — только строкой счёта ниже (ревизия этапов 1–2, дефект №18).
 *
 * Своей строки «стоимость …» у скрипта больше нет: она считала один
 * `callCost` на всю запись и расходилась с учётом, где каждая часть
 * округлена до блока отдельно. Почему так — в докстринге `checkSpeechFile`.
 */
await checkSpeechFile({
  db,
  provider,
  spendGuard: guard.spendGuard,
  filePath,
  language: env.SPEECH_LANGUAGE,
  write: (text) => {
    process.stdout.write(text);
  },
});

process.stdout.write(
  String.fromCharCode(10) + (await guard.costReport()) + String.fromCharCode(10),
);
await closeDb();
