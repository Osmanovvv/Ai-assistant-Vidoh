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

  DATABASE_URL: z.string().min(1).startsWith('postgres', 'должен начинаться с postgres://'),
  REDIS_URL: z.string().min(1).startsWith('redis', 'должен начинаться с redis://'),
});

/**
 * Настройки расшифровки (задача 1.15) — отдельной схемой, а не частью
 * общей. Провайдеру не нужны ни токен бота, ни адрес базы, а служебному
 * скрипту проверки речи не нужно поднимать конфигурацию всего бота
 * целиком: иначе для одного вызова распознавания пришлось бы заполнять
 * десяток переменных, к речи не относящихся.
 */
const speechFields = z.object({
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
});

export type SpeechEnv = z.infer<typeof speechFields>;

/** Какой ключ обязателен для какого провайдера расшифровки. */
const SPEECH_KEYS = {
  yandex: 'YANDEX_API_KEY',
  openai: 'OPENAI_API_KEY',
} as const;

/**
 * Ключ обязателен, но какой именно — зависит от выбранного провайдера.
 * В схеме поля это не выразить, поэтому отдельной проверкой.
 */
function checkSpeechKey(env: SpeechEnv, ctx: z.RefinementCtx): void {
  if (env.SPEECH_PROVIDER === 'mock') return;

  const required = SPEECH_KEYS[env.SPEECH_PROVIDER];
  if (env[required] === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: [required],
      message: `обязателен при SPEECH_PROVIDER=${env.SPEECH_PROVIDER}`,
    });
  }
}

export const speechEnvSchema = speechFields.superRefine(checkSpeechKey);

const envSchemaWithSpeech = envSchema.extend(speechFields.shape);

/** Проверки, затрагивающие несколько переменных сразу. */
const envWithChecks = envSchemaWithSpeech.superRefine((env, ctx) => {
  checkSpeechKey(env, ctx);

  // Заглушка в бою — это бот, который отвечает на выдуманные расшифровки
  // и молчит об этом. Такое лучше не запускать вовсе.
  if (env.SPEECH_PROVIDER === 'mock' && env.NODE_ENV === 'production') {
    ctx.addIssue({
      code: 'custom',
      path: ['SPEECH_PROVIDER'],
      message: 'заглушка расшифровки недопустима в боевом окружении',
    });
  }
});

export type Env = z.infer<typeof envSchemaWithSpeech>;

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
