import express, {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import type { Executor } from '../../infra/db.js';
import { aiStage, type AiStage } from '../../db/schema.js';
import type { EvalRunner } from '../../modules/admin/eval-run.js';
import { errorsView, restartBatch } from '../../modules/admin/errors.js';
import { overview, people, personCard } from '../../modules/admin/people.js';
import {
  createBroadcast,
  isSegment,
  listBroadcasts,
  recipientsOf,
  requestStop,
  resumeBroadcast,
  retryFailed,
  SEGMENTS,
  startBroadcast,
} from '../../modules/broadcast/broadcast.repo.js';
import {
  activateVersion,
  createHotfix,
  promptText,
  promptsView,
} from '../../modules/admin/prompts.js';
import {
  putSetting,
  SETTINGS,
  type SettingName,
  type SettingsRegistry,
} from '../../modules/settings/settings.repo.js';
import { costBreakdown } from '../../modules/metering/cost-breakdown.js';
import { MEASURED_STAGES, RESOLVER_STAGE } from '../../eval/freshness.js';
import { recordAccess, type Exposure } from './audit.js';
import { AUTH_ROUTES, createAuthRouter, requireAdmin, type AdminAuthConfig } from './auth.js';

export {
  adminConfigFrom,
  AUTH_ROUTES,
  cookiesOf,
  FIRST_STEP_COOKIE,
  requireAdmin,
  SESSION_COOKIE,
} from './auth.js';
export type { AdminAuthConfig, AdminIdentity } from './auth.js';
export { accessTo, recentAccess, recordAccess } from './audit.js';
export type { Exposure } from './audit.js';

/**
 * Раздел админ-панели (§15 ТЗ, задача 4.5).
 *
 * Собирает всё в одном месте нарочно: по этому файлу видно глазами, что
 * незакрытого в панели ровно три пути входа, а всё остальное стоит за
 * стражем. Порядок здесь — часть смысла: пути входа объявлены **до**
 * стража, всё объявленное ниже оказывается за ним само собой. Обратный
 * порядок означал бы, что каждый новый раздел надо не забыть закрыть.
 *
 * **Условие готовности задачи проверяется списком, который ведёт сама
 * регистрация.** «Без авторизации ни один эндпоинт админки не отдаёт
 * данные» — утверждение обо **всех** путях, и проверять его по списку,
 * набранному руками, бессмысленно: следующий добавленный путь в такой
 * список никто не впишет. Поэтому путь регистрируется только через
 * `closed`, и она же его записывает. А то, что мимо `closed` ничего не
 * проходит, следит отдельная проверка по исходникам — `admin.test.ts`.
 *
 * Введение express для этого не годится: в пятой версии у слоёв нет ни
 * `regexp`, ни заполненного `path` до первого совпадения, и путь
 * вложенного роутера оттуда не достать.
 */

export interface AdminRoute {
  readonly method: 'get' | 'post';
  /** Путь целиком, от корня панели: `/api/me`. */
  readonly path: string;
  /** Что путь показывает: персональные данные или числа (§16, 4.11). */
  readonly exposure: Exposure;
}

export interface AdminMount {
  readonly router: Router;
  /** Все закрытые пути: без пропуска отвечают отказом. */
  readonly routes: readonly AdminRoute[];
  /**
   * Пути, открытые **нарочно**, и почему это не дыра.
   *
   * Их два вида, и оба не отдают данных человека: три пути входа (иначе
   * войти нельзя) и сама страница панели — пустая оболочка, которая
   * данные запрашивает уже с пропуском. Список объявлен явно, чтобы
   * проверка могла отличить осознанное исключение от забытого стража:
   * первое здесь есть, второе — нет.
   */
  readonly openRoutes: readonly AdminRoute[];
}

export interface AdminDeps {
  readonly config: AdminAuthConfig;
  /** База: разделы панели читают из неё. Без неё есть только вход. */
  readonly db?: Executor | undefined;
  /**
   * Реестр значений (§15, задача 4.9).
   *
   * Тот же, что читает бот: панель правит его и **забывает накопленное**,
   * иначе правка ждала бы истечения кэша, и «без перезапуска» стало бы
   * «через минуту, если повезёт».
   */
  readonly settings?: SettingsRegistry | undefined;
  /**
   * Откуда отдавать собранную панель. Без него отдаётся только API.
   *
   * **Панель отдаёт бот, а не отдельный веб-сервер, и это решение.**
   * Печенье пропуска помечено `SameSite=Strict`: браузер отдаёт его
   * только на тот же адрес, откуда пришла страница. Панель, живущая на
   * другом адресе, потребовала бы либо ослабить эту защиту, либо
   * настраивать общий домен в прокси — а прокси в этом продукте нарочно
   * пускает наружу один путь (см. `ops/caddy/Caddyfile`). Один процесс,
   * один адрес, одна печенька.
   *
   * Необязателен: до сборки панели её просто нет, а API уже есть.
   */
  readonly staticDir?: string | undefined;
  /** Куда сообщать о сбое внутри раздела. Без него отказ уйдёт в никуда. */
  readonly onError?: ((error: unknown) => void) | undefined;
  /**
   * Папка контрольного набора (§10.3, задача 4.8).
   *
   * Без неё раздела промптов нет: включать версию, не умея проверить,
   * прогнан ли на ней набор, — ровно то, что §10.3 запрещает.
   */
  readonly evalDir?: string | undefined;
  /** Кто запускает прогон набора по кнопке. Без него кнопки нет. */
  readonly evalRunner?: EvalRunner | undefined;
  /**
   * Кто ставит рассылку в очередь (§15, задача 4.10).
   *
   * Без него раздела рассылки нет: составить её и не суметь
   * отправить — это кнопка, которая обманывает. Панель не знает про
   * Redis и не должна: она просит «поставить», а как — дело того, кто
   * её собрал.
   */
  readonly enqueueBroadcast?: ((broadcastId: string) => Promise<void>) | undefined;
  /**
   * Кто ставит в очередь перезапуск разбора (§17, задача 4.10).
   *
   * Без него кнопка «перезапустить» вернула бы выгрузку в очередь и
   * ничего не запустила: досмотр подобрал бы её сам, но не сразу, и
   * человек ждал бы неизвестно сколько.
   */
  readonly enqueueUser?: ((userId: string) => Promise<void>) | undefined;
  /**
   * Кэш активных промптов бота.
   *
   * §15 требует правки промпта **без выкладки**. Кэш держит активную
   * версию минуту, и без сброса «без выкладки» превращалось бы в
   * «через минуту» — а на разборе, начатом в эту минуту, ещё и в
   * «непонятно когда». Сброс делает включение мгновенным.
   */
  readonly promptRegistry?: { readonly forget: (stage?: AiStage) => void } | undefined;
}

/**
 * Число из строки запроса — с потолком и полом.
 *
 * Значения приходят снаружи: «за сколько дней» может оказаться словом,
 * отрицательным числом или десятью тысячами. Ни одно из трёх не должно
 * ни ронять панель, ни доходить до базы: запрос «за десять лет» на
 * боевой базе — это не отчёт, а остановка бота.
 */
function boundedNumber(
  raw: unknown,
  bounds: { readonly fallback: number; readonly min: number; readonly max: number },
): number {
  if (typeof raw !== 'string') return bounds.fallback;

  const digits = /^[0-9]+$/u;
  const parsed = digits.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isInteger(parsed)) return bounds.fallback;

  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

/**
 * Заголовок против индексации (§15 «панель закрыта от индексации»).
 *
 * Заголовком, а не только `robots.txt`: файл в корне — это просьба, и
 * действует он лишь для тех, кто его читает и кто вообще дошёл до
 * корня. Заголовок приезжает с каждым ответом самой панели, в том числе
 * если на неё сослались откуда-то напрямую.
 */
function noIndex(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
}

export function createAdminRouter(deps: AdminDeps): AdminMount {
  const router = Router();
  const routes: AdminRoute[] = [];
  const openRoutes: AdminRoute[] = [];

  /**
   * Объявить закрытый путь — и сказать, что он показывает.
   *
   * Единственный способ добавить в панель путь: она же записывает его в
   * список, по которому проверка убеждается, что путь закрыт. Мимо неё
   * пути не регистрируются — за этим следит проверка по исходникам.
   *
   * **Решение о персональных данных обязательно** (§16, задача 4.11).
   * Тип не даёт объявить путь, не сказав, персональные там данные или
   * числа. Забыть здесь значит либо оставить доступ без следа, либо
   * засорить журнал сводками — а §16 требует журналировать именно
   * доступ к персональным данным.
   *
   * **Запись в журнал идёт до ответа.** Не удалась — данные не
   * отдаются: незапротоколированный доступ есть нарушение §16, а не
   * мелкая неприятность. Цена названа: сбой базы делает раздел
   * недоступным. Но раздел без журнала хуже недоступного, потому что
   * выглядит работающим.
   */
  const closed = (
    method: 'get' | 'post',
    path: string,
    exposure: Exposure,
    handler: RequestHandler,
  ): void => {
    routes.push({ method, path, exposure });

    if (!exposure.personal || deps.db === undefined) {
      router[method](path, handler);
      return;
    }

    const db = deps.db;

    router[method](path, (req: Request, res: Response, next: NextFunction) => {
      const login = req.admin?.login;

      // Без пропуска сюда не попасть: страж стоит выше. Но если однажды
      // попадём, писать в журнал «неизвестно кто» бессмысленнее отказа.
      if (login === undefined) {
        res.status(401).json({ ok: false });
        return;
      }

      /**
       * Код человека из пути. Только строка: express отдаёт массив,
       * если параметр в пути повторён, а «на кого смотрели» — это один
       * человек, и записывать в журнал массив нечем.
       */
      const raw = exposure.subjects === 'one' ? req.params[exposure.param] : undefined;
      const subject = typeof raw === 'string' ? raw : undefined;

      void recordAccess(db, {
        login,
        route: path,
        ...(subject === undefined ? {} : { subjectUserId: subject }),
      }).then(
        () => {
          handler(req, res, next);
        },
        (error: unknown) => {
          deps.onError?.(error);
          res.status(503).json({ error: 'доступ не записан в журнал, данные не отданы' });
        },
      );
    });
  };

  /**
   * Объявить **открытый** путь — и тем взять на себя ответственность.
   *
   * Отдельной функцией, а не прямым вызовом роутера, ровно по той же
   * причине, что и `closed`: проверка должна видеть, что путь открыт
   * намеренно. Прямой `router.get` не видит никто.
   */
  const open = (method: 'get' | 'post', path: string, handler: RequestHandler): void => {
    openRoutes.push({
      method,
      path,
      // Открытым путь может быть только при одном условии — в нём нет
      // данных человека. Здесь это условие записано, а не подразумевается.
      exposure: { personal: false, why: 'пустая оболочка страницы, данные приходят отдельно' },
    });
    router[method](path, handler);
  };

  router.use(noIndex);

  // ── Открытая часть: только вход ───────────────────────────────────────
  router.use('/api/auth', createAuthRouter(deps.config));

  // ── Дальше — только с пропуском сессии ────────────────────────────────
  router.use('/api', requireAdmin(deps.config));

  /**
   * Разбор тела — после стража и только для API.
   *
   * После, потому что разбирать тело у того, кого мы всё равно не
   * пустим, незачем: это лишняя работа по запросу снаружи. Только для
   * API, потому что странице панели тело не нужно.
   *
   * Поймано браузерной проверкой: сохранение настройки падало пятисотым,
   * потому что разборщик стоял лишь на путях входа, и `req.body` у
   * остальных был не задан вовсе.
   *
   * **Предел 128 КБ, и он был 16 — этого не хватало.** Самый большой
   * промпт продукта весит 15,3 КБ; с экранированием JSON правка
   * `classifier@6` из панели упиралась в отказ, а панель говорила «не
   * удалось сохранить» и не объясняла, почему. Промпты только растут.
   * 128 КБ — с запасом на несколько лет и всё ещё немного: путь за
   * стражем, и слать сюда мегабайты некому.
   */
  router.use('/api', express.json({ limit: '128kb' }));

  /**
   * Кто вошёл. Первый закрытый путь, и он же нужен самой панели: по нему
   * она узнаёт, жив ли пропуск, и не показывает окно входа тому, кто уже
   * вошёл.
   */
  closed(
    'get',
    '/api/me',
    // Логин самого администратора — не данные пользователя. Писать в
    // журнал доступа к чужим данным собственный вход незачем: журнал
    // перестал бы отвечать на вопрос, ради которого ведётся.
    { personal: false, why: 'логин самого администратора, а не человека' },
    (req: Request, res: Response) => {
      res.json({ login: req.admin?.login });
    },
  );

  /**
   * Расходы (§15, §21 п.14; задача 4.7).
   *
   * Раздел появляется только при заданной базе. Условный путь — ровно
   * тот случай, который однажды проскочил мимо проверки: она собирала
   * роутер без базы и этого пути не видела. Теперь собирает со всеми
   * зависимостями, и это записано в самой проверке.
   */
  if (deps.db !== undefined) {
    const db = deps.db;

    closed(
      'get',
      '/api/costs',
      /**
       * Персональные данные, хотя раздел про деньги.
       *
       * Разрез по людям показывает имена и телеграмные номера — по ним
       * человек узнаётся, значит §16 действует. Соблазн назвать это
       * «сводкой» велик именно потому, что страница выглядит как
       * бухгалтерия; на этом соблазне журнал доступа и обходят.
       */
      { personal: true, subjects: 'many' },
      (req: Request, res: Response) => {
        const days = boundedNumber(req.query['days'], { fallback: 30, min: 1, max: 366 });
        const limit = boundedNumber(req.query['limit'], { fallback: 50, min: 1, max: 200 });
        const offset = boundedNumber(req.query['offset'], { fallback: 0, min: 0, max: 100_000 });

        const since = new Date(Date.now() - days * 24 * 3_600_000);

        void costBreakdown(db, { since, userLimit: limit, userOffset: offset }).then(
          (report) => {
            res.json({ ...report, days });
          },
          (error: unknown) => {
            deps.onError?.(error);
            // Панель обязана сказать, что не смогла, а не показать нули:
            // ноль расхода читается как «денег не тратили».
            res.status(500).json({ error: 'не удалось посчитать расход' });
          },
        );
      },
    );
  }

  if (deps.db !== undefined) {
    const db = deps.db;

    /**
     * Обзор (§15). Числа за период — людей, выгрузок, расхода.
     *
     * Не персональные данные: здесь только счёт, ни одного имени. Причина
     * записана, потому что соблазн назвать сводкой **любую** страницу с
     * числами велик, а разрез по людям в расходах именно так и выглядел.
     */
    closed(
      'get',
      '/api/overview',
      { personal: false, why: 'только счётчики за период, без имён и без слов человека' },
      (req: Request, res: Response) => {
        const days = boundedNumber(req.query['days'], { fallback: 30, min: 1, max: 366 });

        /**
         * Реестр значений передаётся, если он есть.
         *
         * От него зависит только переход из пробного в оплату: без
         * размера пробного периода посчитать его нечем, и обзор честно
         * скажет об этом строкой, а не покажет ноль.
         */
        void overview(db, days, deps.settings).then(
          (report) => {
            res.json(report);
          },
          (error: unknown) => {
            deps.onError?.(error);
            res.status(500).json({ error: 'не удалось собрать обзор' });
          },
        );
      },
    );

    /**
     * Список людей (§15): страницами и с поиском по имени.
     *
     * Персональные данные многих сразу: имена, телеграмные имена,
     * источник перехода. Каждое открытие списка — запись в журнал (§16).
     */
    closed(
      'get',
      '/api/people',
      { personal: true, subjects: 'many' },
      (req: Request, res: Response) => {
        const limit = boundedNumber(req.query['limit'], { fallback: 20, min: 1, max: 100 });
        const offset = boundedNumber(req.query['offset'], { fallback: 0, min: 0, max: 1_000_000 });
        const query = req.query['q'];

        void people(db, {
          limit,
          offset,
          ...(typeof query === 'string' ? { query } : {}),
        }).then(
          (page) => {
            res.json(page);
          },
          (error: unknown) => {
            deps.onError?.(error);
            res.status(500).json({ error: 'не удалось собрать список' });
          },
        );
      },
    );

    /**
     * Карточка человека (§15) — то, ради чего задача 4.6 существует.
     *
     * Показывает **слова человека**: расшифровки голосовых, результаты
     * разбора, правки и вопросы. Самое личное, что есть в продукте, —
     * поэтому персональные данные **одного** человека, и в журнал
     * попадает не только факт обращения, но и то, на кого смотрели.
     */
    closed(
      'get',
      '/api/people/:userId',
      { personal: true, subjects: 'one', param: 'userId' },
      (req: Request, res: Response) => {
        const userId = req.params['userId'];

        if (typeof userId !== 'string') {
          res.status(404).json({ error: 'не найдено' });
          return;
        }

        void personCard(db, { userId }).then(
          (card) => {
            if (card === undefined) {
              res.status(404).json({ error: 'не найдено' });
              return;
            }

            res.json(card);
          },
          (error: unknown) => {
            deps.onError?.(error);
            res.status(500).json({ error: 'не удалось собрать карточку' });
          },
        );
      },
    );
  }

  if (deps.settings !== undefined && deps.db !== undefined) {
    const settings = deps.settings;
    const db = deps.db;

    /**
     * Настройки (§15, задача 4.9): что можно поменять без выкладки.
     *
     * Не персональные данные: числа продукта, одни для всех.
     */
    closed(
      'get',
      '/api/settings',
      { personal: false, why: 'числа продукта, одни для всех, без имён и слов человека' },
      (_req: Request, res: Response) => {
        void settings.all().then(
          (rows) => {
            /**
             * Чего в §15 просят, а здесь нет — и почему.
             *
             * Список пуст: все семь групп значений из §15 читаются
             * настоящим кодом. Цены были последней незакрытой строкой и
             * закрылись подпиской (задача 4.2) — до неё они честно
             * назывались отсутствующими, потому что настройка, которую
             * никто не читает, хуже отсутствующей: человек меняет число,
             * видит «сохранено» и ждёт, что что-то изменится.
             *
             * Поле остаётся: следующая настройка без читателя обязана
             * объявить об этом здесь, а не молча появиться в списке.
             */
            res.json({ rows, missing: [] });
          },
          (error: unknown) => {
            deps.onError?.(error);
            res.status(500).json({ error: 'не удалось прочитать настройки' });
          },
        );
      },
    );

    /**
     * Правка значения.
     *
     * После записи реестр забывает накопленное — иначе правка ждала бы
     * истечения кэша, и «применяется без перезапуска» превращалось бы в
     * «применяется через минуту, если повезёт».
     */
    closed(
      'post',
      '/api/settings',
      { personal: false, why: 'правка чисел продукта, данных человека здесь нет' },
      (req: Request, res: Response) => {
        // Через `??`, а не прямым разбором: тело может не разобраться
        // вовсе, и падать на этом панель не должна.
        const body = (req.body ?? {}) as { name?: unknown; value?: unknown };
        const name = typeof body.name === 'string' ? body.name : '';
        const value = typeof body.value === 'string' ? body.value : '';

        if (!(name in SETTINGS)) {
          // Неизвестное имя — не «сохранили и забыли»: молчаливое
          // согласие тут означало бы настройку, которой нет.
          res.status(400).json({ error: 'нет такой настройки' });
          return;
        }

        void putSetting(db, { name: name as SettingName, value, by: req.admin?.login }).then(
          () => {
            settings.forget();
            res.json({ ok: true });
          },
          (error: unknown) => {
            deps.onError?.(error);
            res.status(500).json({ error: 'не удалось сохранить' });
          },
        );
      },
    );
  }

  if (deps.db !== undefined && deps.settings !== undefined) {
    const db = deps.db;
    const settings = deps.settings;

    /**
     * Рассылка (§15, задача 4.10).
     *
     * **Персональные данные, и это не формальность.** Ответ содержит
     * число людей в сегменте, а список — кому уже ушло. Соблазн
     * назвать это «сводкой» велик: цифры выглядят статистикой. Но
     * сегмент «у кого пробный период кончился» — это сведение о
     * конкретных людях, и §16 действует.
     */
    closed(
      'get',
      '/api/broadcast',
      { personal: true, subjects: 'many' },
      (_req: Request, res: Response) => {
        void listBroadcasts(db).then(
          (rows) => {
            res.json({ rows, segments: SEGMENTS });
          },
          (error: unknown) => {
            deps.onError?.(error);
            res.status(500).json({ error: 'не удалось прочитать рассылки' });
          },
        );
      },
    );

    /**
     * Предпросмотр: сколько получателей и что именно уйдёт.
     *
     * §15 требует предпросмотра с подтверждением. Предпросмотр ничего
     * не создаёт: человек должен иметь право посмотреть на число
     * адресатов и уйти, не оставив черновика.
     */
    closed(
      'get',
      '/api/broadcast/preview',
      { personal: true, subjects: 'many' },
      (req: Request, res: Response) => {
        const segment = req.query['segment'];

        if (!isSegment(segment)) {
          res.status(400).json({ error: 'нет такого сегмента' });
          return;
        }

        void settings
          .number('trialDumps')
          .then(async (trialLimit) => {
            const people = await recipientsOf(db, { segment, trialLimit });
            return people.length;
          })
          .then(
            (recipients) => {
              res.json({ segment, recipients, title: SEGMENTS[segment] });
            },
            (error: unknown) => {
              deps.onError?.(error);
              res.status(500).json({ error: 'не удалось посчитать получателей' });
            },
          );
      },
    );

    /** Черновик: список получателей закрепляется здесь, но не уходит. */
    closed(
      'post',
      '/api/broadcast',
      { personal: true, subjects: 'many' },
      (req: Request, res: Response) => {
        const body = (req.body ?? {}) as { text?: unknown; segment?: unknown };

        if (typeof body.text !== 'string' || !isSegment(body.segment)) {
          res.status(400).json({ error: 'нужны text и segment' });
          return;
        }

        const text = body.text;
        const segment = body.segment;

        void settings
          .number('trialDumps')
          .then(
            async (trialLimit) =>
              await createBroadcast(db, {
                text,
                segment,
                by: req.admin?.login ?? 'неизвестно',
                trialLimit,
              }),
          )
          .then(
            (made) => {
              res.json({ ok: true, id: made.id, recipients: made.recipients });
            },
            (error: unknown) => {
              deps.onError?.(error);
              res.status(400).json({ error: error instanceof Error ? error.message : 'не вышло' });
            },
          );
      },
    );

    /**
     * Подтверждение — отдельным действием, и только при воркере.
     *
     * Кнопка «отправить», за которой некому отправлять, обманывает
     * хуже отсутствующей: человек уверен, что тысяча людей получила
     * письмо.
     */
    if (deps.enqueueBroadcast !== undefined) {
      const enqueue = deps.enqueueBroadcast;

      closed(
        'post',
        '/api/broadcast/:id/start',
        { personal: true, subjects: 'many' },
        (req: Request, res: Response) => {
          const id = req.params['id'];

          if (typeof id !== 'string') {
            res.status(404).json({ error: 'не найдено' });
            return;
          }

          void startBroadcast(db, id)
            .then(async (started) => {
              if (started) await enqueue(id);
              return started;
            })
            .then(
              (started) => {
                // 409: запрос понят, но рассылка уже не черновик. Две
                // нажатые кнопки не должны дать двух воркеров.
                res
                  .status(started ? 200 : 409)
                  .json(started ? { ok: true } : { error: 'рассылка уже запущена или закончена' });
              },
              (error: unknown) => {
                deps.onError?.(error);
                res.status(500).json({ error: 'не удалось запустить' });
              },
            );
        },
      );

      /**
       * Продолжить остановленную — иначе остановка была ловушкой.
       *
       * Остановил, передумал — и продолжить нечем: пришлось бы
       * составлять новую, а она ушла бы **всем**, включая тех, кто
       * письмо уже прочёл.
       */
      closed(
        'post',
        '/api/broadcast/:id/resume',
        { personal: true, subjects: 'many' },
        (req: Request, res: Response) => {
          const id = req.params['id'];

          if (typeof id !== 'string') {
            res.status(404).json({ error: 'не найдено' });
            return;
          }

          void resumeBroadcast(db, id)
            .then(async (resumed) => {
              if (resumed) await enqueue(id);
              return resumed;
            })
            .then(
              (resumed) => {
                res
                  .status(resumed ? 200 : 409)
                  .json(resumed ? { ok: true } : { error: 'рассылка не остановлена' });
              },
              (error: unknown) => {
                deps.onError?.(error);
                res.status(500).json({ error: 'не удалось продолжить' });
              },
            );
        },
      );

      /** Повтор неудачных — «повторный запуск» из §15. */
      closed(
        'post',
        '/api/broadcast/:id/retry',
        { personal: true, subjects: 'many' },
        (req: Request, res: Response) => {
          const id = req.params['id'];

          if (typeof id !== 'string') {
            res.status(404).json({ error: 'не найдено' });
            return;
          }

          void retryFailed(db, id)
            .then(async (back) => {
              if (back > 0) await enqueue(id);
              return back;
            })
            .then(
              (back) => {
                res.json({ ok: true, back });
              },
              (error: unknown) => {
                deps.onError?.(error);
                res.status(500).json({ error: 'не удалось повторить' });
              },
            );
        },
      );
    }

    /**
     * Остановка — есть всегда, даже без воркера.
     *
     * Кнопка «остановить» обязана работать в любом состоянии панели:
     * рассылка могла быть запущена прошлой выкладкой и идти прямо
     * сейчас. Отказать здесь значило бы держать её насильно.
     */
    closed(
      'post',
      '/api/broadcast/:id/stop',
      { personal: true, subjects: 'many' },
      (req: Request, res: Response) => {
        const id = req.params['id'];

        if (typeof id !== 'string') {
          res.status(404).json({ error: 'не найдено' });
          return;
        }

        void requestStop(db, id).then(
          (asked) => {
            // Просьба, а не приказ: воркер встанет перед следующей
            // отправкой и сам поставит статус.
            res.json({ ok: true, asked, note: asked ? 'останавливаю' : 'уже не идёт' });
          },
          (error: unknown) => {
            deps.onError?.(error);
            res.status(500).json({ error: 'не удалось остановить' });
          },
        );
      },
    );

    /**
     * Журнал сбоев (§15, задача 4.10).
     *
     * Персональные: видно, у кого сорвался разбор. Текстов расшифровок
     * здесь нет нарочно — они в карточке, где доступ к ним тоже
     * журналируется.
     */
    closed(
      'get',
      '/api/errors',
      { personal: true, subjects: 'many' },
      (req: Request, res: Response) => {
        const days = boundedNumber(req.query['days'], { fallback: 7, min: 1, max: 366 });

        void errorsView(db, days).then(
          (view) => {
            res.json(view);
          },
          (error: unknown) => {
            deps.onError?.(error);
            res.status(500).json({ error: 'не удалось прочитать журнал' });
          },
        );
      },
    );

    /**
     * Перезапуск сорвавшегося разбора (§17, задача 4.10).
     *
     * То, чего не хватало: сбойные выгрузки намеренно не
     * переподхватываются, и человек не получал разбора никогда. Текст
     * извинения обещал «админку, из которой их перезапускают» — вот она.
     */
    if (deps.enqueueUser !== undefined) {
      const enqueueUser = deps.enqueueUser;

      closed(
        'post',
        '/api/errors/batch/:id/restart',
        {
          personal: true,
          subjects: 'many',
        },
        (req: Request, res: Response) => {
          const id = req.params['id'];

          if (typeof id !== 'string') {
            res.status(404).json({ error: 'не найдено' });
            return;
          }

          void restartBatch(db, id)
            .then(async (outcome) => {
              if (outcome.ok) await enqueueUser(outcome.userId);
              return outcome;
            })
            .then(
              (outcome) => {
                if (!outcome.ok) {
                  res.status(409).json({ error: outcome.why });
                  return;
                }

                res.json({ ok: true });
              },
              (error: unknown) => {
                deps.onError?.(error);
                res.status(500).json({ error: 'не удалось перезапустить' });
              },
            );
        },
      );
    }
  }

  if (deps.db !== undefined && deps.evalDir !== undefined) {
    const db = deps.db;
    const evalDir = deps.evalDir;
    const runner = deps.evalRunner;

    /**
     * Промпты (§15, задача 4.8): версии, включение, откат.
     *
     * **Не персональные данные, но самое ценное, что есть в продукте.**
     * Промпты нарочно не лежат в публичном репозитории (решение 2.1);
     * здесь они за тем же стражем, что и всё остальное. В журнал доступа
     * не пишем: §16 про данные человека, а это наше ноу-хау.
     */
    /**
     * Стадия из запроса — только та, что есть в перечислении базы.
     *
     * Иначе строка уедет в сравнение с колонкой-перечислением и
     * Postgres ответит ошибкой типа: отказ будет, но невнятный, и в
     * журнал уйдёт сбой там, где на деле просто опечатка в запросе.
     */
    const asStage = (value: unknown): AiStage | undefined =>
      typeof value === 'string' && (aiStage.enumValues as readonly string[]).includes(value)
        ? (value as AiStage)
        : undefined;

    /** Стадии, для которых набор вообще существует (общий и резолвера). */
    const MEASURABLE: readonly AiStage[] = [...MEASURED_STAGES, RESOLVER_STAGE];

    const NOT_PERSONAL = {
      personal: false,
      why: 'промпты — ноу-хау продукта, но не данные человека (§16 про них)',
    } as const;

    closed('get', '/api/prompts', NOT_PERSONAL, (_req: Request, res: Response) => {
      void promptsView(db, evalDir).then(
        (view) => {
          /**
           * `canRun` — есть ли кому прогнать набор.
           *
           * На боевом набора нет и быть не должно: в нём живые
           * расшифровки (§16). Без этого признака панель рисовала бы
           * кнопку прогона всегда, а на сервере такого пути нет — и
           * нажатие давало бы невнятный отказ вместо честного «прогон
           * идёт с машины разработчика».
           */
          res.json({
            ...view,
            run: runner?.state() ?? { kind: 'idle' },
            canRun: runner !== undefined,
          });
        },
        (error: unknown) => {
          deps.onError?.(error);
          res.status(500).json({ error: 'не удалось прочитать промпты' });
        },
      );
    });

    /** Текст одной версии — отдельным запросом, см. `prompts.ts`. */
    closed('get', '/api/prompts/text', NOT_PERSONAL, (req: Request, res: Response) => {
      const stage = asStage(req.query['stage']);
      const version = req.query['version'];

      if (stage === undefined || typeof version !== 'string') {
        res.status(400).json({ error: 'нужны stage и version' });
        return;
      }

      void promptText(db, { stage, version }).then(
        (found) => {
          if (found === undefined) {
            res.status(404).json({ error: 'нет такой версии' });
            return;
          }

          res.json(found);
        },
        (error: unknown) => {
          deps.onError?.(error);
          res.status(500).json({ error: 'не удалось прочитать версию' });
        },
      );
    });

    /** Горячая правка: новая версия, а не подмена старой (2.1). */
    closed('post', '/api/prompts/hotfix', NOT_PERSONAL, (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { stage?: unknown; basedOn?: unknown; prompt?: unknown };

      const stage = asStage(body.stage);

      if (
        stage === undefined ||
        typeof body.basedOn !== 'string' ||
        typeof body.prompt !== 'string'
      ) {
        res.status(400).json({ error: 'нужны stage, basedOn и prompt' });
        return;
      }

      void createHotfix(db, {
        stage,
        basedOn: body.basedOn,
        prompt: body.prompt,
        by: req.admin?.login ?? 'неизвестно',
      }).then(
        (made) => {
          res.json({ ok: true, version: made.version });
        },
        (error: unknown) => {
          deps.onError?.(error);
          res.status(400).json({ error: error instanceof Error ? error.message : 'не вышло' });
        },
      );
    });

    /**
     * Включение версии — с заслоном §10.3.
     *
     * Непрогнанная версия **не включается**: ответ 409 и причина. Обойти
     * можно только явным признанием (`acknowledged`), и оно запишется в
     * версию навсегда.
     */
    closed('post', '/api/prompts/activate', NOT_PERSONAL, (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        stage?: unknown;
        version?: unknown;
        acknowledged?: unknown;
      };

      const stage = asStage(body.stage);

      if (stage === undefined || typeof body.version !== 'string') {
        res.status(400).json({ error: 'нужны stage и version' });
        return;
      }

      void activateVersion(db, {
        stage,
        version: body.version,
        evalDir,
        by: req.admin?.login ?? 'неизвестно',
        acknowledged: body.acknowledged === true,
      }).then(
        (outcome) => {
          if (!outcome.ok) {
            // 409, а не 400: запрос понят и правилен, но состояние
            // продукта не позволяет его исполнить.
            res.status(409).json({ error: 'набор не прогнан', reasons: outcome.refused.reasons });
            return;
          }

          // §15: правка без выкладки. Кэш держит активную версию минуту,
          // и без сброса включение доехало бы до людей не сразу.
          deps.promptRegistry?.forget(stage);

          res.json({ ok: true, freshness: outcome.freshness });
        },
        (error: unknown) => {
          deps.onError?.(error);
          res.status(400).json({ error: error instanceof Error ? error.message : 'не вышло' });
        },
      );
    });

    /**
     * Кнопка прогона набора: один прогон за раз — он стоит денег.
     *
     * Прогон идёт **на указанной версии**, а не на активной. Иначе
     * кнопка была бы бесполезна ровно там, где нужна: горячую правку
     * не включить без прогона, а прогон активной версии про неё
     * ничего не говорит.
     */
    if (runner !== undefined) {
      closed('post', '/api/prompts/run-eval', NOT_PERSONAL, (req: Request, res: Response) => {
        const body = (req.body ?? {}) as { stage?: unknown; version?: unknown };
        const stage = asStage(body.stage);

        if (body.stage !== undefined && stage === undefined) {
          res.status(400).json({ error: 'неизвестная стадия' });
          return;
        }

        if (stage !== undefined && !MEASURABLE.includes(stage)) {
          // Набора для этой стадии нет вовсе. Запустить прогон значило
          // бы потратить деньги и не сдвинуть заслон ни на шаг.
          res.status(409).json({ error: `набор не мерит стадию «${stage}»` });
          return;
        }

        const target =
          stage === undefined || typeof body.version !== 'string'
            ? undefined
            : { stage, version: body.version };

        /**
         * Версия должна существовать — иначе прогон впустую сожжёт
         * деньги: он дойдёт до модели и упадёт только на первой
         * стадии, уже потратив на речь и разбор.
         */
        const known =
          target === undefined
            ? Promise.resolve(true)
            : promptText(db, target).then((found) => found !== undefined);

        void known.then(
          (exists) => {
            if (!exists) {
              res.status(404).json({ error: 'нет такой версии' });
              return;
            }

            const started = runner.start(target);

            res.status(started ? 200 : 409).json({
              started,
              ...(started ? {} : { error: 'прогон уже идёт' }),
              run: runner.state(),
            });
          },
          (error: unknown) => {
            deps.onError?.(error);
            res.status(500).json({ error: 'не удалось начать прогон' });
          },
        );
      });
    }
  }

  /**
   * Сама панель — файлами, и **после** API.
   *
   * После, потому что отдача файлов ловит любой путь: объявленная
   * раньше, она перехватила бы `/api/...` и вернула бы страницу вместо
   * отказа. Порядок здесь — не стиль, а работоспособность.
   */
  if (deps.staticDir !== undefined) {
    router.use(express.static(deps.staticDir, { index: false }));

    /**
     * Любой другой путь — та же страница.
     *
     * Панель одностраничная: переход по ссылке внутрь неё не должен
     * давать «не найдено». API сюда не попадает — он объявлен выше и
     * отвечает раньше.
     */
    open('get', '/{*path}', (_req: Request, res: Response) => {
      res.sendFile('index.html', { root: deps.staticDir });
    });
  }

  return { router, routes, openRoutes };
}

/** Пути входа целиком — для проверок и для чтения глазами. */
export const OPEN_ROUTES: readonly string[] = AUTH_ROUTES.map((path) => `/api/auth${path}`);
