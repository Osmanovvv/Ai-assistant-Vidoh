import type { Queue } from 'bullmq';
import type { Context, MiddlewareFn } from 'grammy';

import type { Database } from '../../infra/db.js';
import type { PipelineJob } from '../../infra/queue.js';
import { enqueueUserProcessing, scheduleBatchClose } from '../../infra/queue.js';
import {
  DEFAULT_LIMITS,
  attachMessageToBatch,
  isOverDumpLimit,
  type BufferLimits,
} from '../../modules/buffer/buffer.service.js';
import { acceptUpdate } from '../../modules/gateway/gateway.service.js';
import { recordConsentIfAbsent } from '../../modules/users/users.repo.js';
import { texts } from '../../texts/ru.js';

/**
 * Приём входящего (задачи 1.9, 1.10, 1.12).
 *
 * Порядок здесь и есть инвариант §9.1 ТЗ: сначала сохраняем, потом думаем.
 * Ни одно обращение к модели и ни одна отправка ответа не происходит
 * раньше, чем сообщение легло в базу.
 */

export interface IncomingDeps {
  readonly db: Database;
  readonly queue: Queue<PipelineJob>;
  readonly limits?: BufferLimits;
}

/** Команда, после которой согласие ещё не считается данным. */
function isStartCommand(ctx: Context): boolean {
  const text = ctx.message?.text;
  return text !== undefined && /^\/start(?:@\w+)?(?:\s|$)/u.test(text);
}

export function incomingMiddleware(deps: IncomingDeps): MiddlewareFn {
  const limits = deps.limits ?? DEFAULT_LIMITS;

  return async (ctx, next) => {
    const outcome = await acceptUpdate(deps.db, ctx.update);

    if (outcome.status === 'duplicate') {
      // Повторная доставка того же апдейта: дальше идти нельзя, иначе
      // обработчики отработают дважды.
      return;
    }

    if (outcome.status === 'ignored') {
      await next();
      return;
    }

    // §16 ТЗ: согласие — это первое сообщение после экрана с ссылкой
    // на политику, а не сам факт нажатия кнопки «Начать».
    if (!isStartCommand(ctx)) {
      await recordConsentIfAbsent(deps.db, outcome.userId);
    }

    // §10.5 ТЗ: ограничение частоты. Сообщение уже сохранено — мы просто
    // не заводим по нему разбор, а не выбрасываем текст.
    if (await isOverDumpLimit(deps.db, outcome.userId, { limits })) {
      await ctx.reply(texts.limits.tooManyDumps);
      return;
    }

    const attached = await attachMessageToBatch(deps.db, {
      userId: outcome.userId,
      messageId: outcome.messageId,
      limits,
    });

    if (attached.closed) {
      // Потолок по числу сообщений или по возрасту: обрабатываем сразу,
      // не дожидаясь тишины.
      await enqueueUserProcessing(deps.queue, outcome.userId);
    } else {
      // Каждое новое сообщение отодвигает закрытие: серия голосовых —
      // это одна мысль (§9.1 правило 2 ТЗ).
      await scheduleBatchClose(deps.queue, {
        batchId: attached.batchId,
        userId: outcome.userId,
        delayMs: limits.silenceWindowMs,
      });
    }

    await next();
  };
}
