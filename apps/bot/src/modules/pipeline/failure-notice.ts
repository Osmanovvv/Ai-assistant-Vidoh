import type { Logger } from 'pino';

import type { Batch } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { finishStatus, statusIsTaken, type StatusSender } from '../presenter/status.service.js';
import { PermanentSpeechError, TransientSpeechError } from '../speech/providers/types.js';
import { textProfileOf } from '../users/settings.repo.js';
import { textsFor } from '../../texts/index.js';
import { statusTarget } from './transcribe.js';

/**
 * Сообщение человеку о сорвавшемся разборе (§17 ТЗ).
 *
 * **Зачем понадобилось.** §17 требует: «Модель недоступна → выгрузка
 * сохраняется в очередь с повтором, пользователю честное короткое
 * сообщение о задержке». И первой строкой: «Не удалась расшифровка → бот
 * просит прислать текстом или повторить».
 *
 * Ни того, ни другого не было. Текст `errors.generic` лежал в словаре и не
 * вызывался ни разу — сверка с ТЗ 28.08.2026. Человек говорил, видел
 * «Секунду, слушаю запись» и больше ничего, навсегда: сбойные выгрузки
 * намеренно не переподхватываются, а админки, из которой их перезапускают,
 * не будет до четвёртого этапа.
 *
 * Его слова при этом целы — инвариант §9.1 соблюдался. Но человек об этом
 * не знал, а это и есть то самое доверие, ради которого §9 написан.
 *
 * **Три разных случая, три разных текста.** Сказать «попробуй ещё раз»
 * там, где выгрузка уже стоит в очереди на повтор, — это позвать человека
 * сделать работу дважды и заплатить дважды.
 */

export interface FailureNoticeDeps {
  readonly db: Database;
  readonly sender?: StatusSender | undefined;
  readonly logger?: Logger | undefined;
}

export interface BatchFailure {
  /** Выгрузка вернулась в очередь и будет повторена. */
  readonly retryable: boolean;
  readonly error: unknown;
}

function isSpeechFailure(error: unknown): boolean {
  return error instanceof TransientSpeechError || error instanceof PermanentSpeechError;
}

/**
 * Какой текст сказать человеку.
 *
 * Вынесено отдельной чистой функцией: выбор текста — это решение, и его
 * надо проверять тестом, а не читать глазами в обработчике.
 */
export function noticeKindOf(failure: BatchFailure): 'delayed' | 'speechFailed' | 'generic' {
  // Повтор впереди — значит речь о задержке, а не о поражении.
  if (failure.retryable) return 'delayed';

  // Расшифровка не удалась окончательно: §17 просит предложить текст.
  if (isSpeechFailure(failure.error)) return 'speechFailed';

  return 'generic';
}

/**
 * Докладчик о сбое для конвейера.
 *
 * Отправка идёт через `finishStatus`, то есть **правит то же статусное
 * сообщение**, которое человек уже видит. Одна выгрузка — одна реплика
 * бота (§9.2), и сбой не повод присылать вторую.
 *
 * **Кроме случая, когда в слоте уже лежит ответ по существу.** Найдено
 * ревизией первого этапа. Человек отвечает на открытый вопрос, правка
 * применяется, и он получает «Перенесла срок на пятницу» с кнопкой
 * «Отменить» — это и есть занятый слот. Дальше в той же выгрузке
 * срывается извлечение или классификация, докладчик правит слот, и
 * подтверждение исчезает вместе с кнопкой отката. На повторном заходе
 * оно не вернётся: вопрос уже закрыт, и ветка, которая его печатала,
 * больше не сработает. Итог — правка в базе есть, человек о ней не
 * знает и откатить её нечем.
 *
 * Поэтому здесь тот же порядок, что у обработчика выгрузки: занят слот —
 * говорим своим сообщением, а чужое не трогаем.
 */
export function createFailureReporter(deps: FailureNoticeDeps) {
  return async (db: Database, batch: Batch, failure: BatchFailure): Promise<void> => {
    if (!deps.sender) return;

    const target = await statusTarget(db, batch.id);
    if (!target) return;

    const texts = textsFor(await textProfileOf(db, batch.userId));
    const kind = noticeKindOf(failure);
    const taken = await statusIsTaken({ db, sender: deps.sender }, batch.id);

    if (taken) {
      await deps.sender.send({
        chatId: target.chatId,
        ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
        text: texts.errors[kind],
      });
    } else {
      await finishStatus({ db, sender: deps.sender }, target, texts.errors[kind]);
    }

    deps.logger?.info(
      { batchId: batch.id, userId: batch.userId, kind, retryable: failure.retryable, своим: taken },
      'Человеку сказано о сбое разбора',
    );
  };
}
