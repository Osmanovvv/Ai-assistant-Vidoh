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
import { showStatus, type StatusSender } from '../../modules/presenter/status.service.js';
import { recordConsentIfAbsent } from '../../modules/users/users.repo.js';
import { textProfileOf } from '../../modules/users/settings.repo.js';
import { textsFor } from '../../texts/index.js';

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
  /**
   * Отправитель статусного сообщения (задача 1.17). Без него бот молча
   * копит выгрузку и ничего не отвечает — так и было, пока модуль
   * существовал, но не был подключён.
   */
  readonly sender?: StatusSender | undefined;
  /**
   * Приём ответа словами (задача 3.61).
   *
   * Возвращает `true` — сообщение было ответом на вопрос бота, в буфер
   * выгрузки оно не идёт и разбором не становится.
   *
   * **Стоит перед буфером и потому обязано быть дешёвым.** Пока бот
   * ничего не ждёт, это один запрос в базу и `false`; ни одной догадки о
   * содержимом сообщения здесь не делается. Не задан — приём работает
   * ровно так, как до задачи.
   */
  readonly consume?: ((ctx: Context, userId: string) => Promise<boolean>) | undefined;
}

/**
 * Команда — это управление ботом, а не мысль.
 *
 * Признак берётся из служебной разметки Telegram, а не из первого символа
 * текста: человек может начать мысль со слэша, и это будет мысль.
 */
function isCommand(ctx: Context): boolean {
  const entities = ctx.message?.entities;
  return entities?.some((entity) => entity.type === 'bot_command' && entity.offset === 0) ?? false;
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

    // Команда сохранена — она нужна для журнала и дедупликации, — но
    // дальше буфера не идёт. Иначе бот отвечает «Слушаю.» на
    // /delete_my_data, открывает под неё выгрузку и потом зачитывает
    // эту команду обратно как расшифровку. Так и было видно в чате.
    //
    // Согласием команда тоже не считается: §16 ТЗ говорит о первом
    // сообщении после экрана с политикой, а не о нажатии кнопки меню.
    if (isCommand(ctx)) {
      await next();
      return;
    }

    // §16 ТЗ: согласие — это первое сообщение после экрана с ссылкой
    // на политику.
    await recordConsentIfAbsent(deps.db, outcome.userId);

    /**
     * Ответ на вопрос бота словами — до буфера (задача 3.61).
     *
     * Раньше ограничения частоты: человек, упёршийся в потолок выгрузок,
     * всё равно вправе назвать своё имя или время напоминания. И раньше
     * буфера: иначе ответ стал бы выгрузкой, а это ровно то, из-за чего
     * опрос был целиком на кнопках.
     *
     * Сообщение при этом уже сохранено — инвариант §9.1 «сначала
     * сохраняем» не нарушен, оно просто не привязывается к выгрузке.
     */
    if (deps.consume && (await deps.consume(ctx, outcome.userId))) return;

    // §10.5 ТЗ: ограничение частоты. Сообщение уже сохранено — мы просто
    // не заводим по нему разбор, а не выбрасываем текст.
    if (await isOverDumpLimit(deps.db, outcome.userId, { limits })) {
      // Профиль спрашивается только там, где реплика действительно
      // уходит: это горячий путь, и лишний запрос на каждое сообщение
      // ради текста, который отправляется редко, не нужен.
      const texts = textsFor(await textProfileOf(deps.db, outcome.userId));
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

    // §10.2 ТЗ: приём подтверждается сразу, не дожидаясь разбора.
    // §9.2 ТЗ: пока идёт ожидание тишины, бот молчит — поэтому реплика
    // одна на выгрузку, а не на каждое сообщение. Ставится после
    // постановки заданий: медленный Telegram не должен задерживать
    // конвейер, а сбой отправки не должен мешать разбору.
    const chatId = ctx.chat?.id;
    if (deps.sender && chatId !== undefined && attached.messageCount === 1) {
      const texts = textsFor(await textProfileOf(deps.db, outcome.userId));

      await showStatus(
        { db: deps.db, sender: deps.sender },
        {
          batchId: attached.batchId,
          chatId,
          threadId: ctx.message?.message_thread_id,
        },
        texts.listening.acknowledged,
      );
    }

    await next();
  };
}
