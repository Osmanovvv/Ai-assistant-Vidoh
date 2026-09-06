import express, {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import type { Executor } from '../../infra/db.js';
import { overview, people, personCard } from '../../modules/admin/people.js';
import { costBreakdown } from '../../modules/metering/cost-breakdown.js';
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

        void overview(db, days).then(
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
