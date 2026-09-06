import { glob, readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, sep } from 'node:path';

import type { Express } from 'express';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createServer } from '../server.js';
import { hashPassword } from './password.js';
import { issuePass } from './token.js';
import { codeAt, decodeBase32, STEP_SECONDS } from './totp.js';
import {
  adminConfigFrom,
  createAdminRouter,
  FIRST_STEP_COOKIE,
  OPEN_ROUTES,
  SESSION_COOKIE,
  type AdminAuthConfig,
} from './index.js';

/**
 * Вход в админ-панель (§15 ТЗ, задача 4.5).
 *
 * **Условие готовности задачи — «без авторизации ни один эндпоинт админки
 * не отдаёт данные».** Это утверждение обо **всех** путях, поэтому здесь
 * оно и проверяется обо всех: список берётся у самой регистрации
 * (`createAdminRouter().routes`), а не набирается руками. Плюс вторая
 * проверка по исходникам — что мимо регистрации путь не добавить.
 *
 * Панель показывает содержимое чужих выгрузок (§15: «история выгрузок,
 * результаты разбора»), то есть самое личное, что есть в продукте.
 * Поэтому проверок здесь больше, чем в остальных местах, и половина из
 * них — про то, чего быть не должно.
 */

const LOGIN = 'аня';
const PASSWORD = 'очень-длинный-пароль-42';
const TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const SESSION_SECRET = 'секрет-подписи-пропусков';

let passwordHash = '';

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
}, 30_000);

const running: Server[] = [];

async function listen(app: Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => {
      resolve(started);
    });
  });

  running.push(server);
  const { port } = server.address() as AddressInfo;

  return `http://127.0.0.1:${String(port)}`;
}

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

function configOf(overrides: Partial<AdminAuthConfig> = {}): AdminAuthConfig {
  return {
    login: LOGIN,
    passwordHash,
    totpSecret: TOTP_SECRET,
    sessionSecret: SESSION_SECRET,
    // Сервер в тесте без сертификата: иначе печенье не доедет.
    secureCookies: false,
    ...overrides,
  };
}

async function serve(config?: AdminAuthConfig): Promise<string> {
  return await listen(
    createServer({
      healthChecks: [],
      ...(config === undefined ? {} : { admin: config }),
    }),
  );
}

/** Код, верный на текущую секунду. */
function currentCode(now = new Date()): string {
  const secret = decodeBase32(TOTP_SECRET);
  if (secret === undefined) throw new Error('секрет теста не разобрался');

  return codeAt(secret, Math.floor(now.getTime() / 1000 / STEP_SECONDS));
}

/** Значение печенья из ответа. */
function cookieFrom(response: Response, name: string): string | undefined {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    if (pair === undefined) continue;

    const at = pair.indexOf('=');
    if (pair.slice(0, at).trim() === name) return pair.slice(at + 1);
  }

  return undefined;
}

/** Полный вход в два шага. Возвращает печенье сессии. */
async function signIn(base: string): Promise<string> {
  const first = await fetch(`${base}/admin/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: LOGIN, password: PASSWORD }),
  });

  expect(first.status).toBe(200);
  const ticket = cookieFrom(first, FIRST_STEP_COOKIE);
  expect(ticket).toBeDefined();

  const second = await fetch(`${base}/admin/api/auth/code`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `${FIRST_STEP_COOKIE}=${ticket ?? ''}`,
    },
    body: JSON.stringify({ code: currentCode() }),
  });

  expect(second.status).toBe(200);
  const session = cookieFrom(second, SESSION_COOKIE);
  if (session === undefined) throw new Error('пропуск сессии не выдан');

  return session;
}

describe('без авторизации панель не отдаёт данные — условие готовности 4.5', () => {
  it('каждый закрытый путь отвечает отказом, и путей больше нуля', async () => {
    /**
     * Список путей — от самой регистрации. Проверка «путей больше нуля»
     * обязательна: без неё пустой список сделал бы эту проверку вечно
     * зелёной и бессмысленной, а заметить это было бы неоткуда.
     */
    const { routes } = createAdminRouter({ config: configOf() });
    expect(routes.length).toBeGreaterThan(0);

    const base = await serve(configOf());

    for (const route of routes) {
      const response = await fetch(`${base}/admin${route.path}`, {
        method: route.method.toUpperCase(),
      });

      expect(
        response.status,
        `${route.method} ${route.path} отдал ${String(response.status)}`,
      ).toBe(401);

      // И ни строчки данных в теле: отказ, а не «пустой успех».
      expect(await response.text()).not.toContain(LOGIN);
    }
  });

  it('открытых путей ровно три, и все три — про вход', () => {
    // Если бы открытым стал четвёртый, эта проверка покраснела бы
    // раньше, чем кто-то это заметил в бою.
    expect(OPEN_ROUTES).toEqual(['/api/auth/login', '/api/auth/code', '/api/auth/logout']);
  });

  it('путь в панели нельзя добавить мимо учёта — проверка по исходникам', async () => {
    /**
     * Список закрытых путей ведёт `closed` в `index.ts`. Если кто-то
     * позовёт `router.get` напрямую, путь появится в панели, но не в
     * списке — и проверка выше его не заметит. Здесь эта лазейка и
     * закрывается.
     *
     * Разрешён ровно один файл: `auth.ts`, где живут три открытых пути
     * входа, и они перечислены в `AUTH_ROUTES`.
     *
     * Открытый путь тоже объявляется функцией — `open`, — и попадает в
     * `openRoutes`. Так проверка отличает осознанное исключение (страница
     * панели: пустая оболочка без данных) от забытого стража.
     */
    const offenders: string[] = [];

    for await (const entry of glob('src/http/admin/**/*.ts')) {
      const path = entry.split(sep).join('/');
      if (path.includes('.test.')) continue;
      if (path.endsWith('/auth.ts')) continue;

      const source = await readFile(path, 'utf8');

      for (const [index, line] of source.split(/\r?\n/u).entries()) {
        if (/\brouter\.(get|post|put|patch|delete)\s*\(/u.test(line)) {
          offenders.push(`${path}:${String(index + 1)} ${line.trim()}`);
        }
      }
    }

    expect(
      offenders,
      [
        'Путь панели зарегистрирован мимо `closed`.',
        'Он окажется в панели, но не в списке закрытых путей — значит',
        'проверка «без авторизации ничего не отдаётся» его не увидит.',
        'Объявляй пути через `closed` (см. index.ts).',
        '',
        ...offenders,
      ].join('\n'),
    ).toEqual([]);
  });

  it('открытая страница панели не отдаёт данных — только оболочку', async () => {
    /**
     * Страница панели открыта нарочно: иначе окно входа не загрузить.
     * Но открытой она может быть лишь при одном условии — в ней не
     * должно быть данных человека. Данные панель запрашивает уже с
     * пропуском, отдельным обращением.
     */
    const dist = join(import.meta.dirname, '../../../../admin/dist');
    const mount = createAdminRouter({ config: configOf(), staticDir: dist });

    // Открытых путей ровно один — страница; входы живут отдельно.
    expect(mount.openRoutes).toEqual([{ method: 'get', path: '/{*path}' }]);

    const base = await listen(
      createServer({ healthChecks: [], admin: configOf(), adminStaticDir: dist }),
    );

    const page = await fetch(`${base}/admin/`);
    expect(page.status).toBe(200);

    const html = await page.text();
    expect(html).toContain('<div id="root">');
    // Ни логина, ни строчки чужих выгрузок: это оболочка.
    expect(html).not.toContain(LOGIN);
  });

  it('без настроек панели нет вовсе — и это не «панель без пароля»', async () => {
    /**
     * Забытая строка в `.env` не должна открывать содержимое чужих
     * выгрузок. Проверяется именно так: панель не поднята, путь
     * отвечает «не найдено».
     */
    const base = await serve(undefined);

    const response = await fetch(`${base}/admin/api/me`);
    expect(response.status).toBe(404);
  });

  it('половина настроек — тоже нет панели', () => {
    // Все четыре или ни одной: недонастроенная панель обязана быть
    // закрытой, а не «почти работающей».
    expect(adminConfigFrom({})).toBeUndefined();
    expect(adminConfigFrom({ ADMIN_LOGIN: LOGIN })).toBeUndefined();
    expect(
      adminConfigFrom({ ADMIN_LOGIN: LOGIN, ADMIN_PASSWORD_HASH: 'х', ADMIN_TOTP_SECRET: 'с' }),
    ).toBeUndefined();

    expect(
      adminConfigFrom({
        ADMIN_LOGIN: LOGIN,
        ADMIN_PASSWORD_HASH: 'х',
        ADMIN_TOTP_SECRET: 'с',
        ADMIN_SESSION_SECRET: 'п',
      }),
    ).toBeDefined();
  });

  it('пробелы вместо настройки — тоже нет панели', () => {
    // `.env` правит человек, и «ADMIN_LOGIN= » встречается чаще, чем
    // хотелось бы.
    expect(
      adminConfigFrom({
        ADMIN_LOGIN: '   ',
        ADMIN_PASSWORD_HASH: 'х',
        ADMIN_TOTP_SECRET: 'с',
        ADMIN_SESSION_SECRET: 'п',
      }),
    ).toBeUndefined();
  });
});

describe('вход в два шага (§15)', () => {
  it('верный логин и пароль панель ещё не открывают', async () => {
    /**
     * **Главное свойство двух шагов.** Первый шаг выдаёт пропуск, которым
     * можно только предъявить код. Если бы им открывалась панель, шагов
     * было бы не два, а один — и §15 остался бы невыполненным при
     * зелёных тестах.
     */
    const base = await serve(configOf());

    const first = await fetch(`${base}/admin/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: LOGIN, password: PASSWORD }),
    });

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, next: 'code' });

    const ticket = cookieFrom(first, FIRST_STEP_COOKIE);
    expect(ticket).toBeDefined();

    // Пропуск первого шага, предъявленный как сессия, не работает.
    const denied = await fetch(`${base}/admin/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${ticket ?? ''}` },
    });

    expect(denied.status).toBe(401);
  });

  it('код второго шага открывает панель', async () => {
    const base = await serve(configOf());
    const session = await signIn(base);

    const me = await fetch(`${base}/admin/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });

    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ login: LOGIN });
  });

  it('неверный пароль — отказ и ни одного печенья', async () => {
    const base = await serve(configOf());

    const response = await fetch(`${base}/admin/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: LOGIN, password: 'не тот пароль' }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('неверный логин при верном пароле — тот же отказ', async () => {
    // Ответ не должен отличаться: иначе логин подбирается по разнице.
    const base = await serve(configOf());

    const response = await fetch(`${base}/admin/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'не аня', password: PASSWORD }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false });
  });

  it('неверный код — отказ, панель закрыта', async () => {
    const base = await serve(configOf());

    const first = await fetch(`${base}/admin/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: LOGIN, password: PASSWORD }),
    });

    const ticket = cookieFrom(first, FIRST_STEP_COOKIE);

    const second = await fetch(`${base}/admin/api/auth/code`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${FIRST_STEP_COOKIE}=${ticket ?? ''}`,
      },
      body: JSON.stringify({ code: '000000' }),
    });

    expect(second.status).toBe(401);
    expect(cookieFrom(second, SESSION_COOKIE)).toBeUndefined();
  });

  it('верный код без первого шага не работает', async () => {
    /**
     * Иначе двух шагов нет: знающий код входил бы, не зная пароля.
     */
    const base = await serve(configOf());

    const response = await fetch(`${base}/admin/api/auth/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: currentCode() }),
    });

    expect(response.status).toBe(401);
    expect(cookieFrom(response, SESSION_COOKIE)).toBeUndefined();
  });

  it('выход закрывает панель', async () => {
    const base = await serve(configOf());
    const session = await signIn(base);

    const out = await fetch(`${base}/admin/api/auth/logout`, { method: 'POST' });
    expect(out.status).toBe(200);

    // Печенье велено удалить: браузер после этого пропуска не пришлёт.
    const cleared = out.headers.getSetCookie().join(' ');
    expect(cleared).toContain(SESSION_COOKIE);

    // А сам пропуск, если его сохранили, живёт до срока — цена
    // самодостаточного пропуска, названная в token.ts.
    const still = await fetch(`${base}/admin/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(still.status).toBe(200);
  });
});

describe('пропуск нельзя подделать', () => {
  it('подменённая подпись не проходит', async () => {
    const base = await serve(configOf());
    const session = await signIn(base);

    const [body] = session.split('.');
    // Подпись латиницей: в заголовок печенья кириллица не помещается
    // вовсе — HTTP разрешает там только Latin-1.
    const forged = `${body ?? ''}.my-own-signature`;

    const response = await fetch(`${base}/admin/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${forged}` },
    });

    expect(response.status).toBe(401);
  });

  it('подменённое содержимое не проходит', async () => {
    // Подпись считается по телу: правка тела ломает подпись.
    const base = await serve(configOf());
    const session = await signIn(base);

    const parts = session.split('.');
    const payload = JSON.parse(Buffer.from(parts[0] ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    payload['exp'] = Date.now() + 10 * 365 * 24 * 3_600_000;

    const forged = `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${
      parts[1] ?? ''
    }`;

    const response = await fetch(`${base}/admin/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${forged}` },
    });

    expect(response.status).toBe(401);
  });

  it('пропуск, подписанный чужим секретом, не проходит', async () => {
    const base = await serve(configOf());

    const alien = issuePass({ secret: 'чужой секрет', kind: 'session', login: LOGIN });

    const response = await fetch(`${base}/admin/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${alien}` },
    });

    expect(response.status).toBe(401);
  });

  it('истёкший пропуск не проходит', async () => {
    const base = await serve(configOf());

    // Пропуск, выданный тринадцать часов назад: срок сессии двенадцать.
    const stale = issuePass({
      secret: SESSION_SECRET,
      kind: 'session',
      login: LOGIN,
      now: new Date(Date.now() - 13 * 3_600_000),
    });

    const response = await fetch(`${base}/admin/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${stale}` },
    });

    expect(response.status).toBe(401);
  });

  it('мусор вместо пропуска не роняет сервер', async () => {
    const base = await serve(configOf());

    // Только Latin-1: заголовок печенья другого и не примет.
    for (const junk of ['', '.', 'a.b', 'a.b.c', '%%%.%%%', 'a'.repeat(5000), '..', '=']) {
      const response = await fetch(`${base}/admin/api/me`, {
        headers: { cookie: `${SESSION_COOKIE}=${junk}` },
      });

      expect(response.status).toBe(401);
    }
  });
});

describe('панель закрыта от индексации (§15)', () => {
  it('robots.txt запрещает раздел', async () => {
    const base = await serve(configOf());

    const response = await fetch(`${base}/robots.txt`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('Disallow: /admin');
  });

  it('и каждый ответ панели несёт запрет заголовком', async () => {
    /**
     * `robots.txt` — просьба к тому, кто дошёл до корня. Заголовок
     * приезжает с самим ответом, в том числе если на панель сослались
     * напрямую.
     */
    const base = await serve(configOf());

    const denied = await fetch(`${base}/admin/api/me`);
    expect(denied.headers.get('x-robots-tag')).toContain('noindex');

    const session = await signIn(base);
    const allowed = await fetch(`${base}/admin/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });

    expect(allowed.headers.get('x-robots-tag')).toContain('noindex');
  });
});

describe('печенье пропуска защищено', () => {
  it('недоступно скриптам и не уезжает на чужой сайт', async () => {
    /**
     * `HttpOnly` — против кражи пропуска скриптом на странице,
     * `SameSite=Strict` — против запроса, посланного с чужого сайта от
     * имени вошедшего. Панель показывает чужие выгрузки: цена кражи
     * пропуска здесь выше обычной.
     */
    const base = await serve(configOf());

    const first = await fetch(`${base}/admin/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: LOGIN, password: PASSWORD }),
    });

    const header = first.headers.getSetCookie().join(' ');

    expect(header).toContain('HttpOnly');
    expect(header.toLowerCase()).toContain('samesite=strict');
    expect(header).toContain('Path=/admin');
  });
});

describe('подбор пароля замедляется', () => {
  it('после десяти промахов верный пароль тоже не пускает', async () => {
    /**
     * Счётчик в памяти процесса — цена названа в `auth.ts`: при
     * нескольких копиях процесса счёт у каждой свой. Подбор это не
     * останавливает, а замедляет; вместе со scrypt, который стоит около
     * ста миллисекунд за попытку, этого достаточно для панели с одним
     * человеком.
     */
    const base = await serve(configOf());

    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await fetch(`${base}/admin/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login: LOGIN, password: `не тот ${String(attempt)}` }),
      });

      expect(response.status).toBe(401);
    }

    const honest = await fetch(`${base}/admin/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: LOGIN, password: PASSWORD }),
    });

    expect(honest.status).toBe(401);
  }, 60_000);
});
