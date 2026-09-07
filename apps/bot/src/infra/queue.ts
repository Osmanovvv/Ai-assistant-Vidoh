import { Queue, Worker, type ConnectionOptions, type Job, type Processor } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * Очереди (задача 1.11).
 *
 * Одна очередь на весь конвейер. Разбиение по пользователям обеспечивается
 * не очередью, а замком: BullMQ умеет группировать задания по ключу только
 * в платной версии, а порядок нам нужен.
 */

export const PIPELINE_QUEUE = 'pipeline';

export type PipelineJob =
  /** Закрыть выгрузку по тишине. Ставится с задержкой и переставляется. */
  | { readonly kind: 'close-batch'; readonly batchId: string; readonly userId: string }
  /** Обработать накопившиеся выгрузки пользователя. */
  | { readonly kind: 'process-user'; readonly userId: string };

/** Префикс ключей. Нужен тестам, чтобы не топтаться по рабочей очереди. */
export interface QueueOptions {
  readonly prefix?: string | undefined;
}

export function createQueue(connection: Redis, options: QueueOptions = {}): Queue<PipelineJob> {
  return new Queue<PipelineJob>(PIPELINE_QUEUE, {
    connection: connection as unknown as ConnectionOptions,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    defaultJobOptions: {
      // История нужна для разбора инцидентов, но не бесконечная.
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
      attempts: 5,
      backoff: { type: 'exponential', delay: 1_000 },
    },
  });
}

export function createWorker(
  connection: Redis,
  processor: Processor<PipelineJob>,
  options: QueueOptions & { readonly concurrency?: number } = {},
): Worker<PipelineJob> {
  return new Worker<PipelineJob>(PIPELINE_QUEUE, processor, {
    connection: connection as unknown as ConnectionOptions,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    concurrency: options.concurrency ?? 5,
  });
}

/**
 * Идентификатор задания закрытия. Один на выгрузку, чтобы их не плодилось.
 *
 * Разделитель — дефис, а не двоеточие. BullMQ строит из идентификатора
 * ключ Redis, где двоеточие разделяет части ключа, и на своём двоеточии
 * внутри идентификатора падает с «Custom Id cannot contain :». Проверка
 * ниже в тестах не косметическая: с двоеточием бот падал на первом же
 * входящем сообщении — так и обнаружилось, на боевом сервере.
 */
export function closeJobId(batchId: string): string {
  return `close-${batchId}`;
}

/**
 * Ставит или переставляет закрытие выгрузки по тишине.
 *
 * Каждое новое сообщение отодвигает срок. Задание живёт в Redis, а не
 * таймером в памяти процесса: перезапуск сервиса не должен оставлять
 * выгрузку открытой навсегда (§9.1 правило 4 ТЗ).
 */
export async function scheduleBatchClose(
  queue: Queue<PipelineJob>,
  params: { readonly batchId: string; readonly userId: string; readonly delayMs: number },
): Promise<void> {
  const jobId = closeJobId(params.batchId);

  const existing = await queue.getJob(jobId);
  if (existing) {
    // Задание могло уже начать выполняться — тогда удалить его нельзя,
    // и это не страшно: closeBatchOnSilence проверит время последнего
    // сообщения и откажется закрывать выгрузку, в которую только что дописали.
    await existing.remove().catch(() => undefined);
  }

  await queue.add(
    'close-batch',
    { kind: 'close-batch', batchId: params.batchId, userId: params.userId },
    { jobId, delay: params.delayMs },
  );
}

export async function enqueueUserProcessing(
  queue: Queue<PipelineJob>,
  userId: string,
  delayMs = 0,
): Promise<Job<PipelineJob>> {
  return await queue.add('process-user', { kind: 'process-user', userId }, { delay: delayMs });
}

/**
 * Очередь рассылки (§15 ТЗ, задача 4.10) — **отдельная**, и это требование
 * плана, а не вкусовщина.
 *
 * Рассылка идёт минутами и занимает воркер целиком. В общей очереди она
 * съела бы места у разбора: человек сказал мысль и ждал бы, пока
 * кончится рассылка на тысячу адресов. Отдельная очередь со своим
 * воркером и своей одновременностью разводит их насовсем.
 *
 * **Одновременность здесь единица, и это тоже не мелочь.** Два воркера
 * на одной рассылке — это два сообщения одному человеку и удвоенная
 * частота обращений к Telegram, то есть 429 при верно заданном темпе.
 */
export const BROADCAST_QUEUE = 'broadcast';

export interface BroadcastJob {
  readonly kind: 'send';
  readonly broadcastId: string;
}

export function createBroadcastQueue(
  connection: Redis,
  options: QueueOptions = {},
): Queue<BroadcastJob> {
  return new Queue<BroadcastJob>(BROADCAST_QUEUE, {
    connection: connection as unknown as ConnectionOptions,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    defaultJobOptions: {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
      /**
       * Повторов три, а не пять.
       *
       * Задание рассылки безопасно повторять: отправленное помечено, и
       * повтор берёт только оставшееся. Но если оно падает трижды,
       * причина не в связи — и лучше показать это в панели, чем молча
       * долбить Telegram.
       */
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
    },
  });
}

export function createBroadcastWorker(
  connection: Redis,
  processor: Processor<BroadcastJob>,
  options: QueueOptions = {},
): Worker<BroadcastJob> {
  return new Worker<BroadcastJob>(BROADCAST_QUEUE, processor, {
    connection: connection as unknown as ConnectionOptions,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    // Одна рассылка за раз: см. пояснение выше.
    concurrency: 1,
  });
}

/**
 * Поставить или продолжить рассылку.
 *
 * **Без своего идентификатора задания, и это не упущение.** Своим он
 * был: казалось разумным, чтобы две нажатые кнопки не дали двух
 * заданий. Но заход рассылки ставит себя снова, когда порция кончилась,
 * — а старое задание в этот момент ещё выполняется, и BullMQ на
 * повторный идентификатор молча отвечает «такое уже есть». Рассылка
 * встала бы на второй сотне навсегда.
 *
 * От двух заданий защищает база, а не очередь: запустить можно только
 * черновик (`startBroadcast`), а лишнее задание безвредно —
 * одновременность воркера единица, и второй заход просто не найдёт
 * неотправленных.
 */
export async function enqueueBroadcast(
  queue: Queue<BroadcastJob>,
  broadcastId: string,
  delayMs = 0,
): Promise<void> {
  await queue.add('send', { kind: 'send', broadcastId }, { delay: delayMs });
}
