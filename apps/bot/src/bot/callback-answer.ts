import type { Transformer } from 'grammy';
import type { ApiResponse } from 'grammy/types';
import type { Logger } from 'pino';

/**
 * Ответ на нажатие кнопки не останавливает обработчик (27.09.2026).
 *
 * **Что было.** Боевой журнал, 14:48:53: человек нажал «Согласна».
 * Согласие записалось, а ответ Telegram «нажатие принято» оборвался
 * (`ECONNRESET` — сеть сервера моргнула). grammY поднял ошибку, и
 * обработчик упал на этой строке: первый вопрос опроса так и не ушёл.
 * Второе нажатие сняло кнопку и промолчало — согласие уже было. Человек
 * остался без кнопки и без вопроса.
 *
 * **Почему глушится.** `answerCallbackQuery` только останавливает часики
 * на кнопке — Telegram и сам уберёт их через несколько секунд. Всё, ради
 * чего нажимали, идёт после него: запись, реплика, правка. Ни одному из
 * семидесяти восьми вызовов (27.09.2026) результат ответа не нужен, а
 * упасть на нём может любой. Поэтому здесь, в одной точке, как «та же правка»
 * (`same-content.ts`) и повтор отказа соединения (`retry.ts`).
 *
 * **Почему не повтор.** Обрыв посреди ответа не говорит, дошёл ли он:
 * второй ответ на то же нажатие Telegram отвергнет, а обработчик так и
 * будет стоять. Незачем — часики не стоят того, чтобы ждать.
 *
 * **Глушится ровно этот вызов.** Сбой реплики, правки и любого другого
 * вызова поднимается как раньше: это то, что человек должен увидеть, и
 * прятать его тишину нельзя.
 */

const METHOD = 'answerCallbackQuery';

/** Отказ Telegram значением: `{ok: false}` — grammY поднимет его после нас. */
function refused(answer: unknown): boolean {
  return typeof answer === 'object' && answer !== null && (answer as { ok?: unknown }).ok === false;
}

export interface QuietCallbackAnswerOptions {
  /** Сбой называется предупреждением: он безвреден, но видеть его надо. */
  readonly logger?: Logger | undefined;
}

/** Преобразователь для `bot.api.config.use`. */
export function quietCallbackAnswer(options: QuietCallbackAnswerOptions = {}): Transformer {
  /**
   * Приведение неизбежно и потому названо: ответ типизирован по методу, а
   * глушение касается ровно одного, у которого `true` — законный ответ.
   */
  const done = <T>(): ApiResponse<T> => ({ ok: true, result: true as T });

  const note = (failure: Record<string, unknown>): void => {
    options.logger?.warn(
      { ...failure, method: METHOD },
      'Ответ на нажатие кнопки не ушёл — обработчик идёт дальше',
    );
  };

  return async (prev, method, payload, signal) => {
    if (method !== METHOD) return await prev(method, payload, signal);

    try {
      const answer = await prev(method, payload, signal);
      if (!refused(answer)) return answer;

      const { error_code: code, description } = answer as {
        error_code?: unknown;
        description?: unknown;
      };
      note({ code, description });
      return done();
    } catch (error) {
      note({ err: error });
      return done();
    }
  };
}
