import type { Server } from 'node:http';

import type { Worker } from 'bullmq';
import type { Api } from 'grammy';

import { createBot } from './bot/bot.js';
import { publishCommands } from './bot/commands.js';
import { incomingMiddleware } from './bot/handlers/incoming.js';
import { registerMembershipHandlers } from './bot/handlers/membership.js';
import { registerCardHandlers } from './bot/handlers/card.js';
import { MENU_ACTION, registerMenuHandlers } from './bot/handlers/menu.js';
import { registerOnboardingHandlers } from './bot/handlers/onboarding.js';
import { registerPrivacyHandlers } from './bot/handlers/privacy.js';
import { registerQuestionHandlers } from './bot/handlers/question.js';
import { registerReminderHandlers } from './bot/handlers/reminder.js';
import { registerReturningHandlers } from './bot/handlers/returning.js';
import { registerSuggestHandlers } from './bot/handlers/suggest.js';
import { registerUndoHandlers } from './bot/handlers/undo.js';
import { registerStartHandlers } from './bot/handlers/start.js';
import { registerWebhook } from './bot/register-webhook.js';
import { createWebhookHandler } from './bot/webhook.js';
import { WEBHOOK_PATH, getEnv, productionWarnings } from './config/env.js';
import { closeDb, getDb, pingDb } from './infra/db.js';
import { RedisLock } from './infra/lock.js';
import { createLogger, withRequestId } from './infra/logger.js';
import { Monitor, formatAlert, type AlertSink } from './infra/monitoring.js';
import {
  createQueue,
  createWorker,
  enqueueUserProcessing,
  type PipelineJob,
} from './infra/queue.js';
import { closeRedis, createRedis, getRedis, pingRedis } from './infra/redis.js';
import { createServer } from './http/server.js';
import { DEFAULT_LIMITS, closeBatchOnSilence } from './modules/buffer/buffer.service.js';
import { modelsWithoutPrice } from './modules/metering/pricing.js';
import { createQuestionSender, createTelegramSender } from './modules/presenter/telegram-sender.js';
import { startScheduler } from './modules/scheduler/scheduler.service.js';
import { processUserBatches } from './modules/pipeline/pipeline.service.js';
import { recoverStuckBatches } from './modules/pipeline/recovery.js';
import { startRecoverySweep } from './modules/pipeline/sweeper.js';
import { createDumpHandler } from './modules/pipeline/dump.handler.js';
import { createFailureReporter } from './modules/pipeline/failure-notice.js';
import { limitFromEnv } from './modules/metering/limits.js';
import { downloadTelegramFile } from './modules/speech/audio.service.js';
import { createSpeechProvider } from './modules/speech/providers/factory.js';
import { PromptRegistry } from './modules/ai/prompts/registry.js';
import { createLlmProvider } from './modules/ai/providers/factory.js';
import { createEmbeddingProvider } from './modules/embedder/providers/factory.js';
import { createTopicGateway } from './modules/topics/gateway.js';

/** Точка входа. */

const env = getEnv();
const logger = createLogger({
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV === 'development',
});

const SHUTDOWN_TIMEOUT_MS = 15_000;

/** Оповещения в Telegram, если задан чат; иначе только в лог (§18 ТЗ). */
function createAlertSink(api: Api, chatId: number | undefined): AlertSink {
  if (chatId === undefined) {
    logger.warn('MONITORING_CHAT_ID не задан: оповещения будут только в логе');
    return {
      deliver: (alert) => {
        logger.error({ alert }, 'Оповещение мониторинга');
        return Promise.resolve();
      },
    };
  }

  return {
    deliver: async (alert) => {
      logger.error({ alert }, 'Оповещение мониторинга');
      try {
        await api.sendMessage(chatId, formatAlert(alert));
      } catch (error) {
        // Недоступный чат мониторинга не должен ронять обработку.
        logger.error({ err: error }, 'Не удалось доставить оповещение');
      }
    },
  };
}

async function main(): Promise<void> {
  if (env.NODE_ENV === 'production') {
    for (const warning of productionWarnings(env)) {
      logger.error({ warning }, 'Небоевая настройка в боевом окружении');
    }
  }

  const db = getDb();
  await Promise.all([pingDb(db), pingRedis(getRedis())]);
  logger.info('Postgres и Redis отвечают');

  // TELEGRAM_API_ROOT задаётся только сквозным тестом (2.23); в бою
  // конфигурация его запрещает.
  const bot = createBot(env.BOT_TOKEN, { apiRoot: env.TELEGRAM_API_ROOT });
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

  // §16 ТЗ: выгрузка и удаление данных должны быть доступны, а не спрятаны
  // за командой, которую надо знать наизусть. Отказ не мешает работе:
  // меню — удобство, приём сообщений — суть.
  try {
    await publishCommands(bot.api);
    logger.info('Меню команд опубликовано');
  } catch (error) {
    logger.error({ err: error }, 'Не удалось опубликовать меню команд');
  }

  const monitor = new Monitor({ sink: createAlertSink(bot.api, env.MONITORING_CHAT_ID) });

  const speech = createSpeechProvider(env);
  logger.info({ provider: speech.name }, 'Провайдер расшифровки выбран');

  // Полная модель разбирает смысл, лёгкая различает намерения (§7.1):
  // семь видов намерения проще, чем понять мысль, и полная модель здесь
  // дороже без выигрыша.
  const llm = createLlmProvider(env);
  const llmLight = createLlmProvider(env, { light: true });
  const embedder = createEmbeddingProvider(env);
  logger.info(
    { llm: llm.name, light: llmLight.name, embedder: embedder.name },
    'Провайдеры разбора выбраны',
  );

  // Один реестр промптов на процесс: он кэширует активные версии, и
  // отдельный на каждую выгрузку сводил бы кэш к нулю.
  const prompts = new PromptRegistry(db);

  // §10.5 ТЗ: себестоимость выгрузки должна быть посчитана. Модель без
  // цены в прайс-листе даёт null вместо суммы, и узнать об этом лучше
  // при старте, а не из отчёта через месяц.
  const unpriced = modelsWithoutPrice([speech.name]);
  if (unpriced.length > 0) {
    logger.warn({ models: unpriced }, 'Цена модели неизвестна: расход будет считаться неполным');
  }

  // Один отправитель на оба конца разговора: подтверждение приёма шлёт
  // обработчик входящих, результат — конвейер, но правят они одно и то
  // же сообщение (§9.2 и §10.2 ТЗ).
  const sender = createTelegramSender({ api: bot.api, db, logger });

  /**
   * §17: о сорвавшемся разборе человек обязан узнать. До 28.08.2026
   * выгрузка умирала молча — текст в словаре был, а звать его было
   * некому.
   */
  const onFailure = createFailureReporter({ db, sender, logger });

  // Вопросы онбординга живут своей репликой с кнопками, поэтому у них свой
  // отправитель: статусное сообщение правится по ходу разбора, и
  // клавиатура на нём мигала бы (§12.2, задача 2.13).
  const questions = createQuestionSender({ api: bot.api, db, logger });

  // Ветки личного чата. Проба 0.3 подтвердила, что в ЛС это работает;
  // если режим тем выключен в @BotFather, шлюз честно об этом скажет, и
  // продукт перейдёт в плоский режим §8.2.
  const topicGateway = createTopicGateway(bot.api);

  const handleBatch = createDumpHandler({
    speech: {
      provider: speech,
      download: (fileId, destPath) => downloadTelegramFile(bot.api, fileId, destPath),
      language: env.SPEECH_LANGUAGE,
      logger,
    },
    // Один реестр промптов на процесс: он кэширует активные версии, и
    // отдельный на каждую выгрузку сводил бы кэш к нулю.
    ai: { provider: llm, prompts, logger },
    aiLight: { provider: llmLight, prompts, logger },
    // §10.5: мягкий лимит расхода. Не задан — ограничение выключено.
    spendLimit: limitFromEnv(env.SPEND_LIMIT_RUB),
    // §3.8в: выключено, пока порог «это одно и то же дело» не измерен на
    // живых данных тестовой группы.
    suggestRecurrence: env.RECURRENCE_SUGGESTIONS,
    embedder,
    logger,
    sender,
    onboarding: questions,
    topics: topicGateway,
  });

  // BullMQ держит блокирующие соединения, поэтому у очереди и воркера
  // свои клиенты: общий с приложением они бы заняли надолго.
  const queueConnection = createRedis(env.REDIS_URL);
  const workerConnection = createRedis(env.REDIS_URL);

  // Без своего обработчика ioredis печатает «Unhandled error event»
  // мимо структурного лога, и обрыв связи теряется среди прочего вывода.
  for (const [name, connection] of [
    ['app', getRedis()],
    ['queue', queueConnection],
    ['worker', workerConnection],
  ] as const) {
    connection.on('error', (error: unknown) => {
      logger.warn({ err: error, connection: name }, 'Обрыв связи с Redis');
    });
  }
  const queue = createQueue(queueConnection);
  const lock = new RedisLock(getRedis());

  // §9.1 правило 4 ТЗ: незавершённая обработка возобновляется, а не теряется.
  const recovery = await recoverStuckBatches(db);
  if (recovery.userIds.length > 0) {
    logger.warn(
      {
        requeued: recovery.requeuedProcessing,
        closedOrphaned: recovery.closedOrphanedOpen,
        users: recovery.userIds.length,
      },
      'Подхватываю незавершённые выгрузки после перезапуска',
    );
    for (const userId of recovery.userIds) {
      await enqueueUserProcessing(queue, userId);
    }
  }

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

    const result = await processUserBatches({ db, lock, handleBatch, onFailure }, data.userId);
    if (result.skipped) {
      logger.debug({ userId: data.userId }, 'Пользователь уже обрабатывается');
    }
  });

  // Последний рубеж на случай, если задание в очереди потерялось.
  // Перезапуск Redis на боевом сервере показал, что воркер BullMQ после
  // него отложенные задания больше не разбирает: выгрузка остаётся
  // открытой навсегда, человек получает «Слушаю.» и тишину.

  const stopSweep = startRecoverySweep({
    db,
    logger,
    process: (userId) => processUserBatches({ db, lock, handleBatch, onFailure }, userId),
  });

  worker.on('completed', () => {
    void monitor.recordOutcome(true);
  });
  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, err: error }, 'Задание не выполнено');
    void monitor.recordOutcome(false);
  });

  // Порядок важен: приём и сохранение идут до любых обработчиков.
  bot.use(incomingMiddleware({ db, queue, sender }));
  registerStartHandlers(bot, {
    db,
    logger,
    privacyPolicyUrl: env.PRIVACY_POLICY_URL,
    onboarding: questions,
  });
  registerPrivacyHandlers(bot, { db, logger, topics: topicGateway });
  registerMembershipHandlers(bot, db, logger);
  registerOnboardingHandlers(bot, db, logger, topicGateway);
  registerMenuHandlers(bot, db, logger);
  registerCardHandlers(bot, { db, logger, topics: topicGateway }, MENU_ACTION.root);

  // §7.3: откат любого автоматического решения — за один тап, и
  // уточняющий вопрос с двумя кнопками. Резолвер к конвейеру ещё не
  // подключён (это 3.6 и далее), но кнопки обязаны работать в тот же
  // день, когда появится первая ревизия: иначе изменение окажется
  // необратимым, а вопрос — без ответа.
  registerUndoHandlers(bot, { db, logger, topics: topicGateway });
  registerSuggestHandlers(bot, db, logger);
  registerReminderHandlers(bot, db, logger);
  registerReturningHandlers(bot, db, logger);
  registerQuestionHandlers(bot, { db, ai: { db, provider: llm, prompts, logger }, logger });

  bot.catch(({ error }) => {
    logger.error({ err: error }, 'Ошибка в обработчике апдейта');
    void monitor.recordOutcome(false);
  });

  if (env.BOT_SET_WEBHOOK_ON_BOOT) {
    const url = await registerWebhook(bot.api, env);
    logger.info(
      { webhookUrl: url, selfSigned: env.WEBHOOK_CERTIFICATE_PATH !== undefined },
      'Вебхук зарегистрирован',
    );
  }

  const rawWebhook = createWebhookHandler(bot, env.BOT_WEBHOOK_SECRET);

  const app = createServer({
    healthChecks: [
      { name: 'postgres', check: () => pingDb(db) },
      { name: 'redis', check: () => pingRedis(getRedis()) },
    ],
    webhookPath: WEBHOOK_PATH,
    // Сквозной идентификатор запроса на весь конвейер обработки (§18 ТЗ).
    //
    // Промис возвращается наружу намеренно: express пятой версии сам
    // отправляет отказ в обработчик ошибок. Если его проглотить, отказ
    // становится необработанным и роняет процесс — так и было.
    webhookHandler: (req, res, next) => withRequestId(() => rawWebhook(req, res, next)),
    onError: (error) => {
      logger.error({ err: error }, 'Сбой обработки апдейта');
      void monitor.recordOutcome(false);
    },
  });

  const server: Server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'HTTP-сервер слушает');
  });

  /**
   * Планировщик напоминаний (§11 ТЗ, задачи 3.14–3.17).
   *
   * Живёт в том же процессе, что и бот, и это осознанно: отдельный
   * процесс потребовал бы второго деплоя, второго health-check и второго
   * места, где что-то может тихо не подняться. Дубли при двух живых
   * экземплярах — во время выкладки они бывают — исключает ключ задания,
   * а не единственность процесса.
   */
  const stopScheduler = env.REMINDERS
    ? startScheduler({
        db,
        sender: questions,
        logger,
        suggestRecurrence: env.RECURRENCE_SUGGESTIONS,
      })
    : () => undefined;

  if (!env.REMINDERS) logger.warn('Напоминания выключены переменной REMINDERS');

  installShutdownHandlers(server, worker, () => {
    stopSweep();
    stopScheduler();
  });
}

function installShutdownHandlers(
  server: Server,
  worker: Worker<PipelineJob>,
  stopSweep: () => void,
): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Останавливаюсь');
    stopSweep();

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
