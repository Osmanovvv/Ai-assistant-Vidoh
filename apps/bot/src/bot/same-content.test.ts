import { GrammyError, HttpError } from 'grammy';
import { describe, expect, it } from 'vitest';

import { isSameContent, tolerateSameContent } from './same-content.js';

/**
 * Правка тем же содержимым (задача 3.73).
 *
 * Из боевого журнала 05.09.2026: кнопка с номером страницы ведёт на ту же
 * страницу, содержимое совпадает знак в знак, и Telegram отвергает
 * правку четырёхсотым. Отказ поднимался посреди обработчика.
 */

const SAME_CONTENT =
  'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message';

/** Ответ Telegram, как он на самом деле доходит до преобразователя. */
function answered(description: string) {
  return { ok: false as const, error_code: 400, description };
}

/** Тот же отказ, каким его поднимает grammY — уже после нас. */
function refusal(description: string): GrammyError {
  return new GrammyError(
    `Call to 'editMessageText' failed!`,
    answered(description),
    'editMessageText',
    {},
  );
}

describe('isSameContent', () => {
  it('узнаёт боевой отказ дословно — и в ответе, и в броске', () => {
    /**
     * **Форма ответа здесь главная.** Первая версия правила ловила
     * только бросок и в бою не сработала бы ни разу: ошибку из ответа
     * `{ok: false}` grammY поднимает **после** всех преобразователей.
     * Нашлось поддельным Telegram в `bot.test.ts`.
     */
    expect(isSameContent(answered(SAME_CONTENT))).toBe(true);
    expect(isSameContent(refusal(SAME_CONTENT))).toBe(true);
  });

  describe('чего глушить нельзя', () => {
    it('другие отказы Telegram проходят наружу', () => {
      /**
       * Здесь вся цена правила. «Сообщение не найдено» означает, что бот
       * потерял из вида то, что правит: человек видит одно, а бот считает
       * другим. Проглотить это молча — значит спрятать рассинхронизацию,
       * которая дальше только растёт.
       */
      for (const description of [
        'Bad Request: message to edit not found',
        'Bad Request: message can not be edited',
        'Bad Request: MESSAGE_ID_INVALID',
        'Forbidden: bot was blocked by the user',
      ]) {
        expect(isSameContent(refusal(description)), description).toBe(false);
        expect(isSameContent(answered(description)), description).toBe(false);
      }
    });

    it('сетевой сбой правкой не считается', () => {
      expect(isSameContent(new HttpError('Network request failed!', new Error('обрыв')))).toBe(
        false,
      );
    });

    it('своя ошибка не считается', () => {
      expect(isSameContent(new Error('message is not modified'))).toBe(false);
      expect(isSameContent(undefined)).toBe(false);
      expect(isSameContent(null)).toBe(false);
    });
  });
});

describe('tolerateSameContent', () => {
  it('обработчик продолжает работу: правка считается удавшейся', async () => {
    /**
     * Ради этого правило и написано. Отказ поднимался посреди
     * обработчика, и всё, что шло после правки, не выполнялось вовсе —
     * в пятидесяти трёх местах, включая удаление данных и конец опроса.
     *
     * Проверяются оба пути: настоящий — отказ в ответе — и бросок, каким
     * его может завернуть вызывающий.
     */
    const transform = tolerateSameContent();

    const fromAnswer = await transform(
      () => Promise.resolve(answered(SAME_CONTENT)) as never,
      'editMessageText',
      {},
      undefined,
    );
    const fromThrow = await transform(
      () => Promise.reject(refusal(SAME_CONTENT)),
      'editMessageText',
      {},
      undefined,
    );

    expect(fromAnswer).toEqual({ ok: true, result: true });
    expect(fromThrow).toEqual({ ok: true, result: true });
  });

  it('остальные отказы поднимаются как раньше', async () => {
    const transform = tolerateSameContent();
    const lost = 'Bad Request: message to edit not found';

    await expect(
      transform(() => Promise.reject(refusal(lost)), 'editMessageText', {}, undefined),
    ).rejects.toBeInstanceOf(GrammyError);

    // Отказ в ответе тоже обязан пройти наружу нетронутым: поднимать его
    // будет grammY, и подменять ответ здесь значило бы спрятать причину.
    await expect(
      transform(() => Promise.resolve(answered(lost)) as never, 'editMessageText', {}, undefined),
    ).resolves.toEqual(answered(lost));
  });

  it('удавшийся вызов не трогает', async () => {
    const transform = tolerateSameContent();
    const sent = { ok: true as const, result: { message_id: 7 } };

    await expect(
      transform(
        () => Promise.resolve(sent) as never,
        'sendMessage',
        { chat_id: 1, text: 'ответ' },
        undefined,
      ),
    ).resolves.toEqual(sent);
  });
});
