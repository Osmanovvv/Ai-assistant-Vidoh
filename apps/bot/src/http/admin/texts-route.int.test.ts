import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Express } from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { textOverrides } from '../../db/schema.js';
import { applyOverrides, defaultTexts, textsFor } from '../../texts/index.js';
import { TextsRegistry } from '../../texts/registry.js';
import { testDb } from '../../test/db.js';
import { createServer } from '../server.js';
import { SESSION_COOKIE, type AdminAuthConfig } from './index.js';
import { hashPassword } from './password.js';
import { issuePass } from './token.js';

/**
 * Правка реплик через настоящий путь HTTP (§13.9, задача 4.13).
 *
 * §13.9 требует менять тексты **без выкладки новой версии**. До этой
 * задачи реплики лежали только в коде: правка шла выкладкой, то есть
 * через прогон и чужой взгляд. Теперь она попадает людям сразу — и
 * единственное, что стоит между ней и человеком, это проверка §13 на
 * записи. Здесь она и проверяется, тем же путём, которым ходит панель.
 */

const LOGIN = 'аня';
const PASSWORD = 'очень-длинный-пароль-42';
const SESSION_SECRET = 'секрет-подписи-пропусков-для-реплик';

const PLAIN = 'limits.trialOver';
const WITH_PLACE = 'resolver.noted';

let passwordHash = '';
const running: Server[] = [];

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
}, 30_000);

beforeEach(async () => {
  await testDb().delete(textOverrides);
  applyOverrides(new Map());
});

afterEach(async () => {
  // Склейка живёт в модуле: не вернёшь — и соседний файл проверок будет
  // мерить чужую правку вместо словаря из кода.
  applyOverrides(new Map());

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

function pass(): string {
  return issuePass({ secret: SESSION_SECRET, kind: 'session', login: LOGIN });
}

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

/**
 * Стенд с настоящим реестром реплик.
 *
 * Реестр здесь не для красоты: без него правка легла бы в таблицу, а бот
 * продолжал бы говорить прежними словами до истечения окна — и проверка
 * «действует сразу» ничего бы не значила.
 */
function stand(): { readonly base: Promise<string> } {
  const texts = new TextsRegistry({ db: testDb() });

  return {
    base: listen(
      createServer({
        healthChecks: [],
        admin: configOf(),
        adminDb: testDb(),
        adminTexts: texts,
      }),
    ),
  };
}

async function save(base: string, body: unknown): Promise<Response> {
  return await fetch(`${base}/admin/api/texts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${pass()}` },
    body: JSON.stringify(body),
  });
}

async function whyOf(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: unknown };

  return typeof body.error === 'string' ? body.error : '';
}

describe('редактор реплик: список', () => {
  it('отдаёт реплики, слова из кода и число подстановок', async () => {
    const { base } = stand();
    const at = await base;

    const answer = await fetch(`${at}/admin/api/texts`, {
      headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
    });

    expect(answer.status).toBe(200);

    const view = (await answer.json()) as {
      rows: { path: string; said: string; fromCode: string; edited: boolean; places: number }[];
      hidden: { path: string; why: string }[];
    };

    const plain = view.rows.find((one) => one.path === PLAIN);
    const parameterized = view.rows.find((one) => one.path === WITH_PLACE);

    expect(plain?.said).toBe(defaultTexts.limits.trialOver);
    expect(plain?.edited).toBe(false);
    expect(plain?.places).toBe(0);

    // Число подстановок обязано доехать: по нему панель объясняет, что
    // «{1}» нельзя терять, и по нему же отказывает запись.
    expect(parameterized?.places).toBe(1);

    // Спрятанные реплики названы с причиной: «в списке чего-то нет»
    // человек читает как потерю, если причина не рядом.
    expect(view.hidden.map((one) => one.path)).toContain('card.statusName');
    expect(view.hidden[0]?.why.length).toBeGreaterThan(20);
  });

  it('без пропуска не отдаёт ничего', async () => {
    const { base } = stand();
    const answer = await fetch(`${await base}/admin/api/texts`);

    expect(answer.status).toBe(401);
  });
});

describe('редактор реплик: запись', () => {
  it('правка сохраняется и действует сразу, а не через окно', async () => {
    /**
     * Главное обещание §13.9. Человек, нажавший «Сохранить», идёт
     * проверять бота тут же — и должен увидеть свои слова, а не прежние.
     */
    const { base } = stand();
    const at = await base;

    const answer = await save(at, { path: PLAIN, said: 'Пробные разборы кончились.' });

    expect(answer.status).toBe(200);
    expect(textsFor().limits.trialOver).toBe('Пробные разборы кончились.');

    const [row] = await testDb().select().from(textOverrides);

    expect(row?.value).toBe('Пробные разборы кончились.');
    // Кто правил — по этому вопросу и приходят: «бот сказал не то».
    expect(row?.updatedBy).toBe(LOGIN);
  });

  it('пустая правка возвращает реплику к словам из кода', async () => {
    const { base } = stand();
    const at = await base;
    const fromCode = defaultTexts.limits.trialOver;

    await save(at, { path: PLAIN, said: 'Другое.' });
    expect(textsFor().limits.trialOver).toBe('Другое.');

    const answer = await save(at, { path: PLAIN, said: '   ' });

    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ reset: true });
    expect(textsFor().limits.trialOver).toBe(fromCode);
    expect(await testDb().select().from(textOverrides)).toEqual([]);
  });

  it('реплика с подстановкой сохраняется и подставляет значение', async () => {
    const { base } = stand();

    const answer = await save(await base, { path: WITH_PLACE, said: 'Дописала к «{1}».' });

    expect(answer.status).toBe(200);
    expect(textsFor().resolver.noted('зубной')).toBe('Дописала к «зубной».');
  });

  it('правленую реплику можно поправить снова — подстановка не теряется', async () => {
    /**
     * Ловушка, найденная при склейке: у обёртки арность ноль, и число
     * подстановок для второй правки читалось как «ноль». Тогда «{1}»
     * отвергалось словами «нечего подставлять» — человек не мог поправить
     * то, что сам же и поправил. Число берётся из кода, а не из обёртки.
     */
    const { base } = stand();
    const at = await base;

    expect((await save(at, { path: WITH_PLACE, said: 'Дописала к «{1}».' })).status).toBe(200);

    const again = await save(at, { path: WITH_PLACE, said: 'Записала подробность к «{1}».' });

    expect(again.status).toBe(200);
    expect(textsFor().resolver.noted('зубной')).toBe('Записала подробность к «зубной».');
  });
});

describe('редактор реплик: чего он не пропускает (§13 на записи)', () => {
  it('двух вопросов не принимает и говорит, сколько их', async () => {
    const { base } = stand();

    const answer = await save(await base, {
      path: PLAIN,
      said: 'Разобрать дела? Или на сегодня хватит?',
    });

    expect(answer.status).toBe(400);
    expect(await whyOf(answer)).toMatch(/двух вопросов/iu);

    // И реплика осталась прежней: отказ не должен ничего записать.
    expect(textsFor().limits.trialOver).toBe(defaultTexts.limits.trialOver);
    expect(await testDb().select().from(textOverrides)).toEqual([]);
  });

  it('фразу из запретов §13.7 не принимает', async () => {
    const { base } = stand();

    const answer = await save(await base, { path: PLAIN, said: 'Отдохни, дела подождут.' });

    expect(answer.status).toBe(400);
    expect(await whyOf(answer)).toContain('отдохни');
  });

  it('потерянную подстановку не принимает: человек прочёл бы обрубок', async () => {
    const { base } = stand();

    const answer = await save(await base, { path: WITH_PLACE, said: 'Дописала подробность.' });

    expect(answer.status).toBe(400);
    expect(await whyOf(answer)).toContain('{1}');
  });

  it('серию восклицательных и украшательский эмодзи не принимает', async () => {
    const { base } = stand();
    const at = await base;

    expect((await save(at, { path: PLAIN, said: 'Всё!!' })).status).toBe(400);
    expect((await save(at, { path: PLAIN, said: 'Готово 🎉' })).status).toBe(400);
  });

  it('нередактируемую реплику не принимает и объясняет, почему', async () => {
    const { base } = stand();

    const answer = await save(await base, { path: 'card.statusName', said: 'Готово.' });

    expect(answer.status).toBe(400);
    expect(await whyOf(answer)).toMatch(/таблица состояний/iu);
  });

  it('кризисную реплику без контакта не принимает: §13.7 держится на записи', async () => {
    /**
     * Регрессия, найденная ревизией второго этапа. Редактор §13.9 сделал
     * реплику острого кризиса правимой, а её свойства проверялись только
     * на словаре **из кода**: правка из панели шла в бой мимо них.
     * Заказчица могла нечаянно снести контакт из самой ответственной
     * реплики продукта, и ни одна проверка не покраснела бы.
     */
    const { base } = stand();
    const at = await base;

    const noContact = await save(at, {
      path: 'safety.crisis',
      said: 'Остановилась. Сказанное сохранила, ничего не потеряно. Позвони близкому человеку.',
    });

    expect(noContact.status).toBe(400);
    expect(await whyOf(noContact)).toMatch(/контакт цифрами/iu);

    const withQuestion = await save(at, {
      path: 'safety.crisis',
      said: 'Остановилась, сказанное сохранила. Телефон помощи 8 800 200 01 22. Позвонишь?',
    });

    expect(withQuestion.status).toBe(400);
    expect(await whyOf(withQuestion)).toMatch(/не бывает вопроса/iu);

    // И ни одна из отвергнутых правок не осела в базе.
    expect(await testDb().select().from(textOverrides)).toEqual([]);
  });

  it('годную кризисную реплику принимает: правило не запрещает всё разом', async () => {
    // Обратная сторона: правило, которое не пропускает ничего, кончается
    // тем, что его снимают целиком.
    const { base } = stand();

    const answer = await save(await base, {
      path: 'safety.crisis',
      said: 'Остановилась и ничего не потеряла. Телефон помощи: 8 800 200 01 22, там ответят круглосуточно.',
    });

    expect(answer.status).toBe(200);
  });

  it('несуществующую реплику не принимает', async () => {
    const { base } = stand();

    const answer = await save(await base, { path: 'такой.реплики.нет', said: 'Слова.' });

    expect(answer.status).toBe(400);
    expect(await whyOf(answer)).toMatch(/такой реплики нет/iu);
  });

  it('без пропуска не пишет ничего', async () => {
    const { base } = stand();

    const answer = await fetch(`${await base}/admin/api/texts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: PLAIN, said: 'Мимо входа.' }),
    });

    expect(answer.status).toBe(401);
    expect(await testDb().select().from(textOverrides)).toEqual([]);
  });
});
