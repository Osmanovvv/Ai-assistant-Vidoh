import type { Server } from 'node:http';

import type { Worker } from 'bullmq';

import { ALLOWED_UPDATES, createBot } from './bot/bot.js';
import { incomingMiddleware } from './bot/handlers/incoming.js';
import { registerStartHandlers } from './bot/handlers/start.js';
import { createWebhookHandler } from './bot/webhook.js';
import { WEBHOOK_PATH, getEnv, productionWarnings, webhookUrl } from './config/env.js';
import { closeDb, getDb, pingDb } from './infra/db.js';
import { RedisLock } from './infra/lock.js';
import { createLogger, withRequestId } from './infra/logger.js';
import {
  createQueue,
  createWorker,
  enqueueUserProcessing,
  type PipelineJob,
} from './infra/queue.js';
import { closeRedis, createRedis, getRedis, pingRedis } from './infra/redis.js';
import { createServer } from './http/server.js';
import { DEFAULT_LIMITS, closeBatchOnSilence } from './modules/buffer/buffer.service.js';
import { processUserBatches } from './modules/pipeline/pipeline.service.js';

/** Точка входа. */

const env = getEnv();
const logger = createLogger({
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV === 'development',
});

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  if (env.NODE_ENV === 'production') {
    for (const warning of productionWarnings(env)) {
      logger.error({ warning }, 'Небоевая настройка в боевом окружении');
    }
  }

  const db = getDb();
  await Promise.all([pingDb(db), pingRedis(getRedis())]);
  logger.info('Postgres и Redis отвечают');

  // BullMQ держит блокирующие соединения, поэтому у очереди и воркера
  // свои клиенты: общий с приложением они бы заняли надолго.
  const queueConnection = createRedis(env.REDIS_URL);
  const workerConnection = createRedis(env.REDIS_URL);
  const queue = createQueue(queueConnection);
  const lock = new RedisLock(getRedis());

  const worker = createWorker(workerConnection, async (job) => {
    const data: PipelineJob = job.data;

    if (data.kind === 'close-batch') {
      const closed = await closeBatchOnSilence(db, data.batchId, {
        silenceWindowMs: DEFAULT_LIMITS.silenceWindowMs,
      });
      // Не закрылась — значит человек дописал, и стоит новое задание.
      if (closed) {
        await enqueueUserProcessing(queue, data.userId);
      }
      return;
    }

    const result = await processUserBatches({ db, lock }, data.userId);
    if (result.skipped) {
      // Замок занят: работу доделает тот воркер, который его держит.
      logger.debug({ userId: data.userId }, 'Пользователь уже обрабатывается');
    }
  });

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, err: error }, 'Задание не выполнено');
  });

  const bot = createBot(env.BOT_TOKEN);
  await bot.init();
  logger.info(
    {
      username: bot.botInfo.username,
      // §8 ТЗ целиком зависит от этого флага: если режим тем выключен
      // в @BotFather, бот работает в плоском режиме, и это видно в логе.
      hasTopicsEnabled: bot.botInfo.has_topics_enabled,
      allowsUsersToCreateTopics: bot.botInfo.allows_users_to_create_topics,
    },
    'Бот инициализирован',
  );

  // Порядок важен: приём и сохранение идут до любых обработчиков.
  bot.use(incomingMiddleware({ db, queue }));
  registerStartHandlers(bot, env.PRIVACY_POLICY_URL);

  bot.catch(({ error }) => {
    logger.error({ err: error }, 'Ошибка в обработчике апдейта');
  });

  if (env.BOT_SET_WEBHOOK_ON_BOOT) {
    await bot.api.setWebhook(webhookUrl(env), {
      secret_token: env.BOT_WEBHOOK_SECRET,
      // §9 ТЗ запрещает терять сообщения, в том числе накопившиеся.
      drop_pending_updates: false,
      allowed_updates: [...ALLOWED_UPDATES],
    });
    logger.info({ webhookUrl: webhookUrl(env) }, 'Вебхук зарегистрирован');
  }

  const rawWebhook = createWebhookHandler(bot, env.BOT_WEBHOOK_SECRET);

  const app = createServer({
    healthChecks: [
      { name: 'postgres', check: () => pingDb(db) },
      { name: 'redis', check: () => pingRedis(getRedis()) },
    ],
    webhookPath: WEBHOOK_PATH,
    // Сквозной идентификатор запроса на весь конвейер обработки (§18 ТЗ).
    webhookHandler: (req, res, next) => {
      withRequestId(() => {
        rawWebhook(req, res, next);
      });
    },
  });

  const server: Server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'HTTP-сервер слушает');
  });

  installShutdownHandlers(server, worker);
}

function installShutdownHandlers(server: Server, worker: Worker<PipelineJob>): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Останавливаюсь');

    const forceExit = setTimeout(() => {
      logger.warn('Штатная остановка не уложилась в срок, выхожу принудительно');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    server.close(() => {
      void (async () => {
        // Воркер закрывается первым и дорабатывает текущее задание:
        // выгрузка не должна остаться в статусе processing.
        await worker.close().catch(() => undefined);
        await Promise.allSettled([closeDb(), closeRedis()]);
        clearTimeout(forceExit);
        process.exit(0);
      })();
    });
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

try {
  await main();
} catch (error) {
  logger.fatal({ err: error }, 'Не удалось запуститься');
  process.exit(1);
}
