import { basename } from 'node:path';

import type { Executor } from '../../infra/db.js';
import { meterCall } from '../../modules/metering/ai-calls.repo.js';
import type { SpendGuard } from '../../modules/metering/spend-guard.js';
import {
  DEFAULT_AUDIO_LIMITS,
  prepareAudio,
  withTempDir,
} from '../../modules/speech/audio.service.js';
import type { SpeechProvider } from '../../modules/speech/providers/types.js';

/**
 * Разбор одного живого файла для `check-speech.ts` (задача 1.15).
 *
 * Вынесен из скрипта затем, чтобы его можно было позвать из проверки:
 * скрипт живёт на верхнем уровне с побочными действиями — разбирает
 * аргументы, поднимает базу, выходит из процесса, — и тест его позвать не
 * может. Лежит рядом со скриптами, а не в `modules/speech`: стражи учёта
 * (`metered-send.wiring.test.ts`, `guard-coverage.test.ts`) держат список
 * платных путей бота закрытым и требуют от модулей идти через
 * `meterEachSend`; ручная проверка в этот список не входит и зовёт учёт
 * напрямую, как и прежде в скрипте.
 *
 * **Цену здесь не печатают** (ревизия этапов 1–2, дефект №18). Прежде в
 * конце стояла своя строка «стоимость …» — один `callCost` на всю
 * длительность записи, — а в учёт каждая часть уходит отдельной строкой с
 * округлением до блока в 15 секунд. На записи в 200 секунд это три части
 * 82/82/36: 6+6+3 = 15 блоков в учёте против 14 в напечатанной строке,
 * 2,44 ₽ против 2,28 ₽ в двух строках рядом. Скрипт существует ровно
 * затем, чтобы мерить цену на живых записях заказчицы, и число из него не
 * должно расходиться с базой. Единственная цена теперь — счёт обвязки
 * (`costReport`), который читает то, что записано: одно число не
 * считается двумя способами.
 */
export async function checkSpeechFile(params: {
  readonly db: Executor;
  readonly provider: SpeechProvider;
  /** Страж расхода обвязки: каждая часть проходит через потолок. */
  readonly spendGuard: SpendGuard;
  readonly filePath: string;
  readonly language: string;
  /** Куда печатать: скрипт отдаёт stdout, проверка — собирает в строку. */
  readonly write: (text: string) => void;
}): Promise<void> {
  const { db, provider, filePath, write } = params;

  write(`Провайдер: ${provider.name}\nФайл: ${basename(filePath)}\n\n`);

  await withTempDir(async (dir) => {
    const startedAt = Date.now();
    const prepared = await prepareAudio(filePath, dir, DEFAULT_AUDIO_LIMITS);

    write(
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
            language: params.language,
          });

          return { value: transcribed, usage: { audioSeconds: Math.ceil(seconds) } };
        },
        { guard: params.spendGuard },
      );

      const elapsed = ((Date.now() - partStartedAt) / 1000).toFixed(1);
      write(
        `Часть ${String(index + 1)} (${part.startSec.toFixed(1)}–${part.endSec.toFixed(1)} с, ` +
          `${elapsed} с на распознавание):\n${result.text || '(пусто)'}\n\n`,
      );

      texts.push(result.text);
    }

    write(
      `${'─'.repeat(60)}\nИтоговый текст:\n${texts.filter((text) => text !== '').join(' ')}\n\n` +
        `Всего: ${((Date.now() - startedAt) / 1000).toFixed(1)} с работы.\n`,
    );
  });
}
