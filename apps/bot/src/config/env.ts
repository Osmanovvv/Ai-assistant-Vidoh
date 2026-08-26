import { z } from 'zod';

import { LOG_LEVELS } from '../infra/logger.js';

/**
 * Конфигурация окружения (задача 1.3).
 *
 * Разделение на чистый `parseEnv` и кэширующий `getEnv` сделано намеренно:
 * модуль не выполняет побочных действий при импорте, поэтому его можно
 * импортировать в тестах, не подставляя предварительно process.env.
 */

/** Telegram принимает вебхук только по HTTPS с валидным сертификатом. */
const httpsUrl = z
  .string()
  .min(1, 'обязательное значение')
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'должен быть корректным адресом со схемой https');

/**
 * Булево значение из переменной окружения. Переменные всегда строки,
 * поэтому «false» без преобразования означало бы true.
 */
const booleanFromEnv = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((value) => (value === undefined ? fallback : value === 'true' || value === '1'));

/**
 * Адрес базы — отдельной схемой, по той же причине, по которой отдельно
 * живут настройки моделей: пулу соединений не нужен ни токен бота, ни
 * адрес вебхука. Служебный скрипт — заливка промптов, прогон стенда —
 * обязан подниматься с одной переменной, а не с конфигурацией всего бота.
 *
 * **Поймано на первом прогоне стенда:** команда из рантбука падала на
 * `PUBLIC_URL`, которого у неё и не должно быть. В бою этого не видно —
 * там у контейнера есть всё окружение сразу.
 */
const databaseUrl = z.string().min(1).startsWith('postgres', 'должен начинаться с postgres://');

export const dbEnvSchema = z.object({ DATABASE_URL: databaseUrl });

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  // Список уровней берётся из логгера, чтобы конфигурация и логгер
  // не разошлись при добавлении уровня.
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  PUBLIC_URL: httpsUrl,

  /** Формат токена @BotFather: идентификатор бота, двоеточие, секрет. */
  BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{30,}$/, 'не похож на токен от @BotFather'),

  /**
   * Секрет вебхука. Telegram присылает его в заголовке
   * X-Telegram-Bot-Api-Secret-Token и допускает только A-Z, a-z, 0-9, _ и -.
   * Нижняя граница длины — наша, чтобы секрет нельзя было подобрать.
   */
  BOT_WEBHOOK_SECRET: z
    .string()
    .min(16, 'не короче 16 символов')
    .max(256, 'не длиннее 256 символов')
    .regex(/^[A-Za-z0-9_-]+$/, 'допустимы только латиница, цифры, дефис и подчёркивание'),

  BOT_SET_WEBHOOK_ON_BOOT: booleanFromEnv(true),

  /**
   * Открытая часть самоподписанного сертификата. Задаётся, когда вебхук
   * стоит на голом IP: домена нет, Let's Encrypt на адрес сертификат не
   * выдаёт, а Telegram допускает свой — если прислать его при регистрации.
   */
  WEBHOOK_CERTIFICATE_PATH: z.string().min(1).optional(),

  /**
   * §16 ТЗ: согласие на обработку данных показывается при первом запуске
   * одним экраном со ссылкой. Переменная обязательная намеренно — иначе
   * про политику вспомнят на приёмке, а не при выкладке.
   */
  PRIVACY_POLICY_URL: httpsUrl,

  /**
   * §18 ТЗ: чат для оповещений об ошибках и недоступности сервисов.
   * Необязателен: без него мониторинг только пишет в лог, и это видно
   * при старте. С ним оповещения приходят в Telegram.
   */
  MONITORING_CHAT_ID: z.coerce.number().int().optional(),

  /**
   * Мягкий лимит расхода на пользователя за расчётный период, в рублях
   * (§10.5 ТЗ, задача 2.22).
   *
   * По плану значение — 30% от цены месячной подписки, но цена появится
   * на четвёртом этапе, поэтому пока абсолютная сумма. На четвёртом
   * этапе переедет в админку и станет считаться от цены.
   *
   * Не задан — ограничение выключено, и это законное состояние: пока
   * прайс-лист пуст, расход всё равно неизвестен, и лимит работать не
   * может. При включении он честно скажет об этом в журнал.
   */
  SPEND_LIMIT_RUB: z.coerce.number().positive().optional(),

  DATABASE_URL: databaseUrl,
  REDIS_URL: z.string().min(1).startsWith('redis', 'должен начинаться с redis://'),
});

/**
 * Настройки внешних моделей — распознавания речи и языковой (задачи 1.15
 * и 2.3). Отдельной схемой, а не частью общей: провайдеру не нужны ни
 * токен бота, ни адрес базы, а служебному скрипту проверки не нужно
 * поднимать конфигурацию всего бота целиком.
 *
 * Ключ и каталог Yandex общие для речи и языковой модели: это один
 * сервисный аккаунт с обеими областями действия. Дублировать их двумя
 * парами переменных значило бы однажды поменять одну и забыть другую.
 */
const modelFields = z.object({
  /**
   * По умолчанию заглушка, а не живой провайдер: разработку и тесты
   * нельзя ставить в зависимость от чужого ключа и чужого счёта.
   * В бою заглушка запрещена — см. проверку ниже.
   */
  SPEECH_PROVIDER: z.enum(['yandex', 'openai', 'mock']).default('mock'),

  /** Язык распознавания. Приводится к коду провайдера внутри провайдера. */
  SPEECH_LANGUAGE: z.string().min(2).max(10).default('ru'),

  YANDEX_API_KEY: z.string().min(1).optional(),
  /** Каталог Yandex Cloud. Понадобится языковым моделям на этапе 2. */
  YANDEX_FOLDER_ID: z.string().min(1).optional(),
  YANDEX_SPEECH_MODEL: z.string().min(1).default('general'),

  OPENAI_API_KEY: z.string().min(1).optional(),
  /** Адрес, если запросы идут не напрямую, а через посредника. */
  OPENAI_BASE_URL: z.string().min(1).optional(),
  OPENAI_SPEECH_MODEL: z.string().min(1).default('whisper-1'),

  /**
   * Задача 2.3: провайдер языковой модели. По умолчанию заглушка —
   * разработку и тесты нельзя ставить в зависимость от чужого счёта.
   * В бою заглушка запрещена: бот отвечал бы на выдуманный разбор.
   */
  AI_PROVIDER: z.enum(['yandex', 'mock']).default('mock'),
  YANDEX_LLM_MODEL: z.string().min(1).default('yandexgpt/latest'),

  /**
   * Лёгкая модель. Ею работает маршрутизатор намерений (§7.1, задача 2.4):
   * там надо не понять смысл, а различить семь видов намерения, и полная
   * модель для этого дороже без выигрыша.
   *
   * На задаче 2.22 на неё же переключаются остальные этапы при превышении
   * мягкого лимита расхода.
   */
  YANDEX_LLM_MODEL_LIGHT: z.string().min(1).default('yandexgpt-lite/latest'),
});

export type ModelEnv = z.infer<typeof modelFields>;

/** Какой ключ обязателен для какого провайдера расшифровки. */
const SPEECH_KEYS = {
  yandex: 'YANDEX_API_KEY',
  openai: 'OPENAI_API_KEY',
} as const;

/**
 * Ключи обязательны, но какие именно — зависит от выбранных провайдеров.
 * В схеме поля это не выразить, поэтому отдельной проверкой.
 */
function checkModelKeys(env: ModelEnv, ctx: z.RefinementCtx): void {
  if (env.SPEECH_PROVIDER !== 'mock') {
    const required = SPEECH_KEYS[env.SPEECH_PROVIDER];
    if (env[required] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [required],
        message: `обязателен при SPEECH_PROVIDER=${env.SPEECH_PROVIDER}`,
      });
    }
  }

  if (env.AI_PROVIDER === 'yandex') {
    if (env.YANDEX_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['YANDEX_API_KEY'],
        message: 'обязателен при AI_PROVIDER=yandex',
      });
    }
    // Каталог языковой модели нужен обязательно: из него собирается
    // modelUri. Распознаванию речи он не нужен, поэтому проверка здесь.
    if (env.YANDEX_FOLDER_ID === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['YANDEX_FOLDER_ID'],
        message: 'обязателен при AI_PROVIDER=yandex: из него собирается modelUri',
      });
    }
  }
}

export const modelEnvSchema = modelFields.superRefine(checkModelKeys);

const envSchemaWithModels = envSchema.extend(modelFields.shape);

/** Проверки, затрагивающие несколько переменных сразу. */
const envWithChecks = envSchemaWithModels.superRefine((env, ctx) => {
  checkModelKeys(env, ctx);

  if (env.NODE_ENV !== 'production') return;

  // Заглушка в бою — это бот, который отвечает на выдуманный разбор и
  // молчит об этом. Такое лучше не запускать вовсе.
  if (env.SPEECH_PROVIDER === 'mock') {
    ctx.addIssue({
      code: 'custom',
      path: ['SPEECH_PROVIDER'],
      message: 'заглушка расшифровки недопустима в боевом окружении',
    });
  }
  if (env.AI_PROVIDER === 'mock') {
    ctx.addIssue({
      code: 'custom',
      path: ['AI_PROVIDER'],
      message: 'заглушка языковой модели недопустима в боевом окружении',
    });
  }
});

export type Env = z.infer<typeof envSchemaWithModels>;

/** Ошибка конфигурации со списком всех проблем сразу, а не первой попавшейся. */
export class EnvValidationError extends Error {
  public readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Некорректная конфигурация окружения:\n${issues.map((i) => `  ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/** Чистый разбор: ничего не читает из глобального состояния и не завершает процесс. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = envWithChecks.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return `${path === '' ? '(корень)' : path}: ${issue.message}`;
    });
    throw new EnvValidationError(issues);
  }

  return parsed.data;
}

let cached: Env | undefined;

/**
 * Конфигурация процесса. Разбирается один раз при первом обращении:
 * переменные окружения за время работы не меняются, а повторный разбор
 * означал бы, что часть кода видит одну конфигурацию, а часть другую.
 */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Сброс кэша. Нужен только тестам. */
export function resetEnvCache(): void {
  cached = undefined;
}

/** Путь вебхука. Вынесен сюда, чтобы регистрация и обработчик не разошлись. */
export const WEBHOOK_PATH = '/telegram/webhook';

export function webhookUrl(env: Env): string {
  return new URL(WEBHOOK_PATH, env.PUBLIC_URL).toString();
}

/** Адреса-заглушки из .env.example, которые нельзя тащить в бой. */
const PLACEHOLDER_HOSTS = new Set(['example.invalid', 'example.com']);

/**
 * Настройки, с которыми нельзя запускаться в бою. Возвращает список
 * проблем, а не бросает: на этапе разработки они допустимы.
 */
export function productionWarnings(env: Env): readonly string[] {
  const warnings: string[] = [];

  for (const [name, value] of [
    ['PUBLIC_URL', env.PUBLIC_URL],
    ['PRIVACY_POLICY_URL', env.PRIVACY_POLICY_URL],
  ] as const) {
    if (PLACEHOLDER_HOSTS.has(new URL(value).hostname)) {
      warnings.push(`${name} указывает на заглушку из .env.example`);
    }
  }

  return warnings;
}
