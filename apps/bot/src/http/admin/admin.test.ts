import { glob, readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, sep } from 'node:path';

import type { Express } from 'express';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Executor } from '../../infra/db.js';
import type { EvalRunner } from '../../modules/admin/eval-run.js';
import type { SettingsRegistry } from '../../modules/settings/settings.repo.js';
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

/**
 * База, к которой обращения не будет.
 *
 * Проверка стучится в закрытые пути **без пропуска**: страж отказывает
 * до обработчика, и до базы дело не доходит ни разу. Настоящая база
 * здесь означала бы, что проверка требует Postgres ради того, чего не
 * происходит, — и переехала бы в интеграционные вместе с двадцатью
 * проверками входа, которым база тоже ни к чему.
 *
 * Если однажды дело до неё дойдёт, обращение к этому объекту упадёт
 * громко, а не тихо соврёт: у него просто нет ни одного метода.
 */
const NEVER_TOUCHED = {} as Executor;

/**
 * Прогон, который не запустится: страж отказывает раньше обработчика.
 *
 * Настоящий стоил бы денег, а тут до него не доходит ни разу — как и до
 * базы выше. Врёт он громко: `start` бросает вместо тихого «не вышло».
 */
/** Очередь, до которой дело не дойдёт: страж отказывает раньше. */
const NEVER_QUEUED = (): Promise<void> => {
  throw new Error('очередь не должна использоваться в проверке стража');
};

const NEVER_RUN: EvalRunner = {
  state: () => ({ kind: 'idle' }),
  start: () => {
    throw new Error('прогон набора не должен запускаться из проверки стража');
  },
};

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
     *
     * **Роутер собирается со всеми необязательными зависимостями**, и
     * это не перестраховка. Раздел расходов объявляется только при
     * заданной базе; собранный без неё роутер этого пути не знает — и
     * проверка молча его пропускала. Поймано на задаче 4.7, на своём же
     * страже, через час после того, как он был написан. И повторилось на
     * задаче 4.8: пути промптов появляются только при заданной папке
     * набора, а кнопка прогона — только при запускающем. Новую
     * необязательную зависимость надо добавлять **сюда тоже**, иначе
     * страж честно проверит всё, кроме нового.
     */
    const withEverything = {
      config: configOf(),
      db: NEVER_TOUCHED,
      staticDir: join(import.meta.dirname, '../../../../admin/dist'),
      evalDir: join(import.meta.dirname, 'нет-такой-папки'),
      evalRunner: NEVER_RUN,
      settings: NEVER_TOUCHED as unknown as SettingsRegistry,
      enqueueBroadcast: NEVER_QUEUED,
      enqueueUser: NEVER_QUEUED,
      /**
       * Реестр промптов — тоже необязательная зависимость (ревизия этапа).
       *
       * Его забыли и здесь, и на стенде: сброс кэша после включения
       * версии не проверялся ни одной проверкой, хотя без него правка
       * доезжает до людей через минуту, а панель говорит «включено».
       */
      promptRegistry: { forget: () => undefined },
    } as const;

    const { routes } = createAdminRouter(withEverything);

    expect(routes.length).toBeGreaterThan(0);

    const base = await listen(
      createServer({
        healthChecks: [],
        admin: configOf(),
        adminDb: NEVER_TOUCHED,
        adminEvalDir: withEverything.evalDir,
        adminEvalRunner: NEVER_RUN,
        adminSettings: withEverything.settings,
        adminEnqueueBroadcast: NEVER_QUEUED,
        adminEnqueueUser: NEVER_QUEUED,
      }),
    );

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

  it('собранный со всем роутер знает все пути из исходников', async () => {
    /**
     * **Страж от забывчивости, и он написан по третьему случаю.**
     *
     * Раздел объявляется под условием: расходы — при базе, промпты —
     * при папке набора, рассылка — при очереди. Проверка выше собирает
     * роутер и берёт у него список путей; забыл дать зависимость —
     * путей меньше, а проверка зелёная. Так случилось трижды: на
     * задачах 4.7, 4.8 и 4.10, и каждый раз это находилось руками.
     *
     * Здесь то же самое находится само: число объявлений `closed` и
     * `open` в исходниках сверяется с числом путей у роутера,
     * собранного со всеми зависимостями. Разошлось — значит роутер
     * собран не полностью, и список путей неполон.
     */
    const declared: string[] = [];

    for await (const entry of glob('src/http/admin/**/*.ts')) {
      const path = entry.split(sep).join('/');
      if (path.includes('.test.')) continue;

      const source = await readFile(path, 'utf8');

      for (const [index, line] of source.split(/\r?\n/u).entries()) {
        // Объявление функции — не вызов: `const closed = (` мимо.
        if (/^\s*(closed|open)\s*\(/u.test(line)) {
          declared.push(`${path}:${String(index + 1)}`);
        }
      }
    }

    const mount = createAdminRouter({
      config: configOf(),
      db: NEVER_TOUCHED,
      settings: NEVER_TOUCHED as unknown as SettingsRegistry,
      staticDir: join(import.meta.dirname, '../../../../admin/dist'),
      evalDir: join(import.meta.dirname, 'нет-такой-папки'),
      evalRunner: NEVER_RUN,
      enqueueBroadcast: NEVER_QUEUED,
      enqueueUser: NEVER_QUEUED,
    });

    const known = mount.routes.length + mount.openRoutes.length;

    expect(
      known,
      [
        `В исходниках объявлено ${String(declared.length)} путей, а роутер знает ${String(known)}.`,
        'Значит роутер в проверке собран не со всеми необязательными',
        'зависимостями — и часть путей не проверяется вовсе.',
        'Добавь недостающую зависимость в `withEverything` и сюда.',
        ...declared,
      ].join('\n'),
    ).toBe(declared.length);
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
    expect(mount.openRoutes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'get /{*path}',
    ]);

    /**
     * И у него записано, **почему** он открыт: в нём нет данных
     * человека (§16, задача 4.11). Открытый путь без такого решения —
     * это дыра, объявленная случайно.
     */
    const only = mount.openRoutes[0];
    expect(only?.exposure.personal).toBe(false);
    expect(only?.exposure.personal === false ? only.exposure.why : '').toContain('оболочка');

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

describe('вход не роняет процесс (§15, ревизия четвёртого этапа)', () => {
  /**
   * **Самая дорогая находка ревизии.** Запрос на вход без заголовка
   * `content-type` оставляет `req.body` неопределённым: express 5 его не
   * задаёт, а разборщик тела при чужом типе просто пропускает запрос
   * дальше. Чтение `body.login` бросало `TypeError` внутри промиса,
   * который никто не подхватывал — express отказа не видел, своего
   * приёмника `unhandledRejection` у процесса нет, и Node доводил такое
   * падение до выхода.
   *
   * То есть **посторонний одним запросом в сто байт останавливал бота
   * целиком**, и пароля для этого не требовалось. Путь открыт наружу.
   *
   * Проверка идёт настоящим запросом по всем трём видам тела, какими
   * приходит такой запрос: без заголовка, с чужим типом и с телом «не
   * объект». Ответ обязан быть отказом, и — главное — процесс обязан
   * пережить это и ответить на следующий запрос.
   */
  const bodies = [
    { what: 'без content-type вовсе', headers: {}, body: 'login=a&password=b' },
    {
      what: 'с чужим content-type',
      headers: { 'content-type': 'text/plain' },
      body: '{"login":"a"}',
    },
    {
      what: 'с телом «не объект»',
      headers: { 'content-type': 'application/json' },
      body: '"строка"',
      /**
       * Здесь ждём 400, а не 401, и это верно: разборщик тела отвергает
       * строку на верхнем уровне сам, до обработчика. «Прислали не то» —
       * ошибка обратившегося, и отвечать на неё «сломались мы» панель
       * перестала ещё на ревизии 4.5.
       */
      status: 400,
    },
    { what: 'с пустым телом', headers: { 'content-type': 'application/json' }, body: '' },
  ] as const;

  for (const one of bodies) {
    it(`не роняет и отвечает отказом: ${one.what}`, async () => {
      const base = await serve(configOf());

      for (const path of ['/admin/api/auth/login', '/admin/api/auth/code']) {
        const response = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: one.headers,
          body: one.body,
        });

        expect(response.status, `${path} ${one.what}`).toBe('status' in one ? one.status : 401);
      }

      /**
       * И главное: сервер жив и по-прежнему пускает настоящего
       * администратора. Без этой строки проверка утверждала бы только
       * код ответа, а падение процесса произошло бы **после** него.
       */
      const session = await signIn(base);
      expect(session).toBeDefined();
    });
  }
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
  /**
   * Адрес подставляется заголовком, и в проверке это можно.
   *
   * Сервер верит **одному** посредителю (`trust proxy: 1` в `server.ts`),
   * и в бою этот один — Caddy: он дописывает настоящий адрес последним, а
   * берётся именно последний, поэтому подставить свой нельзя. Здесь Caddy
   * нет, ближайший к серверу — сам клиент, и подстановка работает: ровно
   * то, что нужно, чтобы изобразить двух разных обратившихся.
   */
  async function tryLogin(
    base: string,
    params: { readonly from: string; readonly password: string },
  ): Promise<Response> {
    return await fetch(`${base}/admin/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': params.from },
      body: JSON.stringify({ login: LOGIN, password: params.password }),
    });
  }

  it('сверх меры ответ приходит с задержкой, но верный пароль пускает', async () => {
    /**
     * **Здесь стоял дефект, и проверка его закрепляла.** Было так:
     * десять промахов — и верный пароль тоже не пускает до конца окна.
     * Счёт при этом вёлся один на всех, значит любой желающий десятью
     * запросами запирал панель настоящему администратору на десять минут.
     * Заслон от подбора оказывался кнопкой «выключить панель».
     *
     * Теперь мера — задержка: подбирающему дорого, администратору
     * возможно. Проверяется и то и другое: и что задержка появилась, и
     * что вход всё же состоялся.
     */
    const base = await serve(configOf());

    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await tryLogin(base, {
        from: '10.0.0.7',
        password: `не тот ${String(attempt)}`,
      });

      expect(response.status).toBe(401);
    }

    const startedAt = Date.now();
    const honest = await tryLogin(base, { from: '10.0.0.7', password: PASSWORD });

    expect(honest.status).toBe(200);
    // Две секунды задержки минус запас на неточность часов.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_800);
  }, 60_000);

  it('промахи одного адреса не задерживают другого', async () => {
    /**
     * То, из-за чего счёт стал по адресу. Настоящий администратор не
     * должен ждать из-за того, что кто-то другой подбирает пароль.
     */
    const base = await serve(configOf());

    for (let attempt = 0; attempt < 12; attempt++) {
      await tryLogin(base, { from: '10.0.0.8', password: `не тот ${String(attempt)}` });
    }

    const startedAt = Date.now();
    const honest = await tryLogin(base, { from: '10.0.0.9', password: PASSWORD });

    expect(honest.status).toBe(200);
    // Без задержки: scrypt около ста миллисекунд, до двух секунд далеко.
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  }, 60_000);
});

describe('тело запроса вмещает то, что панель посылает', () => {
  /**
   * **Здесь был дефект, и невидимый.** Предел тела стоял 16 КБ, а самый
   * большой промпт продукта весит 15,3 КБ — с экранированием JSON правка
   * `classifier@6` из панели упиралась в отказ. Панель говорила «не
   * удалось сохранить» и не объясняла, почему; ни один тест этого не
   * видел, потому что все посылали короткие тела.
   *
   * Проверяется на пути настроек: он отвечает 400 на неизвестное имя —
   * **после** разбора тела. Значит 400 означает «тело разобрано», а 413 —
   * «не влезло». Иначе понадобился бы живой Postgres ради проверки
   * предела.
   */
  async function postBody(base: string, session: string, size: number): Promise<number> {
    const response = await fetch(`${base}/admin/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${session}` },
      body: JSON.stringify({ name: 'нет-такой-настройки', value: 'а'.repeat(size) }),
    });

    return response.status;
  }

  it('промпт в шестьдесят тысяч знаков доезжает', async () => {
    const base = await listen(
      createServer({
        healthChecks: [],
        admin: configOf(),
        adminDb: NEVER_TOUCHED,
        adminSettings: NEVER_TOUCHED as unknown as SettingsRegistry,
      }),
    );

    const session = await signIn(base);

    // Шестьдесят тысяч русских знаков — это около 120 КБ в UTF-8, вчетверо
    // больше нынешнего самого длинного промпта.
    expect(await postBody(base, session, 60_000)).toBe(400);
  }, 30_000);

  it('но предел всё же есть: мегабайт не принимается', async () => {
    // Путь за стражем, слать сюда мегабайты некому — но безграничное
    // тело означало бы, что вошедший может занять память процесса.
    const base = await listen(
      createServer({
        healthChecks: [],
        admin: configOf(),
        adminDb: NEVER_TOUCHED,
        adminSettings: NEVER_TOUCHED as unknown as SettingsRegistry,
      }),
    );

    const session = await signIn(base);

    expect(await postBody(base, session, 1_000_000)).toBe(413);
  }, 30_000);
});

describe('битый запрос отвечает своим кодом, а не пятисотым', () => {
  it('невалидный JSON — 400, а не «сломались мы»', async () => {
    /**
     * Пятисотый значит «сломались мы». Отвечать им на присланный мусор
     * значит отправлять того, кто разбирает сбой, искать поломку не там —
     * а заодно поднимать долю ошибок в мониторинге (§18) на чужих
     * кривых запросах.
     */
    const base = await listen(
      createServer({
        healthChecks: [],
        admin: configOf(),
        adminDb: NEVER_TOUCHED,
        adminSettings: NEVER_TOUCHED as unknown as SettingsRegistry,
      }),
    );

    const session = await signIn(base);

    const response = await fetch(`${base}/admin/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${session}` },
      body: '{это не json',
    });

    expect(response.status).toBe(400);
  }, 30_000);
});
