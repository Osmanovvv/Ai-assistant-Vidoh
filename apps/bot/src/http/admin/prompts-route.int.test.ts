import type { Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import type { Express } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { promptVersions, type AiStage } from '../../db/schema.js';
import { CLASSIFIER_SCHEMA_NAME } from '../../modules/ai/schemas/index.js';
import { seedPrompt } from '../../modules/ai/prompts/seed.js';
import { testDb } from '../../test/db.js';
import { createServer } from '../server.js';
import { SESSION_COOKIE, type AdminAuthConfig } from './index.js';
import { hashPassword } from './password.js';
import { issuePass } from './token.js';

/**
 * Включение версии промпта через настоящий путь HTTP (§15, задача 4.8).
 *
 * **Ревизия четвёртого этапа нашла здесь непроверенную строку.** После
 * успешного включения роутер сбрасывает кэш реестра промптов
 * (`promptRegistry.forget`) — без этого правка доезжает до людей минутой
 * позже, а панель уже сказала «включено». Строку не покрывала ни одна
 * проверка: стенд собирал сервер без реестра, страж полноты сборки его
 * не знал, а модульные проверки включения ходят мимо роутера.
 */

const LOGIN = 'аня';
const PASSWORD = 'очень-длинный-пароль-42';
const SESSION_SECRET = 'секрет-подписи-пропусков-для-промптов';

let passwordHash = '';
let evalDir = '';

const running: Server[] = [];
const forgotten: (AiStage | undefined)[] = [];
/** Папки с «панелью» на время проверки: их отдача и перехватывала путь. */
const statics: string[] = [];

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
  evalDir = await mkdtemp(join(tmpdir(), 'vydoh-prompts-route-'));
}, 30_000);

afterAll(async () => {
  await rm(evalDir, { recursive: true, force: true });
  await Promise.all(statics.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(async () => {
  forgotten.length = 0;
  await testDb().delete(promptVersions);
});

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

async function stand(): Promise<string> {
  return await listen(
    createServer({
      healthChecks: [],
      admin: configOf(),
      adminDb: testDb(),
      adminEvalDir: evalDir,
      // Реестр промптов — как в бою. Именно его забывали и здесь, и на
      // браузерном стенде.
      adminPromptRegistry: {
        forget: (stage?: AiStage) => {
          forgotten.push(stage);
        },
      },
    }),
  );
}

async function activate(base: string, body: unknown): Promise<Response> {
  return await fetch(`${base}/admin/api/prompts/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${pass()}` },
    body: JSON.stringify(body),
  });
}

describe('включение версии сбрасывает кэш реестра', () => {
  it('после успешного включения кэш сброшен именно по этому этапу', async () => {
    await seedPrompt(testDb(), {
      stage: 'classifier',
      version: 'classifier@9',
      prompt: 'Текст.',
      schemaName: CLASSIFIER_SCHEMA_NAME,
    });

    const base = await stand();

    // Прогона набора нет — включаем с признанием: заслон §10.3 проверен
    // своими проверками, здесь меряется другое.
    const response = await activate(base, {
      stage: 'classifier',
      version: 'classifier@9',
      acknowledged: true,
    });

    expect(response.status).toBe(200);
    expect(forgotten).toEqual(['classifier']);

    // И версия действительно активна: сброс кэша без включения был бы
    // сбросом впустую.
    const [row] = await testDb()
      .select({ isActive: promptVersions.isActive })
      .from(promptVersions)
      .where(eq(promptVersions.version, 'classifier@9'));

    expect(row?.isActive).toBe(true);
  });

  it('отказ заслона кэш не сбрасывает: включать нечего', async () => {
    await seedPrompt(testDb(), {
      stage: 'classifier',
      version: 'classifier@9',
      prompt: 'Текст.',
      schemaName: CLASSIFIER_SCHEMA_NAME,
    });

    const base = await stand();

    const response = await activate(base, { stage: 'classifier', version: 'classifier@9' });

    expect(response.status).toBe(409);
    expect(forgotten).toEqual([]);
  });
});

describe('второй прогон отказывает названной причиной (ревизия панели)', () => {
  /**
   * Кнопка прогона в панели гасится по уже загруженному состоянию, и
   * между нажатием и ответом она жива: второе нажатие доходит до
   * сервера. Панель показывает рядом с отказом **причину сервера** —
   * «прогон уже идёт»; своими словами («не удалось запустить») выходила
   * неправда наоборот, потому что прогон запущен и уже тратит деньги.
   *
   * Причина в теле 409 не была покрыта ничем: убери её — и панели
   * останется только собственная догадка.
   */
  it('на 409 в теле лежит причина, а не пустой отказ', async () => {
    await seedPrompt(testDb(), {
      stage: 'classifier',
      version: 'classifier@9',
      prompt: 'Текст.',
      schemaName: CLASSIFIER_SCHEMA_NAME,
    });

    const base = await listen(
      createServer({
        healthChecks: [],
        admin: configOf(),
        adminDb: testDb(),
        adminEvalDir: evalDir,
        // Прогон уже идёт: второй запуск — второй счёт за то же самое.
        adminEvalRunner: {
          state: () => ({ kind: 'running', startedAt: new Date() }),
          start: () => false,
        },
      }),
    );

    const response = await fetch(`${base}/admin/api/prompts/run-eval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${pass()}` },
      body: JSON.stringify({ stage: 'classifier', version: 'classifier@9' }),
    });

    expect(response.status).toBe(409);

    const body = (await response.json()) as {
      readonly started?: unknown;
      readonly error?: unknown;
    };

    expect(body.started).toBe(false);
    expect(body.error).toBe('прогон уже идёт');
  });
});

describe('раздела нет — так и сказано, а не «не удалось прочитать»', () => {
  /**
   * **Найдено ревизией панели.** Без отчётов прогонов пути
   * `/api/prompts*` не объявлялись вовсе, и GET на них ловила отдача
   * файлов панели: `index.html` с кодом 200. Панель спотыкалась на
   * разборе JSON и печатала красное «Не удалось прочитать промпты» — то
   * есть говорила о своей поломке там, где раздел выключен нарочно.
   *
   * Состояние не выдуманное: так выглядит любой новый сервер до первого
   * `./ops/seed-prompts.sh` и сервер после неудачной отправки отчётов —
   * папку с ними скрипт сносит до распаковки.
   */

  /** Обстановка боя: отдача файлов панели объявлена и путь перехватит. */
  async function withPanelFiles(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'vydoh-prompts-static-'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>панель</title>', 'utf8');
    statics.push(dir);

    return await listen(
      createServer({
        healthChecks: [],
        admin: configOf(),
        adminDb: testDb(),
        adminStaticDir: dir,
      }),
    );
  }

  it('без отчётов путь отвечает JSON с enabled:false и причиной', async () => {
    const base = await withPanelFiles();

    const response = await fetch(`${base}/admin/api/prompts`, {
      headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
    });

    expect(response.status).toBe(200);

    // Именно JSON: страница панели вместо ответа и была дефектом.
    expect(response.headers.get('content-type') ?? '').toContain('application/json');

    const body = (await response.json()) as {
      readonly enabled?: unknown;
      readonly why?: unknown;
      readonly how?: unknown;
    };

    expect(body.enabled).toBe(false);

    // Причина и способ её убрать — словами: пустой ответ прочтётся как
    // поломка, а команда из рантбука закрывает вопрос сразу.
    expect(String(body.why)).toContain('отчёт');
    expect(String(body.how)).toContain('seed-prompts.sh');
  });

  it('а без пропуска — по-прежнему отказ, а не объяснение', async () => {
    // Путь стал объявляться всегда, и это не должно было открыть его
    // наружу: раздел закрыт тем же стражем, что и всё остальное.
    const base = await withPanelFiles();

    const response = await fetch(`${base}/admin/api/prompts`);

    expect(response.status).toBe(401);
  });
});
