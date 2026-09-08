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
import { accessTo, checkParam, recentAccess, recordAccess } from './audit.js';
import { fullAdminRouter } from './full-router.js';
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
  /**
   * Тот же сборщик, что у сверки числа путей (ревизия этапа 4).
   *
   * Прежде здесь был свой список зависимостей, а сверка полноты сборки
   * охраняла **другой** роутер, собранный в другом файле по другому
   * списку. Два списка на один вопрос разъезжаются молча.
   */
  return fullAdminRouter({
    config: configOf(),
    db: testDb(),
    settings: new SettingsRegistry({ db: testDb(), ttlMs: 0 }),
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

  it('обзор признан персональным — воронка по источникам называет человека', () => {
    /**
     * Ревизия четвёртого этапа. Обзор — самая соблазнительная страница
     * для обратной правки: чисел на ней больше, чем людей за ними, а
     * запись в журнал стоит на каждом открытии, и открывается обзор
     * первым. «Это же просто сводка, зачем её писать» — и разрез по
     * блогерам, где группа из одного человека называет его заплатившим,
     * уходит из журнала молча.
     *
     * Решение объявлено с 4.4, но комментарий над путём полгода
     * утверждал обратное, и то же неверное утверждение стояло в плане.
     * Комментарии и план ревизия исправила; здесь — то, что не даст
     * исправить обратно.
     */
    const mount = everything();
    const exposure = mount.routes.find((route) => route.path === '/api/overview')?.exposure;

    // «Многих сразу» читается только у персонального пути — у сводки
    // такого поля нет вовсе, и тип об этом знает. Поэтому сначала
    // разбираемся с решением, а потом уже с его подробностями.
    if (exposure?.personal !== true) {
      throw new Error('обзор объявлен не персональным — журнал доступа его потерял');
    }

    expect(exposure.subjects).toBe('many');
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

/** Сервер со всеми зависимостями: часть разделов живёт под условием. */
function withEverything(): Express {
  return createServer({
    healthChecks: [],
    admin: configOf(),
    adminDb: testDb(),
    adminSettings: new SettingsRegistry({ db: testDb(), ttlMs: 0 }),
  });
}

describe('число людей в ответе — настоящее, а не догадка (§16, ревизия этапа)', () => {
  /**
   * **Столбец `subjects` утверждал «в ответ попал один человек» про
   * каждую страницу списка.** Он стоял `not null default 1`, а
   * `recordAccess` вызывался без него — умолчание базы превращалось в
   * утверждение. Разбирающий инцидент увидел бы двадцать обращений «к
   * одному человеку» вместо «к странице из двадцати» и сделал бы вывод,
   * обратный правде. Это ровно тот инвариант: пустая клетка читается как
   * факт.
   */

  it('список людей записывает столько людей, сколько выдал', async () => {
    // Три человека в базе, страница из двух: в журнале обязано быть 2.
    await upsertUser(testDb(), { tgId: 7_002, firstName: 'Боря' });
    await upsertUser(testDb(), { tgId: 7_003, firstName: 'Вера' });

    const base = await listen(
      createServer({
        healthChecks: [],
        admin: configOf(),
        adminDb: testDb(),
        adminSettings: new SettingsRegistry({ db: testDb(), ttlMs: 0 }),
      }),
    );

    const response = await fetch(`${base}/admin/api/people?limit=2`, {
      headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { rows: unknown[] }).rows).toHaveLength(2);

    const [row] = await recentAccess(testDb());

    expect(row?.route).toBe('/api/people');
    expect(row?.subjects).toBe(2);
  });

  it('карточка записывает одного — и того, на кого смотрели', async () => {
    const base = await listen(
      createServer({ healthChecks: [], admin: configOf(), adminDb: testDb() }),
    );

    const response = await fetch(`${base}/admin/api/people/${person}`, {
      headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
    });

    expect(response.status).toBe(200);

    const [row] = await recentAccess(testDb());

    expect(row?.subjectUserId).toBe(person);
    expect(row?.subjects).toBe(1);
  });

  it('где число не установлено, там пусто — а не единица', async () => {
    /**
     * У журнала сбоев в ответе несколько списков, и человек может стоять
     * в двух сразу: посчитать его длиной одного из них значило бы вернуть
     * ту самую догадку. Пусто честнее — панель печатает это словом «не
     * установлено».
     */
    const base = await listen(
      createServer({
        healthChecks: [],
        admin: configOf(),
        adminDb: testDb(),
        adminSettings: new SettingsRegistry({ db: testDb(), ttlMs: 0 }),
      }),
    );

    await fetch(`${base}/admin/api/errors`, {
      headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
    });

    const [row] = await recentAccess(testDb());

    expect(row?.route).toBe('/api/errors');
    expect(row?.subjects).toBeNull();
  });

  it('имя параметра сверяется с путём — иначе «на одного» стало бы «на многих»', () => {
    /**
     * Опечатка в имени параметра давала `undefined`, и запись тихо
     * превращалась в «смотрели на многих»: тип этого не поймает, там
     * строка. Теперь не поднимется сервер — громко и у всех сразу.
     */
    expect(() => {
      checkParam('/api/people/:userId', { personal: true, subjects: 'one', param: 'userld' });
    }).toThrow(/userld/u);

    expect(() => {
      checkParam('/api/people/:userId', { personal: true, subjects: 'one', param: 'userId' });
    }).not.toThrow();

    // И все объявленные пути такую сверку проходят — вот она, на живом
    // роутере, собранном со всеми зависимостями.
    for (const route of everything().routes) {
      expect(() => {
        checkParam(route.path, route.exposure);
      }, route.path).not.toThrow();
    }
  });
});

describe('журнал доступа читается панелью (§16, обещание задачи 4.10)', () => {
  /**
   * **Обещание, которое ревизия нашла неисполненным.** План 4.11 сказал
   * дословно: «И сам журнал как раздел панели (§15 не просит его
   * показывать, но разбирать инцидент по SQL неудобно) — это 4.10, где
   * живут журналы». Задачу 4.10 закрыли, раздела не появилось, а
   * `recentAccess` и `accessTo` остались без вызывающих вне тестов.
   * Журнал без читателя исполняет §16 на бумаге.
   */

  it('раздел отдаёт обращения с числом людей и с тем, на кого смотрели', async () => {
    const base = await listen(withEverything());

    // Настоящее обращение к карточке, а не посев: проверяется путь целиком.
    await fetch(`${base}/admin/api/people/${person}`, {
      headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
    });

    const response = await fetch(`${base}/admin/api/access?days=1`, {
      headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
    });

    expect(response.status).toBe(200);

    const view = (await response.json()) as {
      readonly rows: readonly {
        readonly route: string;
        readonly subjectUserId: string | null;
        readonly subjects: number | null;
      }[];
      readonly total: number;
    };

    const card = view.rows.find((row) => row.route === '/api/people/:userId');

    expect(card?.subjectUserId).toBe(person);
    expect(card?.subjects).toBe(1);

    // И само чтение журнала — тоже обращение к персональным данным.
    expect(view.total).toBeGreaterThanOrEqual(1);
  });

  it('имён людей в журнале доступа нет — иначе он стал бы вторым списком людей', async () => {
    const base = await listen(withEverything());

    await fetch(`${base}/admin/api/people/${person}`, {
      headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
    });

    const response = await fetch(`${base}/admin/api/access`, {
      headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
    });

    expect(await response.text()).not.toContain('Аня');
  });

  it('журнал доступа закрыт без входа', async () => {
    const base = await listen(withEverything());

    expect((await fetch(`${base}/admin/api/access`)).status).toBe(401);
  });
});

describe('чужая ошибка — не наш сбой (ревизия четвёртого этапа)', () => {
  it('карточка удалённого человека отвечает 404, а не 503', async () => {
    /**
     * **Прежде это была наша поломка на чужом действии.** Код человека
     * уезжал прямо в журнал доступа, где стоит внешний ключ: Postgres
     * отвечал ошибкой, панель говорила «доступ не записан в журнал» —
     * 503, — а доля ошибок §18 росла и поднимала ложную тревогу. Ветка
     * 404 внутри обработчика была недостижима вовсе.
     *
     * Случай штатный: человек мог удалить данные между открытием списка
     * и нажатием на строку.
     */
    const failures: unknown[] = [];

    const base = await listen(
      createServer({
        healthChecks: [],
        admin: configOf(),
        adminDb: testDb(),
        adminOnError: (error) => {
          failures.push(error);
        },
      }),
    );

    const gone = '00000000-0000-0000-0000-000000000000';

    const response = await fetch(`${base}/admin/api/people/${gone}`, {
      headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
    });

    expect(response.status).toBe(404);

    // И это не считается нашим сбоем: тревога §18 от чужого действия не
    // поднимается.
    expect(failures).toEqual([]);
  });

  it('код не того вида отвечает 404 и до журнала не доходит', async () => {
    const failures: unknown[] = [];

    const base = await listen(
      createServer({
        healthChecks: [],
        admin: configOf(),
        adminDb: testDb(),
        adminOnError: (error) => {
          failures.push(error);
        },
      }),
    );

    const response = await fetch(`${base}/admin/api/people/не-код-вовсе`, {
      headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
    });

    expect(response.status).toBe(404);
    expect(failures).toEqual([]);

    // В журнале ничего: обращения к персональным данным не было.
    expect(await recentAccess(testDb())).toEqual([]);
  });

  it('битый JSON снаружи не считается нашим сбоем', async () => {
    /**
     * `onError` в бою считает долю неудачных обработок апдейтов (§18) и
     * по ней посылает оповещение «бот перестал отвечать людям». Прежде
     * он звался первой строкой обработчика ошибок — до разбирательства,
     * чья это ошибка, — и любой запрос с битым телом снаружи (сканер,
     * чужой бот, опечатка) поднимал тревогу про нас.
     */
    const failures: unknown[] = [];

    const base = await listen(
      createServer({
        healthChecks: [],
        admin: configOf(),
        adminDb: testDb(),
        onError: (error) => {
          failures.push(error);
        },
      }),
    );

    const response = await fetch(`${base}/admin/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{это не json',
    });

    expect(response.status).toBe(400);
    expect(failures).toEqual([]);
  });

  it('сбой раздела панели идёт своим приёмником, а не общим', async () => {
    /**
     * Сбой запроса в панели — не провал обработки апдейта: люди при этом
     * получают ответы как обычно. Прежде приёмник был один, и открытая
     * заказчицей страница с упавшим запросом двигала окно оповещений §18.
     */
    const updates: unknown[] = [];
    const panel: unknown[] = [];

    /**
     * База, роняющая любое чтение.
     *
     * Через `Proxy`, а не копированием полей: у объекта drizzle методы
     * опираются на `this`, и копия их теряет.
     */
    const real = testDb();

    const broken = new Proxy(real, {
      get(one, name, receiver): unknown {
        if (name !== 'select') return Reflect.get(one, name, receiver);

        return () => {
          throw new Error('база моргнула');
        };
      },
    });

    const base = await listen(
      createServer({
        healthChecks: [],
        admin: configOf(),
        adminDb: broken,
        onError: (error) => {
          updates.push(error);
        },
        adminOnError: (error) => {
          panel.push(error);
        },
      }),
    );

    const response = await fetch(`${base}/admin/api/costs`, {
      headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
    });

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(panel.length).toBeGreaterThan(0);
    expect(updates).toEqual([]);
  });
});
