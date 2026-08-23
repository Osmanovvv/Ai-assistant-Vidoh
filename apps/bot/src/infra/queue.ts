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

export function createQueue(connection: Redis): Queue<PipelineJob> {
  return new Queue<PipelineJob>(PIPELINE_QUEUE, {
    connection: connection as unknown as ConnectionOptions,
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
  concurrency = 5,
): Worker<PipelineJob> {
  return new Worker<PipelineJob>(PIPELINE_QUEUE, processor, {
    connection: connection as unknown as ConnectionOptions,
    concurrency,
  });
}

/** Идентификатор задания закрытия. Один на выгрузку, чтобы их не плодилось. */
export function closeJobId(batchId: string): string {
  return `close:${batchId}`;
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
