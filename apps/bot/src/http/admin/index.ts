import express, {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

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
   * Объявить закрытый путь.
   *
   * Единственный способ добавить в панель путь: он же и записывает его в
   * список, по которому проверка убеждается, что путь закрыт. Мимо этой
   * функции пути не регистрируются — за этим следит проверка по
   * исходникам.
   */
  const closed = (method: 'get' | 'post', path: string, handler: RequestHandler): void => {
    routes.push({ method, path });
    router[method](path, handler);
  };

  /**
   * Объявить **открытый** путь — и тем взять на себя ответственность.
   *
   * Отдельной функцией, а не прямым вызовом роутера, ровно по той же
   * причине, что и `closed`: проверка должна видеть, что путь открыт
   * намеренно. Прямой `router.get` не видит никто.
   */
  const open = (method: 'get' | 'post', path: string, handler: RequestHandler): void => {
    openRoutes.push({ method, path });
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
  closed('get', '/api/me', (req: Request, res: Response) => {
    res.json({ login: req.admin?.login });
  });

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
