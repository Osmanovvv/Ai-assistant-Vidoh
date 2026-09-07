import type { Server } from 'node:http';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { eq } from 'drizzle-orm';
import type { Express } from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { adminAccessLog, aiCalls, users } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../../modules/users/users.repo.js';
import { createServer } from '../server.js';
import { SettingsRegistry } from '../../modules/settings/settings.repo.js';
import { accessTo, recentAccess, recordAccess } from './audit.js';
import { createAdminRouter, SESSION_COOKIE, type AdminAuthConfig } from './index.js';
import { hashPassword } from './password.js';
import { issuePass } from './token.js';

/**
 * Журнал доступа к персональным данным (§16 ТЗ, задача 4.11).
 *
 * §16 дословно: «доступ к персональным данным в админ-панели
 * журналируется». Условие готовности задачи — «открытие карточки
 * пользователя оставляет запись в журнале доступа», и проверяется здесь
 * именно оно: не наличие таблицы, а то, что запись появляется от
 * настоящего обращения через настоящий сервер.
 *
 * Половина проверок — про то, чего быть не должно: журнал, в который
 * попадает всё, отвечает на вопрос «кто смотрел на этого человека» так
 * же плохо, как пустой.
 */

const LOGIN = 'аня';
const PASSWORD = 'очень-длинный-пароль-42';
const SESSION_SECRET = 'секрет-подписи-пропусков-для-журнала';

let passwordHash = '';
let person = '';

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

function configOf(): AdminAuthConfig {
  return {
    login: LOGIN,
    passwordHash,
    totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    sessionSecret: SESSION_SECRET,
    secureCookies: false,
  };
}

/** Готовый пропуск: вход проверен своими двадцатью тремя проверками. */
function pass(): string {
  return issuePass({ secret: SESSION_SECRET, kind: 'session', login: LOGIN });
}

beforeEach(async () => {
  await testDb().delete(adminAccessLog);
  await testDb().delete(aiCalls);
  await testDb().delete(users);

  person = (await upsertUser(testDb(), { tgId: 7_001, firstName: 'Аня' })).id;
});

describe('запись обращения', () => {
  it('появляется в журнале с тем, кто смотрел и на кого', async () => {
    await recordAccess(testDb(), {
      login: 'аня',
      route: '/api/users/:id',
      subjectUserId: person,
    });

    const rows = await recentAccess(testDb());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.login).toBe('аня');
    expect(rows[0]?.route).toBe('/api/users/:id');
    expect(rows[0]?.subjectUserId).toBe(person);
    expect(rows[0]?.at).toBeInstanceOf(Date);
  });

  it('находится по человеку — «кто смотрел на его данные»', async () => {
    const other = (await upsertUser(testDb(), { tgId: 7_002, firstName: 'Борис' })).id;

    await recordAccess(testDb(), { login: 'аня', route: '/a', subjectUserId: person });
    await recordAccess(testDb(), { login: 'аня', route: '/b', subjectUserId: other });

    const seen = await accessTo(testDb(), person);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.route).toBe('/a');
  });

  it('удаление данных человека не стирает след обращения к ним', async () => {
    /**
     * Иначе удалением можно было бы прятать доступ: посмотрел, удалил
     * человека — следа нет. Ссылка обнуляется, запись остаётся.
     */
    await recordAccess(testDb(), { login: 'аня', route: '/a', subjectUserId: person });

    await testDb().delete(users).where(eq(users.id, person));

    const rows = await recentAccess(testDb());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.subjectUserId).toBeNull();
    expect(rows[0]?.login).toBe('аня');
  });
});

describe('обращение через панель — условие готовности 4.11', () => {
  it('раздел с персональными данными оставляет запись', async () => {
    /**
     * Раздел расходов показывает имена и телеграмные номера — по ним
     * человек узнаётся, значит §16 действует. Именно поэтому он объявлен
     * персональным, хотя выглядит бухгалтерией.
     */
    const base = await listen(
      createServer({ healthChecks: [], admin: configOf(), adminDb: testDb() }),
    );

    const response = await fetch(`${base}/admin/api/costs`, {
      headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
    });

    expect(response.status).toBe(200);

    const rows = await recentAccess(testDb());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.login).toBe(LOGIN);
    expect(rows[0]?.route).toBe('/api/costs');
  });

  it('каждое обращение — своя запись, а не одна на сессию', async () => {
    // §16 просит журналировать доступ, а не факт входа: два взгляда на
    // чужие данные — это два события.
    const base = await listen(
      createServer({ healthChecks: [], admin: configOf(), adminDb: testDb() }),
    );

    for (let attempt = 0; attempt < 3; attempt++) {
      await fetch(`${base}/admin/api/costs`, {
        headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
      });
    }

    expect(await recentAccess(testDb())).toHaveLength(3);
  });

  it('раздел без персональных данных журнал не засоряет', async () => {
    /**
     * Журнал, в который попадает всё, отвечает на вопрос «кто смотрел на
     * этого человека» так же плохо, как пустой. `/api/me` отдаёт логин
     * самого администратора — своих же данных.
     */
    const base = await listen(
      createServer({ healthChecks: [], admin: configOf(), adminDb: testDb() }),
    );

    const response = await fetch(`${base}/admin/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
    });

    expect(response.status).toBe(200);
    expect(await recentAccess(testDb())).toEqual([]);
  });

  it('отказ без пропуска записи не оставляет', async () => {
    // Журнал про доступ **к данным**, а не про попытки войти: попытки
    // считает страж входа, и смешивать их значит утопить настоящие
    // обращения в шуме.
    const base = await listen(
      createServer({ healthChecks: [], admin: configOf(), adminDb: testDb() }),
    );

    const response = await fetch(`${base}/admin/api/costs`);

    expect(response.status).toBe(401);
    expect(await recentAccess(testDb())).toEqual([]);
  });
});

describe('не записали — не отдали', () => {
  it('сбой журнала закрывает доступ к данным', async () => {
    /**
     * **Главное решение задачи 4.11.** Незапротоколированный доступ есть
     * нарушение §16, а не мелкая неприятность: если запись не удалась,
     * данные не отдаются.
     *
     * Цена названа честно — сбой базы делает раздел недоступным. Но
     * раздел без журнала хуже недоступного, потому что выглядит
     * работающим, и разобрать потом, кто на что смотрел, будет нечем.
     */
    /**
     * База, у которой сломана только запись.
     *
     * Прокси, а не копия объекта: клиент базы — экземпляр класса, и
     * копирование через разбор потеряло бы его прототип вместе с
     * половиной методов. Здесь подменяется ровно один метод, остальное
     * работает как обычно.
     */
    const real = testDb();
    const broken = new Proxy(real, {
      get(target, key, receiver): unknown {
        if (key === 'insert') {
          return () => {
            throw new Error('журнал недоступен');
          };
        }

        return Reflect.get(target, key, receiver);
      },
    }) as unknown as Executor;

    const problems: unknown[] = [];

    const base = await listen(
      createServer({
        healthChecks: [],
        admin: configOf(),
        adminDb: broken,
        onError: (error) => problems.push(error),
      }),
    );

    const response = await fetch(`${base}/admin/api/costs`, {
      headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
    });

    expect(response.status).toBe(503);
    // И сбой не молчит: его видит мониторинг, а не только человек.
    expect(problems).toHaveLength(1);
  });
});

/**
 * Роутер со **всеми** необязательными зависимостями.
 *
 * Раздел объявляется под условием: расходы — при базе, промпты — при
 * папке набора, рассылка — при очереди. Собранный без них роутер про
 * эти пути не знает, и решения об их персональных данных здесь никто
 * не прочтёт. Это уже случалось трижды, поэтому полнота сборки
 * стережётся отдельно — в `admin.test.ts` числом путей.
 */
function everything(): ReturnType<typeof createAdminRouter> {
  return createAdminRouter({
    config: configOf(),
    db: testDb(),
    settings: new SettingsRegistry({ db: testDb(), ttlMs: 0 }),
    evalDir: join(import.meta.dirname, 'нет-такой-папки'),
    evalRunner: {
      state: () => ({ kind: 'idle' }),
      start: () => false,
    },
    enqueueBroadcast: async () => {
      await Promise.resolve();
    },
    enqueueUser: async () => {
      await Promise.resolve();
    },
  });
}

describe('решение о персональных данных принято у каждого пути', () => {
  it('ни один путь не оставлен без решения', () => {
    /**
     * Само решение требует тип, поэтому забыть его нельзя — но список
     * причин у непубличных путей стоит прочитать глазами хотя бы раз.
     * Эта проверка их и печатает: пустая причина означает, что решение
     * приняли, не подумав.
     */
    const mount = everything();

    for (const route of [...mount.routes, ...mount.openRoutes]) {
      if (route.exposure.personal) continue;

      expect(route.exposure.why.length, `${route.method} ${route.path}`).toBeGreaterThan(10);
    }
  });

  it('раздел расходов признан персональным — по именам людей', () => {
    // Соблазн назвать его сводкой велик: страница выглядит как
    // бухгалтерия. На этом соблазне журнал доступа и обходят.
    const mount = everything();
    const costs = mount.routes.find((route) => route.path === '/api/costs');

    expect(costs?.exposure.personal).toBe(true);
  });
});

describe('панель не рисует кнопок, за которыми ничего нет', () => {
  it('без запускающего прогон раздел промптов говорит об этом, а не молчит', async () => {
    /**
     * **Дефект, видимый только на боевом.** Набора там нет и быть не
     * должно: в нём живые расшифровки людей (§16). Панель рисовала кнопку
     * прогона всегда — а такого пути на сервере нет, и нажатие давало
     * невнятный отказ. Кнопка, которая всегда отказывает, учит не верить
     * панели.
     *
     * Признак `canRun` отвечает на это одним словом, и раздел показывает
     * либо кнопку, либо объяснение.
     */
    const base = await listen(
      createServer({
        healthChecks: [],
        admin: configOf(),
        adminDb: testDb(),
        adminEvalDir: join(import.meta.dirname, 'нет-такой-папки'),
      }),
    );

    const response = await fetch(`${base}/admin/api/prompts`, {
      headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { readonly canRun: boolean }).canRun).toBe(false);
  });

  it('с запускающим — кнопка есть', async () => {
    const base = await listen(
      createServer({
        healthChecks: [],
        admin: configOf(),
        adminDb: testDb(),
        adminEvalDir: join(import.meta.dirname, 'нет-такой-папки'),
        adminEvalRunner: { state: () => ({ kind: 'idle' }), start: () => false },
      }),
    );

    const response = await fetch(`${base}/admin/api/prompts`, {
      headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
    });

    expect(((await response.json()) as { readonly canRun: boolean }).canRun).toBe(true);
  });
});
