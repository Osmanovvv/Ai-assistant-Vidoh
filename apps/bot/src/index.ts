import type { Server } from 'node:http';

import { ALLOWED_UPDATES, createBot } from './bot/bot.js';
import { createWebhookHandler } from './bot/webhook.js';
import { WEBHOOK_PATH, getEnv, webhookUrl } from './config/env.js';
import { closeDb, getDb, pingDb } from './infra/db.js';
import { createLogger } from './infra/logger.js';
import { closeRedis, getRedis, pingRedis } from './infra/redis.js';
import { createServer } from './http/server.js';

/** Точка входа (задачи 1.6 и 1.7). */

const env = getEnv();
const logger = createLogger({
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV === 'development',
});

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  await Promise.all([pingDb(getDb()), pingRedis(getRedis())]);
  logger.info('Postgres и Redis отвечают');

  const bot = createBot(env.BOT_TOKEN);

  // init() до приёма апдейтов: без botInfo часть фильтров grammY врёт.
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

  if (env.BOT_SET_WEBHOOK_ON_BOOT) {
    await bot.api.setWebhook(webhookUrl(env), {
      secret_token: env.BOT_WEBHOOK_SECRET,
      // Накопившиеся апдейты не выбрасываем: §9 ТЗ запрещает терять сообщения.
      drop_pending_updates: false,
      allowed_updates: [...ALLOWED_UPDATES],
    });
    logger.info({ webhookUrl: webhookUrl(env) }, 'Вебхук зарегистрирован');
  }

  const app = createServer({
    healthChecks: [
      { name: 'postgres', check: () => pingDb(getDb()) },
      { name: 'redis', check: () => pingRedis(getRedis()) },
    ],
    webhookPath: WEBHOOK_PATH,
    webhookHandler: createWebhookHandler(bot, env.BOT_WEBHOOK_SECRET),
  });

  const server: Server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'HTTP-сервер слушает');
  });

  installShutdownHandlers(server);
}

function installShutdownHandlers(server: Server): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Останавливаюсь');

    // Страховка на случай зависших соединений: процесс обязан завершиться.
    const forceExit = setTimeout(() => {
      logger.warn('Штатная остановка не уложилась в срок, выхожу принудительно');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    server.close(() => {
      void Promise.allSettled([closeDb(), closeRedis()]).then(() => {
        clearTimeout(forceExit);
        process.exit(0);
      });
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
