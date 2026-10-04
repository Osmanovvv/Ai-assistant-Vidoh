import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from './db.js';
import { createLogger } from './logger.js';
import { startRecoverySweep } from '../modules/pipeline/sweeper.js';
import { startRenewals } from '../modules/billing/renewal.service.js';
import type { RobokassaDeps } from '../modules/billing/providers/robokassa.js';
import { startRenewalNotices } from '../modules/billing/notice.service.js';
import { startInactivityLoop } from '../modules/privacy/inactivity.service.js';
import type { TopicGateway } from '../modules/topics/gateway.js';
import { SettingsRegistry } from '../modules/settings/settings.repo.js';
import { startBalanceWatch } from '../modules/cloud/balance-watch.js';
import { startMisunderstoodDigest } from '../modules/misunderstood/digest.js';

/** Медленный первый запрос. Все последующие запросы возвращают пустой стенд. */
function delayedDatabase() {
  let release!: () => void;
  let reject!: (reason: unknown) => void;
  const pending = new Promise<void>((resolve, refuse) => {
    release = resolve;
    reject = refuse;
  });
  const gate = { promise: pending, resolve: release, reject };
  let queries = 0;
  const rowsFor = (rows: unknown[]): Promise<unknown[]> => {
    queries++;
    return queries === 1 ? gate.promise.then(() => rows) : Promise.resolve(rows);
  };
  const query = (rows: unknown[] = []): unknown => {
    const chain: unknown = new Proxy(
      {},
      {
        get: (_target, property) =>
          property === 'then'
            ? (yes: (value: unknown[]) => unknown, no: (reason: unknown) => unknown) =>
                rowsFor(rows).then(yes, no)
            : () => chain,
      },
    );
    return chain;
  };
  const db = {
    select: (fields?: object) =>
      query(fields !== undefined && 'total' in fields ? [{ total: 0 }] : []),
    selectDistinct: () => query(),
    update: () => query(),
    insert: () => query(),
    delete: () => query(),
    execute: async () => ({ rows: await rowsFor([]) }),
    transaction: async (work: (tx: Database) => Promise<unknown>) =>
      await work(db as unknown as Database),
  };
  return { db: db as unknown as Database, gate, queries: () => queries };
}

type Stop = () => Promise<void>;
const loops: { name: string; start: (db: Database, logger: Logger) => Promise<Stop> }[] = [
  {
    name: 'досмотр выгрузок',
    start: (db, logger) =>
      Promise.resolve(
        startRecoverySweep(
          { db, logger, process: () => Promise.resolve(), onOutcome: () => undefined },
          10,
        ),
      ),
  },
  {
    name: 'продления',
    start: (db, logger) =>
      Promise.resolve(
        startRenewals(
          { db, logger, settings: new SettingsRegistry({ db }), robokassa: {} as RobokassaDeps },
          10,
        ),
      ),
  },
  {
    name: 'предупреждения о списании',
    start: (db, logger) =>
      Promise.resolve(
        startRenewalNotices(
          { db, logger, settings: new SettingsRegistry({ db }), notify: () => Promise.resolve() },
          10,
        ),
      ),
  },
  {
    name: 'удаление после тишины',
    start: (db, logger) =>
      Promise.resolve(
        startInactivityLoop(
          { db, logger, topics: {} as TopicGateway, sender: { ask: () => Promise.resolve(0) } },
          { intervalMs: 10 },
        ),
      ),
  },
  {
    name: 'баланс облака',
    start: async (db, logger) => {
      const handle = await startBalanceWatch({
        keyFile: undefined,
        logger,
        everyMs: 10,
        thresholdRub: () => Promise.resolve(50),
        alert: () => Promise.resolve(true),
        watch: {
          check: async () => {
            await db.execute(sql`select 1`);
          },
          status: () => Promise.reject(new Error('status is not used by this test')),
        },
      });
      if (handle === undefined) throw new Error('подмена сторожа не запустилась');
      return handle.stop;
    },
  },
  {
    name: 'сводка непонятого',
    start: (db, logger) =>
      Promise.resolve(
        startMisunderstoodDigest({
          everyMs: 10,
          logger,
          list: async () => {
            await db.execute(sql`select 1`);
            return [];
          },
          alert: () => Promise.resolve(true),
        }).stop,
      ),
  },
];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(loops)('$name: завершение текущего прохода', ({ start }) => {
  it('остановка ждёт медленный запрос и последующую работу; новых тиков нет', async () => {
    const { db, gate, queries } = delayedDatabase();
    const logger = createLogger({ level: 'silent' });
    const errors = vi.spyOn(logger, 'error');
    const warnings = vi.spyOn(logger, 'warn');
    const stop = await start(db, logger);
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(queries()).toBeGreaterThan(0);
      const stopping = stop();
      const repeatedStop = stop();
      let stopped = false;
      void stopping.then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(stopped).toBe(false);
      gate.resolve();
      await Promise.all([stopping, repeatedStop]);
      expect(stopped).toBe(true);
      expect(errors).not.toHaveBeenCalled();
      expect(warnings).not.toHaveBeenCalled();
      const completedQueries = queries();
      await vi.advanceTimersByTimeAsync(100);
      expect(queries()).toBe(completedQueries);
    } finally {
      gate.resolve();
      await stop();
    }
  });

  it('отказ текущего запроса завершается штатно, а таймер остаётся отключён', async () => {
    const { db, gate, queries } = delayedDatabase();
    const logger = createLogger({ level: 'silent' });
    const stop = await start(db, logger);
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(queries()).toBeGreaterThan(0);
      const stopping = stop();
      gate.reject(new Error('имитация отказа базы'));
      await expect(stopping).resolves.toBeUndefined();
      const completedQueries = queries();
      await vi.advanceTimersByTimeAsync(100);
      expect(queries()).toBe(completedQueries);
    } finally {
      gate.resolve();
      await stop();
    }
  });
});
