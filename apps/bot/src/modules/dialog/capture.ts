import type { Transformer } from 'grammy';
import type { Logger } from 'pino';

import type { DialogStore } from './dialog.store.js';

/**
 * Реплики бота — в хвост разговора (решение Никиты 24.09.2026, план docs/26,
 * задача 7).
 *
 * **Одна точка на все ответы.** Бот пишет из десятков мест: конвейер,
 * вопросы, карточки, напоминания, кнопки. Все они идут через `bot.api` —
 * преобразователь на нём видит каждую реплику, и новая реплика, добавленная
 * завтра, попадёт в разговор без правки здесь. Ловить в каждом месте
 * значило бы однажды забыть одно — урок «правило для одного пути молчит на
 * соседнем» (находки 56–57).
 *
 * Только личный чат: ветки тем живут в нём же, а в группе разговор не один
 * на человека. Сбой хранилища отправку не трогает — реплика уйдёт, просто
 * без записи: разговор без неё хуже, но потерянный ответ — много хуже.
 */

/** Метод Telegram → поле с текстом реплики. */
const SAID: Readonly<Record<string, 'text' | 'caption'>> = {
  sendMessage: 'text',
  editMessageText: 'text',
  sendPhoto: 'caption',
  editMessageCaption: 'caption',
};

interface Sent {
  readonly chat_id?: unknown;
  readonly message_id?: unknown;
  readonly text?: unknown;
  readonly caption?: unknown;
}

export function rememberBotReplies(
  store: DialogStore | undefined,
  options: { readonly now?: () => Date; readonly logger?: Logger | undefined } = {},
): Transformer {
  return async (prev, method, payload, signal) => {
    const answer = await prev(method, payload, signal);

    const field = SAID[method];
    if (store === undefined || field === undefined || !answer.ok) return answer;

    const sent = payload as Sent;
    const text = sent[field];
    if (typeof sent.chat_id !== 'number' || sent.chat_id <= 0) return answer;
    if (typeof text !== 'string' || text.trim() === '') return answer;

    // Номер сообщения: у правки — из запроса, у новой отправки — из ответа.
    const result: unknown = answer.result;
    const answered =
      typeof result === 'object' && result !== null
        ? (result as { readonly message_id?: unknown }).message_id
        : undefined;
    const messageId =
      typeof sent.message_id === 'number'
        ? sent.message_id
        : typeof answered === 'number'
          ? answered
          : undefined;

    try {
      await store.remember(sent.chat_id, {
        role: 'bot',
        text,
        at: (options.now ?? (() => new Date()))(),
        ...(messageId === undefined ? {} : { messageId }),
      });
    } catch (error) {
      // Текст реплики в журнал не идёт — только то, что запись не удалась.
      options.logger?.warn(
        { err: error, method },
        'Реплика бота не запомнилась — разговор без неё',
      );
    }

    return answer;
  };
}
