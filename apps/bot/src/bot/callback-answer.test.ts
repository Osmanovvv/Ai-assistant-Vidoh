import { Writable } from 'node:stream';

import { GrammyError, HttpError } from 'grammy';
import { describe, expect, it } from 'vitest';

import { createLogger } from '../infra/logger.js';
import { quietCallbackAnswer } from './callback-answer.js';

/**
 * Ответ на нажатие кнопки не останавливает обработчик (27.09.2026).
 *
 * Боевой журнал, 14:48:53: человек нажал «Согласна», согласие записалось,
 * а ответ Telegram «нажатие принято» оборвался (`ECONNRESET`). Обработчик
 * упал на этой строке и не прислал первый вопрос. Второе нажатие молчало —
 * согласие уже было. Человек остался без кнопки и без вопроса.
 */

const TOKEN = '123456789:TESTTESTTESTTESTTESTTESTTESTTEST';

/** Обрыв посреди ответа — как в боевом журнале, с токеном в адресе. */
function connectionReset(method: string): HttpError {
  const inner = Object.assign(
    new Error(
      `request to https://api.telegram.org/bot${TOKEN}/${method} failed, reason: read ECONNRESET`,
    ),
    { code: 'ECONNRESET' },
  );
  return new HttpError(`Network request for '${method}' failed!`, inner);
}

/** Отказ Telegram значением — так он доходит до преобразователя. */
function refused(description: string) {
  return { ok: false as const, error_code: 400, description };
}

function capturingLogger() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim() !== '') lines.push(line);
      }
      callback();
    },
  });

  return { logger: createLogger({ level: 'warn' }, sink), lines };
}

describe('quietCallbackAnswer', () => {
  it('обрыв ответа на нажатие не поднимается: обработчик идёт дальше', async () => {
    const transform = quietCallbackAnswer();

    await expect(
      transform(
        () => Promise.reject(connectionReset('answerCallbackQuery')),
        'answerCallbackQuery',
        { callback_query_id: '1' },
        undefined,
      ),
    ).resolves.toEqual({ ok: true, result: true });
  });

  it('отказ Telegram на ответ («query is too old») тоже не поднимается', async () => {
    const transform = quietCallbackAnswer();

    await expect(
      transform(
        () =>
          Promise.resolve(
            refused(
              'Bad Request: query is too old and response timeout expired or query ID is invalid',
            ),
          ) as never,
        'answerCallbackQuery',
        { callback_query_id: '1' },
        undefined,
      ),
    ).resolves.toEqual({ ok: true, result: true });
  });

  it('сбой назван в журнале предупреждением, без токена', async () => {
    const { logger, lines } = capturingLogger();
    const transform = quietCallbackAnswer({ logger });

    await transform(
      () => Promise.reject(connectionReset('answerCallbackQuery')),
      'answerCallbackQuery',
      { callback_query_id: '1' },
      undefined,
    );

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? '{}') as { level?: number };
    expect(record.level).toBe(40);
    expect(lines[0]).toContain('answerCallbackQuery');
    expect(lines[0]).not.toContain(TOKEN);
  });

  it('удачный ответ проходит как есть и журнал не трогает', async () => {
    const { logger, lines } = capturingLogger();
    const transform = quietCallbackAnswer({ logger });

    await expect(
      transform(() => Promise.resolve({ ok: true, result: true }) as never, 'answerCallbackQuery', {
        callback_query_id: '1',
      }),
    ).resolves.toEqual({ ok: true, result: true });
    expect(lines).toEqual([]);
  });

  describe('чего глушить нельзя', () => {
    it('обрыв отправки реплики поднимается как раньше', async () => {
      /**
       * Реплика — это то, что человек должен увидеть. Проглотить её сбой
       * значит спрятать тишину, о которой потом никто не узнает.
       */
      const transform = quietCallbackAnswer();

      await expect(
        transform(() => Promise.reject(connectionReset('sendMessage')), 'sendMessage', {
          chat_id: 1,
          text: 'вопрос',
        }),
      ).rejects.toBeInstanceOf(HttpError);
    });

    it('отказ Telegram на другой вызов проходит наружу нетронутым', async () => {
      const transform = quietCallbackAnswer();
      const answer = refused('Bad Request: message to edit not found');

      await expect(
        transform(() => Promise.resolve(answer) as never, 'editMessageText', {
          chat_id: 1,
          message_id: 2,
          text: 'x',
        }),
      ).resolves.toBe(answer);
    });

    it('брошенный отказ другого вызова тоже', async () => {
      const transform = quietCallbackAnswer();
      const error = new GrammyError(
        `Call to 'sendMessage' failed!`,
        refused('Forbidden: bot was blocked by the user'),
        'sendMessage',
        {},
      );

      await expect(
        transform(() => Promise.reject(error), 'sendMessage', { chat_id: 1, text: 'x' }),
      ).rejects.toBe(error);
    });
  });
});
