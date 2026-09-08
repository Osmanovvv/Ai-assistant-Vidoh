import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Server } from 'node:http';

import type { Worker } from 'bullmq';
import type { Api } from 'grammy';

import { createBot } from './bot/bot.js';
import { flushCassette } from './modules/ai/cassette/session.js';
import { publishCommands } from './bot/commands.js';
import { consumeAwaited } from './bot/handlers/awaiting.js';
import { incomingMiddleware } from './bot/handlers/incoming.js';
import { registerMembershipHandlers } from './bot/handlers/membership.js';
import { adminConfigFrom } from './http/admin/index.js';
import { createEvalRunner } from './modules/admin/eval-run.js';
import {
  finishBroadcast,
  runningBroadcasts,
  settleStopRequests,
} from './modules/broadcast/broadcast.repo.js';
import { sendChunk, type BroadcastSender } from './modules/broadcast/broadcast.service.js';
import { newestRun } from './eval/freshness.js';
import { createPromoConsumer, registerBillingHandlers } from './bot/handlers/billing.js';
import { createBillingRouter } from './http/billing.js';
import { createRobokassaProvider } from './modules/billing/providers/robokassa.js';
import { createStarsProvider } from './modules/billing/providers/stars.js';
import { startRenewals } from './modules/billing/renewal.service.js';
import { createPaymentNotifier } from './modules/billing/notify.js';
import type { PaymentProvider } from './modules/billing/provider.js';
import type { Rail } from './modules/billing/tariffs.js';
import { registerCardHandlers } from './bot/handlers/card.js';
import { effectiveLimits, SettingsRegistry } from './modules/settings/settings.repo.js';
import { runCloseBatchJob } from './modules/pipeline/close-job.js';
import { registerProjectHandlers } from './bot/handlers/project.js';
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
import { isOwnOutage } from './infra/errors.js';
import { Monitor, formatAlert, type AlertSink } from './infra/monitoring.js';
import {
  createBroadcastQueue,
  createBroadcastWorker,
  createQueue,
  createWorker,
  enqueueBroadcast,
  enqueueUserProcessing,
  scheduleBatchClose,
  type BroadcastJob,
  type PipelineJob,
} from './infra/queue.js';
import { closeRedis, createRedis, getRedis, pingRedis } from './infra/redis.js';
import { createServer } from './http/server.js';
import { DEFAULT_LIMITS } from './modules/buffer/buffer.service.js';
import { modelsWithoutPrice } from './modules/metering/pricing.js';
import { createQuestionSender, createTelegramSender } from './modules/presenter/telegram-sender.js';
import { startScheduler } from './modules/scheduler/scheduler.service.js';
import { processUserBatches } from './modules/pipeline/pipeline.service.js';
import { recoverStuckBatches } from './modules/pipeline/recovery.js';
import { startRecoverySweep } from './modules/pipeline/sweeper.js';
import { createDumpHandler } from './modules/pipeline/dump.handler.js';
import { createFailureReporter } from './modules/pipeline/failure-notice.js';
import { ceilingFromEnv, rublesOf } from './modules/metering/account-spend.js';
import { limitFromEnv } from './modules/metering/limits.js';
import { createSpendGuard } from './modules/metering/spend-guard.js';
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
  ...(env.LOG_FILE === undefined ? {} : { file: env.LOG_FILE }),
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

  /**
   * Страж расхода — один на процесс (задача 3.79).
   *
   * Один, потому что у него свой счёт между чтениями базы и своя память
   * о том, о чём уже предупредил: два стража предупредили бы дважды и
   * считали бы каждый своё.
   *
   * Потолки не заданы — страж пустой и на горячем пути не делает ничего.
   */
  const spendGuard = createSpendGuard({
    db,
    ceilings: {
      ...(ceilingFromEnv(env.ACCOUNT_SPEND_CEILING_RUB) === undefined
        ? {}
        : { total: ceilingFromEnv(env.ACCOUNT_SPEND_CEILING_RUB) }),
      ...(ceilingFromEnv(env.ACCOUNT_SPEND_DAILY_RUB) === undefined
        ? {}
        : { daily: ceilingFromEnv(env.ACCOUNT_SPEND_DAILY_RUB) }),
    },
    warnShare: env.ACCOUNT_SPEND_WARN_SHARE,
    logger,
    /**
     * Оповещение сразу, а не по доле ошибок.
     *
     * Доля считается по окну не меньше десяти наблюдений, а разборов у
     * бота один-два в час: о том, что деньги кончаются, мониторинг
     * молчал бы сутками (тот же довод, что в 3.72).
     */
    /**
     * Сломавшийся страж тоже слышен (находка встречной проверки).
     *
     * Мёртвый страж и страж под потолком снаружи выглядят одинаково:
     * тихо. Ровно так и потеряли деньги 05.09.2026.
     */
    onBroken: (window, error) => {
      void monitor.alert({
        key: `spend-broken-${window}`,
        title: 'Страж расхода не может прочитать расход — счёт без присмотра',
        details: {
          окно: window === 'day' ? 'сутки' : 'всё время',
          причина: error instanceof Error ? error.message.slice(0, 200) : String(error),
        },
      });
    },
    onWarn: (notice) => {
      void monitor.alert({
        key: `spend-${notice.window}-${notice.exceeded ? 'over' : 'warn'}`,
        title: notice.exceeded
          ? 'Потолок расхода перейдён — обращения к модели остановлены'
          : 'Расход подходит к потолку',
        details: {
          окно: notice.window === 'day' ? 'сутки' : 'всё время',
          потрачено: `${rublesOf(notice.verdict.spentMicros)} ₽`,
          потолок: `${rublesOf(notice.verdict.ceilingMicros)} ₽`,
        },
      });
    },
  });
  logger.info(
    { llm: llm.name, light: llmLight.name, embedder: embedder.name },
    'Провайдеры разбора выбраны',
  );

  // Один реестр промптов на процесс: он кэширует активные версии, и
  // отдельный на каждую выгрузку сводил бы кэш к нулю.
  const prompts = new PromptRegistry(db);

  /**
   * Системные значения продукта (§14, §15; задача 4.3).
   *
   * Один реестр на процесс по той же причине, что и у промптов: размер
   * пробного периода спрашивается на каждом входящем сообщении, и
   * отдельный реестр свёл бы кэш к нулю.
   */
  const settings = new SettingsRegistry({ db, logger });

  /**
   * Рельсы оплаты (§14 ТЗ, задача 4.2).
   *
   * **Паритет — правило платформы, а не наше предпочтение.** Правила
   * Telegram требуют: если цифровую услугу можно купить снаружи, та же
   * услуга обязана продаваться и за звёзды. Санкция названа прямо — бота
   * делают недоступным из магазинных версий Telegram либо отключают от
   * платформы. Поэтому включённая Робокасса при выключенных звёздах —
   * не «неполная настройка», а нарушение, и старт говорит об этом вслух.
   *
   * Робокасса требует всех трёх значений сразу: логин без пароля даёт
   * подпись, которую она отвергнет на каждом платеже.
   */
  const rkLogin = env.RK_MERCHANT_LOGIN;
  const rkFirst = env.RK_PASSWORD1;
  const rkSecond = env.RK_PASSWORD2;

  const robokassaDeps =
    rkLogin !== undefined && rkFirst !== undefined && rkSecond !== undefined
      ? {
          merchantLogin: rkLogin,
          password1: rkFirst,
          password2: rkSecond,
          algo: env.RK_HASH_ALGO,
          isTest: env.RK_IS_TEST,
          recurringApproved: env.RK_RECURRING,
          logger,
        }
      : undefined;

  const providers: Partial<Record<Rail, PaymentProvider>> = {
    ...(robokassaDeps === undefined
      ? {}
      : { 'robokassa:smz': createRobokassaProvider(robokassaDeps) }),
    ...(env.STARS ? { 'telegram:stars': createStarsProvider({ api: bot.api, logger }) } : {}),
  };

  if (robokassaDeps !== undefined && !env.STARS) {
    logger.error(
      'Робокасса включена, а звёзды выключены: правила Telegram требуют паритета. ' +
        'Так бота отключают от платёжной платформы.',
    );
  }

  if (robokassaDeps === undefined) {
    logger.info('Робокасса выключена: не заданы RK_* — это нормально до согласования магазина');
  } else if (!env.RK_RECURRING) {
    logger.warn(
      'Дочерние списания Робокассы не согласованы (RK_RECURRING=off): ' +
        'бот честно продаёт разовый платёж и не обещает продления',
    );
  }

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
      spendGuard,
    },
    // Один реестр промптов на процесс: он кэширует активные версии, и
    // отдельный на каждую выгрузку сводил бы кэш к нулю.
    ai: { provider: llm, prompts, logger, spendGuard },
    aiLight: { provider: llmLight, prompts, logger, spendGuard },
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
    /**
     * §15 и §19: предел пробного периода — чтобы момент его конца знал,
     * при каком числе он случился (задача 4.4).
     *
     * Забудь эту строку — и третий шаг воронки навсегда останется
     * пустым при зелёных тестах. Ровно тот класс отказа, что уже был:
     * «написано, покрыто тестами и недостижимо». За связку следит
     * страж `dump.wiring.test.ts`.
     */
    settings,
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
      /**
       * Решение живёт в `close-job.ts`, а не здесь.
       *
       * Воркер поднимается вместе с ботом, очередью и Redis, и проверку
       * на него не написать. Ровно поэтому здесь и жил дефект ревизии
       * четвёртого этапа: окно ожидания тишины бралось константой из
       * кода, хотя задание ставилось значением из панели.
       */
      await runCloseBatchJob(
        {
          db,
          settings,
          reschedule: async (again) => {
            await scheduleBatchClose(queue, again);
          },
          process: async (userId) => {
            await enqueueUserProcessing(queue, userId);
          },
        },
        { batchId: data.batchId, userId: data.userId },
      );

      return;
    }

    const result = await processUserBatches({ db, lock, handleBatch, onFailure }, data.userId);
    if (result.skipped) {
      logger.debug({ userId: data.userId }, 'Пользователь уже обрабатывается');
    }
  });

  /**
   * Рассылка (§15, задача 4.10) — **отдельная очередь и отдельный
   * воркер**, как требует план.
   *
   * Рассылка идёт минутами и занимает воркер целиком. В общей очереди
   * она съела бы места у разбора: человек сказал мысль и ждал бы,
   * пока кончится рассылка на тысячу адресов.
   *
   * Заход отправляет порцию и ставит себя снова, если осталось.
   * Задержка между заходами нулевая: темп выдерживается внутри, а
   * пауза здесь только удлиняла бы рассылку без причины.
   */
  const broadcastQueue = createBroadcastQueue(queueConnection);

  const broadcastSender: BroadcastSender = {
    send: async ({ tgId, text }) => {
      await bot.api.sendMessage(tgId, text);
    },
  };

  const broadcastWorker = createBroadcastWorker(workerConnection, async (job) => {
    const step = await sendChunk(
      {
        db,
        sender: broadcastSender,
        logger,
        perSecond: await settings.number('broadcastPerSecond'),
      },
      job.data.broadcastId,
    );

    logger.info({ broadcastId: job.data.broadcastId, ...step }, 'Порция рассылки отправлена');

    // Задержка — там, где остались только взятые строки: раньше срока
    // взятия их не перезахватить, и заход вернул бы пустую порцию.
    if (step.more) {
      await enqueueBroadcast(broadcastQueue, job.data.broadcastId, step.afterMs ?? 0);
    }
  });

  broadcastWorker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, err: error }, 'Заход рассылки не удался');

    /**
     * **Исчерпавшая попытки рассылка перестаёт числиться идущей.**
     *
     * Найдено ревизией четвёртого этапа: статус `failed` не ставил никто
     * — ни одной строкой кода, — и рассылка, чьё задание сгорело за три
     * попытки, вечно показывалась в панели как «идёт». Остановить её
     * нельзя (нечего останавливать), продолжить нельзя (не остановлена),
     * повторить неудачные нельзя (неудачных нет). Словарь панели слово
     * «сорвалась» держал, а получить его было нечем.
     *
     * Различаем последнюю попытку от промежуточной: после первой из трёх
     * задание вернётся само, и объявлять рассылку сорвавшейся рано.
     */
    const attempts = job?.opts.attempts ?? 1;
    const made = job?.attemptsMade ?? 0;
    const broadcastId = job?.data.broadcastId;

    if (broadcastId === undefined || made < attempts) return;

    void finishBroadcast(db, broadcastId, 'failed').then(
      () => {
        logger.error({ broadcastId }, 'Рассылка объявлена сорвавшейся: попытки исчерпаны');
      },
      (problem: unknown) => {
        logger.error({ err: problem, broadcastId }, 'Не удалось отметить рассылку сорвавшейся');
      },
    );
  });

  /**
   * Просьба остановиться исполняется при старте (ревизия этапа 4).
   *
   * Метку ставит панель, исполняет воркер. Умри воркер между ними —
   * выкладка посреди рассылки штатное дело, — и рассылка остаётся
   * «идущей» с непустой меткой: подхват её пропускает, «Остановить»
   * заблокировано, «Продолжить» не показывается. Панель показывала
   * «останавливаю» навсегда.
   */
  const settled = await settleStopRequests(db);

  if (settled.length > 0) {
    logger.warn(
      { broadcasts: settled.length },
      'Рассылки с непрочитанной просьбой остановиться объявлены остановленными',
    );
  }

  /**
   * Рассылка, застрявшая на перезапуске, продолжается сама.
   *
   * Выкладка посреди рассылки убивает воркер, а задание из BullMQ
   * уходит вместе с ним. Без этого рассылка вставала бы навсегда в
   * состоянии «идёт», и половина людей не получила бы письма — молча.
   */
  for (const running of await runningBroadcasts(db)) {
    logger.warn({ broadcastId: running }, 'Продолжаю рассылку, прерванную перезапуском');
    await enqueueBroadcast(broadcastQueue, running);
  }

  // Последний рубеж на случай, если задание в очереди потерялось.
  // Перезапуск Redis на боевом сервере показал, что воркер BullMQ после
  // него отложенные задания больше не разбирает: выгрузка остаётся
  // открытой навсегда, человек получает «Слушаю.» и тишину.

  const stopSweep = startRecoverySweep({
    db,
    logger,
    // Окно — получателем: правка из панели действует без перезапуска.
    limits: async () => await effectiveLimits(settings, DEFAULT_LIMITS),
    process: (userId) => processUserBatches({ db, lock, handleBatch, onFailure }, userId),
  });

  worker.on('completed', () => {
    void monitor.recordOutcome(true);
  });
  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, err: error }, 'Задание не выполнено');
    void monitor.recordOutcome(false);

    /**
     * Отказ в доступе оповещает сразу, минуя долю ошибок (задача 3.72).
     *
     * Доля считается по окну не меньше десяти наблюдений — правило верное
     * для шума, но для отказа в доступе бесполезное: у бота один-два
     * разбора в час, десять наблюдений не набираются никогда, и о том,
     * что бот не разбирает вообще ничего, мы узнали бы от заказчика.
     *
     * Отказ в доступе шумом не бывает. Одного достаточно; дребезг
     * гасится общим правилом молчания по ключу.
     */
    if (isOwnOutage(error)) {
      void monitor.alert({
        key: 'access-denied',
        title: 'Модель недоступна — бот не разбирает выгрузки',
        details: { причина: error.message.slice(0, 200) },
      });
    }
  });

  /**
   * Оплата регистрируется **до** приёма входящего.
   *
   * Служебное сообщение об оплате звёздами приходит тем же потоком, что
   * и голосовые: не перехвати мы его здесь, оно поехало бы в буфер
   * выгрузки и разбиралось бы моделью как мысль человека. А
   * `pre_checkout_query` ждать нельзя вовсе — на него надо ответить за
   * десять секунд, иначе платёж не состоится.
   */
  registerBillingHandlers(bot, { db, settings, logger, providers });

  // Порядок важен: приём и сохранение идут до любых обработчиков.
  bot.use(
    incomingMiddleware({
      db,
      queue,
      sender,
      // §14: конец пробного периода приглашает оплатить — но только там,
      // где оплата действительно есть (4.2).
      payRails: Object.keys(providers) as Rail[],
      // Ответ словами на вопрос опроса и правка записи из карточки
      // (задача 3.61). Ждёт бот чего-то или нет — решает база.
      consume: consumeAwaited({
        db,
        logger,
        /**
         * §14: промокод словами (задача 4.4).
         *
         * Приёмом ответа, а не командой: команда идёт мимо гейта и мимо
         * потолка частоты, то есть даёт бесплатный неограниченный
         * перебор кодов, а публикация в списке команд объявляет о
         * скидках всем.
         */
        promo: createPromoConsumer({ db, settings, logger, providers }),
      }),
      // §14: размер пробного периода задаётся без выкладки (4.3).
      settings,
    }),
  );
  registerStartHandlers(bot, {
    db,
    logger,
    privacyPolicyUrl: env.PRIVACY_POLICY_URL,
    onboarding: questions,
  });
  registerPrivacyHandlers(bot, {
    db,
    logger,
    topics: topicGateway,
    /**
     * §16 и §14: продление отменяется до удаления данных.
     *
     * Ключ отмены уходит каскадом вместе с человеком. Забудь эту
     * строку — и звёздная подписка будет списываться после «всё
     * удалено», а остановить её не сможет никто.
     */
    providers,
  });
  registerMembershipHandlers(bot, db, logger);
  registerOnboardingHandlers(bot, db, logger, topicGateway, settings);
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
  // §21 п.6: закрыть шаг проекта. До задачи 3.82 это было нельзя ничем,
  // и «Сделано» в ответе о проекте оставалось пустым навсегда.
  registerProjectHandlers(bot, db, logger);
  registerReturningHandlers(bot, db, logger);
  registerQuestionHandlers(bot, {
    db,
    ai: { db, provider: llm, prompts, logger, spendGuard },
    logger,
  });

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

  /**
   * Админ-панель (§15, задача 4.5). Нет настроек — нет панели.
   *
   * Не «панель без пароля»: она показывает содержимое чужих выгрузок, и
   * забытая строка в `.env` не должна открывать их всему интернету.
   */
  const admin = adminConfigFrom(env);

  if (admin === undefined) {
    logger.info('Админ-панель выключена: не заданы ADMIN_* — это нормально до её настройки');
  }

  /**
   * Где лежит собранная панель.
   *
   * Путь от собранного кода бота: `apps/bot/dist/index.js` →
   * `apps/admin/dist`. Так он совпадает и в образе, и при запуске из
   * дерева после сборки. Нет папки — панель отдаст только API, и это
   * честнее, чем отдавать «не найдено» на её страницу: API как раз то,
   * что уже работает.
   */
  const adminDist =
    env.ADMIN_DIST ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../admin/dist');

  /**
   * Контрольный набор для раздела промптов (§10.3, задача 4.8).
   *
   * Набор живёт в `docs/` — вне публичного репозитория. В образ он не
   * попадает, а отчёты прогонов туда кладёт `./ops/seed-prompts.sh`:
   * это одни числа, ничего личного и ничего секретного.
   *
   * **Нет отчётов — нет и раздела.** Раздел, который умеет только
   * отказывать, приучил бы жать «включить без прогона» каждый раз, и
   * заслон §10.3 остался бы на бумаге. Лучше честное отсутствие.
   */
  const evalDir =
    env.ADMIN_EVAL_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/eval');

  const evalReady = (await newestRun(evalDir)) !== undefined;

  /**
   * Кнопка прогона появляется только там, где есть **сам набор**.
   *
   * Отчёты — это числа, они на сервере есть. Набора там нет и быть не
   * должно: в нём живые расшифровки людей (§16). Кнопка, которая на
   * боевом всегда падала бы «набора нет», хуже отсутствующей — она
   * учит не верить панели.
   */
  const evalCases = evalReady
    ? (await readdir(evalDir).catch(() => [])).filter((name) => name.endsWith('.json')).length
    : 0;

  if (admin !== undefined) {
    logger.info(
      { папка: evalDir, отчёты: evalReady, случаев: evalCases },
      evalReady
        ? 'Раздел промптов в панели включён'
        : 'Раздела промптов в панели нет: отчётов прогона по этому пути не найдено',
    );
  }

  /**
   * Оповещение об оплате и о неудачном продлении.
   *
   * Один на два вызывающих: уведомление Робокассы приходит в HTTP, а
   * неудачное продление находит суточный проход. Оба знают только наш
   * `userId`, и путь до чата у них обязан быть один.
   */
  const payNotifier = createPaymentNotifier({ api: bot.api, db, logger });

  /**
   * Приём уведомлений Робокассы (§14, задача 4.2).
   *
   * Только при готовом провайдере: адрес без проверки подписи — это
   * приглашение продлить себе подписку бесплатно, а адрес, отвечающий
   * отказом на настоящее уведомление, — копилка повторных доставок.
   */
  const robokassa = providers['robokassa:smz'];

  const billingRouter =
    robokassa === undefined
      ? undefined
      : createBillingRouter({
          db,
          robokassa,
          logger,
          onPaid: (params) => payNotifier.paid(params),
        });

  const app = createServer({
    ...(admin === undefined
      ? {}
      : {
          admin,
          adminStaticDir: adminDist,
          adminDb: db,
          adminSettings: settings,
          adminPromptRegistry: prompts,
          adminEnqueueBroadcast: async (broadcastId: string) => {
            await enqueueBroadcast(broadcastQueue, broadcastId);
          },
          adminEnqueueUser: async (userId: string) => {
            await enqueueUserProcessing(queue, userId);
          },
          ...(evalReady ? { adminEvalDir: evalDir } : {}),
          ...(evalCases > 0
            ? {
                adminEvalRunner: createEvalRunner({
                  evalDir,
                  onError: (error: unknown) => {
                    logger.error({ err: error }, 'Прогон набора из панели не запустился');
                  },
                }),
              }
            : {}),
        }),
    healthChecks: [
      { name: 'postgres', check: () => pingDb(db) },
      { name: 'redis', check: () => pingRedis(getRedis()) },
    ],
    ...(billingRouter === undefined ? {} : { billingRouter }),
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

  /**
   * Продление рублёвых подписок (§14, задача 4.2).
   *
   * Только на рельсе Робокассы: у звёзд продлевает Telegram, а мы лишь
   * получаем служебное сообщение. И только при согласованных дочерних
   * списаниях: до согласования каждая попытка падает кодом 34, а бот всё
   * равно обещал бы разовый платёж — ему и обещать нечего.
   */
  const stopRenewals =
    robokassaDeps !== undefined && env.RK_RECURRING
      ? startRenewals({
          db,
          logger,
          robokassa: robokassaDeps,
          settings,
          /**
           * Провайдер — чтобы спросить исход ушедшего списания.
           *
           * «OK<номер>» означает создание операции, а не списание
           * денег. Без этого вопроса счёт, не получивший уведомления,
           * висел бы навсегда, а человек не узнал бы, что доступ
           * кончится.
           */
          ...(robokassa === undefined ? {} : { provider: robokassa }),
          onFailed: (params) => payNotifier.renewalFailed(params),
        })
      : () => undefined;

  installShutdownHandlers(server, worker, broadcastWorker, () => {
    stopSweep();
    stopScheduler();
    stopRenewals();
  });
}

function installShutdownHandlers(
  server: Server,
  worker: Worker<PipelineJob>,
  broadcastWorker: Worker<BroadcastJob>,
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
        // Рассылка встаёт вместе со всеми: отправленное помечено, и
        // следующий запуск продолжит с того же места.
        await broadcastWorker.close().catch(() => undefined);

        /**
         * Запись ответов модели сохраняется на выходе (задача 3.80).
         *
         * В конце, а не на каждый ответ: иначе двести записей файла за
         * прогон. Сохранять после закрытия воркера — чтобы в запись
         * попали и ответы последней выгрузки.
         *
         * В бою этой ветки нет: запись запрещена схемой окружения.
         */
        if (env.AI_PROVIDER === 'cassette') {
          const summary = await flushCassette().catch((error: unknown) => {
            logger.error({ err: error }, 'Запись ответов модели не сохранилась');
            return undefined;
          });

          if (summary !== undefined) logger.info({ ...summary }, 'Запись ответов модели');
        }

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
