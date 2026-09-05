import { GrammyError, type Transformer } from 'grammy';
import type { ApiResponse } from 'grammy/types';

/**
 * Правка сообщения тем же содержимым — не ошибка (задача 3.73).
 *
 * **Найдено в боевом журнале 05.09.2026.** `GrammyError: Call to
 * 'editMessageText' failed! (400: Bad Request: message is not modified:
 * specified new message content and reply markup are exactly the same as
 * a current content and reply markup of the message)` — из `menu.ts`, при
 * показе темы.
 *
 * **Одна кнопка вызывает это всегда.** Номер страницы в списке —
 * `«2 из 7»` — сделан кнопкой, ведущей на **ту же** страницу: у Telegram
 * нет надписи без нажатия, а знать, где ты в списке, надо. Значит
 * содержимое после нажатия совпадает знак в знак, и Telegram отвергает
 * правку. То же при возврате в тот же список и при двойном нажатии.
 *
 * **Чем это плохо.** Отказ поднимается посреди обработчика, и всё, что
 * шло после правки, не выполняется вовсе. Здесь это была последняя
 * строка — человек ничего не заметил, — но правка стоит в середине ещё в
 * пятидесяти местах: удаление данных, конец опроса, ответ карточки.
 * Оставлять такую мину на будущее нельзя. И журнал она засоряет уровнем
 * ошибки — а с задачи 3.72 такие строки поднимают тревогу.
 *
 * **Почему здесь, а не в пятидесяти местах.** Это свойство Telegram, а не
 * решение нашей логики: ни одному вызывающему не нужно знать, изменилось
 * ли сообщение, — все пятьдесят три вызова результат правки отбрасывают.
 * Преобразователь — то же место, где уже живёт повтор отказа соединения
 * (задача 3.60).
 *
 * **Отказ приходит значением, а не броском, и первая версия на этом
 * упала.** Она ловила только `GrammyError` — и в бою не сработала бы ни
 * разу: ошибку из ответа `{ok: false}` grammY поднимает **после** всех
 * преобразователей, а до них доходит сам ответ. Нашлось поддельным
 * Telegram в тесте; на выдуманной форме ошибки версия выглядела рабочей.
 * Обрабатываются обе формы: ответ — потому что так бывает, бросок —
 * потому что так может завернуть вызывающий.
 *
 * **Глушится ровно один отказ.** «Сообщение не найдено», «нельзя
 * править» и любой другой 400 проходят наружу как раньше: они означают,
 * что мы потеряли сообщение из вида, и молчать о них нельзя.
 */

const SAME_CONTENT = 'message is not modified';

/** Отказ в ответе Telegram: `{ok: false, error_code, description}`. */
function refusesSameContent(answer: unknown): boolean {
  if (typeof answer !== 'object' || answer === null) return false;

  const body = answer as { ok?: unknown; error_code?: unknown; description?: unknown };

  return (
    body.ok === false &&
    body.error_code === 400 &&
    typeof body.description === 'string' &&
    body.description.includes(SAME_CONTENT)
  );
}

/**
 * Тот самый отказ — в любой из двух форм.
 *
 * Сверяется по тексту: своего кода у него нет, только описание.
 */
export function isSameContent(value: unknown): boolean {
  if (value instanceof GrammyError) {
    return value.error_code === 400 && value.description.includes(SAME_CONTENT);
  }

  return refusesSameContent(value);
}

/**
 * Преобразователь для `bot.api.config.use`.
 *
 * Возвращает успех с `true` — тем же, что Telegram отдаёт на правку
 * сообщения без встроенной клавиатуры. Содержимое и так уже такое,
 * какого мы добивались.
 */
export function tolerateSameContent(): Transformer {
  /**
   * Приведение здесь неизбежно и потому названо.
   *
   * Ответ метода Telegram типизирован по самому методу: у `sendMessage`
   * это сообщение, у `editMessageText` — сообщение **или** `true`.
   * Выразить «успех с `true`» для любого метода система типов не
   * позволяет, а глушение касается ровно одного метода, у которого
   * `true` — законный ответ.
   */
  const done = <T>(): ApiResponse<T> => ({ ok: true, result: true as T });

  return async (prev, method, payload, signal) => {
    try {
      const answer = await prev(method, payload, signal);
      return isSameContent(answer) ? done() : answer;
    } catch (error) {
      if (!isSameContent(error)) throw error;
      return done();
    }
  };
}
