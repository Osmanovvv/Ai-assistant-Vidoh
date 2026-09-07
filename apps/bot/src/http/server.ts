import type { Executor } from '../infra/db.js';
import type { SettingsRegistry } from '../modules/settings/settings.repo.js';
import { createAdminRouter, type AdminAuthConfig } from './admin/index.js';
import type { AiStage } from '../db/schema.js';
import type { EvalRunner } from '../modules/admin/eval-run.js';
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from 'express';

/**
 * HTTP-слой (задача 1.6).
 *
 * Зависимости передаются снаружи, а не импортируются: так сервер
 * тестируется без живых Postgres и Redis, а проверки готовности можно
 * подменить на заведомо падающие.
 */

export interface HealthCheck {
  readonly name: string;
  readonly check: () => Promise<void>;
}

export interface ServerDeps {
  /** Проверки, от которых зависит готовность принимать нагрузку. */
  readonly healthChecks: readonly HealthCheck[];
  /**
   * Админ-панель (§15, задача 4.5). Без настроек её нет вовсе.
   *
   * Отсутствие настройки означает «панели нет», а не «панель без
   * пароля»: недонастроенная панель обязана быть закрытой, иначе
   * забытая строка в `.env` открывает содержимое чужих выгрузок.
   */
  readonly admin?: AdminAuthConfig | undefined;
  /** Откуда отдавать собранную панель. Без него — только её API. */
  readonly adminStaticDir?: string | undefined;
  /** База для разделов панели. Без неё у панели есть только вход. */
  readonly adminDb?: Executor | undefined;
  /** Реестр значений: раздел настроек правит его и сбрасывает кэш (4.9). */
  readonly adminSettings?: SettingsRegistry | undefined;
  /**
   * Папка контрольного набора (§10.3, задача 4.8).
   *
   * Без неё раздела промптов в панели нет: включать версию, не умея
   * проверить, прогнан ли на ней набор, — ровно то, что §10.3 запрещает.
   */
  readonly adminEvalDir?: string | undefined;
  /** Кто запускает прогон набора по кнопке (4.8). */
  readonly adminEvalRunner?: EvalRunner | undefined;
  /** Кто ставит рассылку в очередь (§15, задача 4.10). */
  readonly adminEnqueueBroadcast?: ((broadcastId: string) => Promise<void>) | undefined;
  /** Кто ставит перезапуск сорвавшегося разбора (§17, задача 4.10). */
  readonly adminEnqueueUser?: ((userId: string) => Promise<void>) | undefined;
  /** Кэш промптов бота: включение версии сбрасывает его (§15). */
  readonly adminPromptRegistry?: { readonly forget: (stage?: AiStage) => void } | undefined;
  /**
   * Приём уведомлений об оплате (§14, задача 4.2).
   *
   * Без него рублёвый рельс не работает вовсе: Робокасса стучит на
   * ResultURL, и не ответить ей `OK` значит копить повторные доставки, а
   * не «просто не продлить». Отсутствие роутера — законное состояние
   * ровно до согласования магазина.
   */
  readonly billingRouter?: Router | undefined;
  /** Обработчик вебхука Telegram. Появляется на задаче 1.7. */
  readonly webhookPath?: string;
  readonly webhookHandler?: RequestHandler;
  /** Куда сообщать о сбое обработки. Без него ошибка уйдёт в никуда. */
  readonly onError?: (error: unknown) => void;
  /** Срок ответа одной проверки готовности. */
  readonly healthCheckTimeoutMs?: number;
}

export interface ReadinessReport {
  readonly ok: boolean;
  readonly checks: Record<string, string>;
}

/**
 * Сколько ждать одну проверку, прежде чем считать её проваленной.
 *
 * Без срока проверка готовности бесполезна ровно тогда, когда нужна.
 * Клиент ioredis при недоступном сервере не отвечает отказом, а копит
 * команды до восстановления связи, и `ping` просто не возвращается —
 * запрос к /health/ready висел пять минут вместо честного 503.
 * Проверено остановкой Redis на боевом сервере.
 */
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 2_000;

/** Тот же промис, но с обязательным сроком ответа. */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`не ответил за ${String(timeoutMs)} мс`));
    }, timeoutMs);
    // Зависшая проверка не должна удерживать процесс при остановке.
    timer.unref();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export async function runHealthChecks(
  checks: readonly HealthCheck[],
  timeoutMs: number = DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
): Promise<ReadinessReport> {
  const entries = await Promise.all(
    checks.map(async ({ name, check }): Promise<readonly [string, string]> => {
      try {
        await withDeadline(check(), timeoutMs);
        return [name, 'ok'] as const;
      } catch (error) {
        return [name, error instanceof Error ? error.message : String(error)] as const;
      }
    }),
  );

  const report: Record<string, string> = Object.fromEntries(entries);
  return { ok: entries.every(([, status]) => status === 'ok'), checks: report };
}

export function createServer(deps: ServerDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  /**
   * Один посредник впереди — Caddy, и только он.
   *
   * Нужно счётчику попыток входа в панель: он считает по адресу
   * обратившегося, а без этой строки `req.ip` у всех один и тот же —
   * адрес Caddy, — и счёт снова становится общим.
   *
   * Единица, а не `true`: `true` означает «верить всей цепочке
   * X-Forwarded-For», то есть верить и тому, что подставил в заголовок
   * сам обратившийся. Тогда адрес можно было бы назвать любым и обойти
   * счётчик. Caddy добавляет настоящий адрес сам и стоит ровно один.
   */
  app.set('trust proxy', 1);

  /** Жив ли процесс. Намеренно не трогает зависимости: используется рестартером. */
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  /** Готов ли принимать нагрузку. Проверяет зависимости и честно отвечает 503. */
  app.get('/health/ready', (_req: Request, res: Response) => {
    void runHealthChecks(deps.healthChecks, deps.healthCheckTimeoutMs).then(
      (report) => {
        res.status(report.ok ? 200 : 503).json(report);
      },
      (error: unknown) => {
        res.status(503).json({
          ok: false,
          checks: { internal: error instanceof Error ? error.message : String(error) },
        });
      },
    );
  });

  /**
   * §15: панель закрыта от индексации.
   *
   * Файл в корне, потому что поисковые роботы читают его только там —
   * путь `/admin/robots.txt` не значил бы ничего. Заголовок `X-Robots-Tag`
   * приезжает вдобавок с каждым ответом самой панели.
   */
  app.get('/robots.txt', (_req: Request, res: Response) => {
    res
      .type('text/plain')
      .send(['User-agent: *', 'Disallow: /admin', ''].join(String.fromCharCode(10)));
  });

  if (deps.admin !== undefined) {
    app.use(
      '/admin',
      createAdminRouter({
        config: deps.admin,
        ...(deps.adminStaticDir === undefined ? {} : { staticDir: deps.adminStaticDir }),
        ...(deps.adminDb === undefined ? {} : { db: deps.adminDb }),
        ...(deps.adminSettings === undefined ? {} : { settings: deps.adminSettings }),
        ...(deps.adminEvalDir === undefined ? {} : { evalDir: deps.adminEvalDir }),
        ...(deps.adminEnqueueBroadcast === undefined
          ? {}
          : { enqueueBroadcast: deps.adminEnqueueBroadcast }),
        ...(deps.adminEnqueueUser === undefined ? {} : { enqueueUser: deps.adminEnqueueUser }),
        ...(deps.adminEvalRunner === undefined ? {} : { evalRunner: deps.adminEvalRunner }),
        ...(deps.adminPromptRegistry === undefined
          ? {}
          : { promptRegistry: deps.adminPromptRegistry }),
        ...(deps.onError === undefined ? {} : { onError: deps.onError }),
      }).router,
    );
  }

  /**
   * Оплата монтируется **до** вебхука и до обработчика ошибок.
   *
   * Свой разборщик тела у неё внутри: Робокасса присылает форму, а не
   * JSON, и подключать разбор JSON на этот путь значило бы завести лишнюю
   * поверхность там, куда стучится кто угодно.
   */
  if (deps.billingRouter !== undefined) app.use(deps.billingRouter);

  if (deps.webhookPath && deps.webhookHandler) {
    // Тело апдейта разбирается только на пути вебхука: остальным ручкам
    // JSON не нужен, а лишний парсер — лишняя поверхность.
    app.use(deps.webhookPath, express.json({ limit: '1mb' }), deps.webhookHandler);
  }

  /**
   * Последний рубеж: сбой в обработке апдейта не должен ронять процесс.
   *
   * Это не перестраховка. В режиме вебхука grammY не пропускает ошибки
   * через bot.catch — тот работает только на длинных опросах. Ошибка
   * всплывает наружу, и без этого обработчика падение на одном апдейте
   * убивало весь процесс. Проверено на боевом сервере: бот перезапускался
   * на каждом входящем сообщении.
   *
   * Отвечаем 500, а не 200: Telegram повторит доставку, а апдейт у нас
   * дедуплицируется по update_id, поэтому повтор безопасен.
   */
  app.use(((error, _req, res, next) => {
    deps.onError?.(error);

    // Заголовки уже ушли — вмешиваться поздно, доводит express.
    if (res.headersSent) {
      next(error);
      return;
    }

    /**
     * Ошибка разбора запроса отвечает своим кодом, а не пятисотым.
     *
     * Разборщик тела бросает 413 на слишком большое тело и 400 на битый
     * JSON. Обе — про то, что **прислали** не то, и обе превращались тут
     * в 500: панель говорила «не удалось сохранить», а человек не мог
     * узнать, что промпт просто не влез. Пятисотый значит «сломались мы»,
     * и путать это с «прислали лишнее» — значит искать не там.
     *
     * Берётся только код и только клиентский: сообщение наружу не идёт
     * (в нём бывают наши внутренности), а пятисотые остаются пятисотыми,
     * чтобы своя поломка не выглядела чужой ошибкой.
     */
    const status = (error as { readonly status?: unknown }).status;
    const clientFault = typeof status === 'number' && status >= 400 && status < 500;

    res.status(clientFault ? status : 500).json({ ok: false });
  }) as ErrorRequestHandler);

  return app;
}
