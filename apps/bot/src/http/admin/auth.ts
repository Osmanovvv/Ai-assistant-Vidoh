import express, { Router, type NextFunction, type Request, type Response } from 'express';

import { passwordMatches } from './password.js';
import { issuePass, readPass, SESSION_TTL_MS } from './token.js';
import { codeMatches } from './totp.js';

/**
 * Вход в админ-панель (§15 ТЗ, задача 4.5).
 *
 * §15: «Доступ по логину и паролю, вход в два шага. Панель закрыта от
 * индексации поисковыми системами.» Условие готовности задачи —
 * «без авторизации ни один эндпоинт админки не отдаёт данные», и оно
 * проверяется тестом, который берёт список путей у **самой регистрации**
 * (см. `closed` в `index.ts`), а не из списка, набранного руками: иначе
 * следующий добавленный эндпоинт тихо окажется открытым.
 *
 * **Панель выключена, пока не задана целиком.** Нет логина, хэша
 * пароля, секрета кодов или секрета подписи — панели нет вовсе, и любой
 * её путь отвечает «не найдено». Полумеры здесь опаснее отсутствия:
 * панель, поднявшаяся без пароля, открывает содержимое чужих выгрузок
 * всему интернету. Отсутствующая настройка не должна означать
 * «пускать», ни при каких обстоятельствах.
 *
 * **Два шага — это два разных пропуска.** Логин с паролем дают пропуск
 * первого шага, которым можно **только** предъявить код; панель
 * открывает лишь пропуск сессии. Вид записан внутри подписи, поэтому
 * подменить один другим нельзя.
 *
 * **Ошибка входа всегда одна и та же.** Ни «нет такого логина», ни
 * «пароль неверен», ни «код просрочен»: любое различие — это подсказка
 * подбирающему.
 */

/** Имя печенья с пропуском сессии. */
export const SESSION_COOKIE = 'vydoh_admin';

/** Имя печенья с пропуском первого шага. */
export const FIRST_STEP_COOKIE = 'vydoh_admin_step';

export interface AdminAuthConfig {
  readonly login: string;
  readonly passwordHash: string;
  /** Секрет одноразовых кодов, base32 — как его дают приложения. */
  readonly totpSecret: string;
  /** Секрет подписи пропусков. */
  readonly sessionSecret: string;
  /** Печенье уходит только по HTTPS. Выключается лишь в тестах. */
  readonly secureCookies?: boolean | undefined;
  /** Часы — для тестов срока годности. */
  readonly now?: (() => Date) | undefined;
}

/**
 * Настройки панели из окружения. `undefined` — панели нет.
 *
 * Все четыре или ни одной: половина настроек означает недонастроенную
 * панель, а недонастроенная панель обязана быть закрытой.
 */
export function adminConfigFrom(env: {
  readonly ADMIN_LOGIN?: string | undefined;
  readonly ADMIN_PASSWORD_HASH?: string | undefined;
  readonly ADMIN_TOTP_SECRET?: string | undefined;
  readonly ADMIN_SESSION_SECRET?: string | undefined;
}): AdminAuthConfig | undefined {
  const login = env.ADMIN_LOGIN?.trim();
  const passwordHash = env.ADMIN_PASSWORD_HASH?.trim();
  const totpSecret = env.ADMIN_TOTP_SECRET?.trim();
  const sessionSecret = env.ADMIN_SESSION_SECRET?.trim();

  if (!login || !passwordHash || !totpSecret || !sessionSecret) return undefined;

  return { login, passwordHash, totpSecret, sessionSecret };
}

/** Печенья запроса. Свой разбор, чтобы не тащить зависимость ради строки. */
export function cookiesOf(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  if (header === undefined) return jar;

  for (const piece of header.split(';')) {
    const at = piece.indexOf('=');
    if (at === -1) continue;

    const name = piece.slice(0, at).trim();
    const value = piece.slice(at + 1).trim();
    if (name === '') continue;

    try {
      jar[name] = decodeURIComponent(value);
    } catch {
      // Испорченная кодировка — не повод ронять запрос: печенье просто
      // не читается, и пропуск не найдётся.
      jar[name] = value;
    }
  }

  return jar;
}

/** Кто вошёл. Кладётся в запрос для журнала доступа (§16, задача 4.11). */
export interface AdminIdentity {
  readonly login: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    admin?: AdminIdentity;
  }
}

/**
 * Сколько неудачных попыток входа терпим и как долго.
 *
 * Счётчик в памяти процесса: панель — один человек, и хранилище ради
 * этого заводить незачем. Цена честная и названа: при нескольких
 * копиях процесса счёт у каждой свой, а перезапуск его обнуляет.
 * Подбор пароля это не останавливает, а замедляет — вместе с scrypt,
 * который стоит около ста миллисекунд за попытку.
 */
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 10 * 60_000;

/**
 * Сверх меры — **задержка, а не запрет**, и это исправление настоящего
 * дефекта.
 *
 * Сначала здесь стоял отказ: превысил десять попыток — не пускаем до конца
 * окна. Счёт при этом вёлся один на всех, и любой желающий десятью
 * запросами запирал панель настоящему администратору на десять минут.
 * Заслон от подбора оказывался кнопкой «выключить панель», доступной кому
 * угодно.
 *
 * Теперь счёт ведётся **по адресу обратившегося**, а перебор меры даёт
 * паузу перед ответом. Настоящий администратор с другого адреса не
 * замечает ничего; попавший под общий с подбирающим адрес ждёт две секунды
 * вместо отказа. Подбирающему пауза дороже, чем нам: она ложится поверх
 * scrypt и держит его соединение.
 */
const OVER_LIMIT_DELAY_MS = 2_000;

/** Сколько адресов помним. Больше — выкидываем протухшие. */
const ATTEMPT_JAR_LIMIT = 10_000;

interface Attempts {
  count: number;
  until: number;
}

/** Пауза перед ответом, если попыток с этого адреса уже слишком много. */
function overLimitDelayMs(jar: Map<string, Attempts>, key: string, now: number): number {
  const seen = jar.get(key);
  if (seen === undefined || seen.until <= now) return 0;

  return seen.count >= MAX_ATTEMPTS ? OVER_LIMIT_DELAY_MS : 0;
}

function noteAttempt(jar: Map<string, Attempts>, key: string, now: number): void {
  const seen = jar.get(key);

  if (seen === undefined || seen.until <= now) {
    // Чужие адреса копятся, а память не бесконечна: перед новой записью
    // выкидываем те, чьё окно кончилось.
    if (jar.size >= ATTEMPT_JAR_LIMIT) {
      for (const [name, old] of jar) {
        if (old.until <= now) jar.delete(name);
      }
    }

    jar.set(key, { count: 1, until: now + ATTEMPT_WINDOW_MS });
    return;
  }

  seen.count++;
}

/**
 * Кто обратился.
 *
 * `req.ip` верен только потому, что серверу сказано, скольким посредникам
 * верить (`trust proxy` в `server.ts`). Скажи мы неверно — адрес стал бы
 * одним и тем же у всех, и счёт снова оказался бы общим. Поэтому мера тут
 * мягкая: задержка, а не запрет.
 */
function whoAsked(req: Request): string {
  return req.ip ?? 'неизвестно';
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

/** Один и тот же отказ на все случаи. */
function refuse(res: Response): void {
  res.status(401).json({ ok: false });
}

function cookieOptions(config: AdminAuthConfig, maxAgeMs: number): Record<string, unknown> {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    // Печенье не должно уезжать по открытому http. Выключается только
    // в тестах, где поднимается сервер без сертификата.
    secure: config.secureCookies ?? true,
    path: '/admin',
    maxAge: maxAgeMs,
  };
}

/**
 * Страж: пускает только с пропуском сессии.
 *
 * Отдельной функцией, чтобы её можно было надеть на **весь** раздел
 * разом, а не вешать на каждый путь по отдельности. Забытая строка на
 * одном пути — ровно тот дефект, ради которого написано условие
 * готовности задачи.
 */
export function requireAdmin(config: AdminAuthConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const pass = cookiesOf(req.headers.cookie)[SESSION_COOKIE];
    if (pass === undefined) {
      refuse(res);
      return;
    }

    const identity = readPass({
      secret: config.sessionSecret,
      pass,
      kind: 'session',
      ...(config.now === undefined ? {} : { now: config.now() }),
    });

    if (identity === undefined) {
      refuse(res);
      return;
    }

    req.admin = { login: identity.login };
    next();
  };
}

/**
 * Открытые пути входа — перечнем, потому что их ровно три и они
 * единственные, кто в панели работает без пропуска.
 *
 * Список нужен проверке «всё, кроме входа, закрыто»: она берёт
 * закрытые пути из регистрации, а этот перечень — то, что закрытым
 * быть **не должно**. Разъехаться они не могут: путь, забытый здесь,
 * окажется в списке закрытых и будет проверен на отказ; лишний путь
 * здесь — не пройдёт проверку «эти три отвечают».
 */
export const AUTH_ROUTES: readonly string[] = ['/login', '/code', '/logout'];

export function createAuthRouter(config: AdminAuthConfig): Router {
  const router = Router();
  const attempts = new Map<string, Attempts>();
  const clock = (): Date => config.now?.() ?? new Date();

  router.use(express.json({ limit: '4kb' }));

  // ── Шаг первый: логин и пароль ────────────────────────────────────────
  router.post('/login', (req: Request, res: Response) => {
    void (async () => {
      const now = clock();
      const body = req.body as { login?: unknown; password?: unknown };
      const login = typeof body.login === 'string' ? body.login : '';
      const password = typeof body.password === 'string' ? body.password : '';

      const who = `login:${whoAsked(req)}`;
      const delay = overLimitDelayMs(attempts, who, now.getTime());
      if (delay > 0) await sleep(delay);

      /**
       * Пароль сверяется **всегда**, даже при чужом логине.
       *
       * Иначе ответ на несуществующий логин приходил бы мгновенно, а на
       * существующий — через сто миллисекунд scrypt, и логин можно было
       * бы угадать по времени ответа.
       */
      const matches = await passwordMatches(password, config.passwordHash);
      const ok = matches && login === config.login;

      if (!ok) {
        noteAttempt(attempts, who, now.getTime());
        refuse(res);
        return;
      }

      const pass = issuePass({
        secret: config.sessionSecret,
        kind: 'firstStep',
        login: config.login,
        now,
      });

      res.cookie(FIRST_STEP_COOKIE, pass, cookieOptions(config, 2 * 60_000));
      // Панель не открыта: следующий шаг — код. Никаких данных здесь
      // не отдаётся, только «нужен второй шаг».
      res.json({ ok: true, next: 'code' });
    })();
  });

  // ── Шаг второй: одноразовый код ───────────────────────────────────────
  router.post('/code', (req: Request, res: Response) => {
    void (async () => {
      const now = clock();
      const body = req.body as { code?: unknown };
      const code = typeof body.code === 'string' ? body.code : '';

      const who = `code:${whoAsked(req)}`;
      const delay = overLimitDelayMs(attempts, who, now.getTime());
      if (delay > 0) await sleep(delay);

      const ticket = cookiesOf(req.headers.cookie)[FIRST_STEP_COOKIE];
      const first =
        ticket === undefined
          ? undefined
          : readPass({ secret: config.sessionSecret, pass: ticket, kind: 'firstStep', now });

      if (first === undefined || !codeMatches({ secret: config.totpSecret, code, now })) {
        noteAttempt(attempts, who, now.getTime());
        refuse(res);
        return;
      }

      const session = issuePass({
        secret: config.sessionSecret,
        kind: 'session',
        login: first.login,
        now,
      });

      // Пропуск первого шага больше не нужен: он своё отслужил, и
      // оставлять его в браузере значит держать лишний ключ.
      res.clearCookie(FIRST_STEP_COOKIE, { path: '/admin' });
      res.cookie(SESSION_COOKIE, session, cookieOptions(config, SESSION_TTL_MS));
      res.json({ ok: true });
    })();
  });

  // ── Выход ─────────────────────────────────────────────────────────────
  router.post('/logout', (_req: Request, res: Response) => {
    res.clearCookie(SESSION_COOKIE, { path: '/admin' });
    res.clearCookie(FIRST_STEP_COOKIE, { path: '/admin' });
    res.json({ ok: true });
  });

  return router;
}
