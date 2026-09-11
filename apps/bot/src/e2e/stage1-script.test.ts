import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { updateIdOf } from './updates.js';

/**
 * Сквозной тест этапа 1 идёт по боевой базе — и должен вести себя как
 * гость, а не как хозяин (§18 ТЗ, ревизия этапов 1–2).
 *
 * `ops/e2e-stage1.sh` — единственный сквозной тест без своей базы:
 * этапы 2 и 3 поднимают `vydoh_e2e`, а этот шлёт апдейты боевому боту и
 * читает боевой Postgres. Пока людей на сервере не было, это сходило с
 * рук. Теперь есть, и до починки скрипт после каждой выкладки:
 *   - перезапускал боевого бота ровно в момент разбора;
 *   - чистил журнал дедупликации `delete from telegram_updates where
 *     update_id >= 900000000` в расчёте, что настоящие апдейты туда не
 *     попадают, — но номера даёт Telegram, а не мы, и удалённая запись
 *     значит, что повтор доставки задвоит сообщение человека;
 *   - ничего из этого не говорил и ни о чём не спрашивал.
 *
 * Страж гоняет настоящий скрипт настоящим bash, подменив через PATH
 * только `ssh` (записывает команду, отвечает заготовленными фактами) и
 * `sleep` (иначе прогон занимал бы три минуты). Проверяется не текст
 * скрипта, а то, какие команды ушли бы на сервер. Нет bash — страж
 * красный, а не пропущенный: пропуск зеленел бы молча.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const script = resolve(root, 'ops/e2e-stage1.sh').replaceAll('\\', '/');

const CHAT_ID = 999_000_001;

/**
 * Поддельный ssh. Последний аргумент — команда для сервера; она пишется
 * в журнал прогона. На запрос фактов отвечает так, будто все сценарии
 * прошли: по счётчику запросов — первый про сценарий 1, второй про 2,
 * дальше про 3. На `delete` отвечает отказом, если попросили через
 * FAKE_SSH_FAIL_DELETE, — это проверка, что уборка не молчит.
 */
const FAKE_SSH = `#!/usr/bin/env bash
cmd="\${@: -1}"
printf '%s\\n' "$cmd" >> "$FAKE_SSH_LOG"
case "$cmd" in
  *select*)
    n=$(cat "$FAKE_SSH_LOG.facts" 2>/dev/null || echo 0)
    n=$((n + 1))
    printf '%s' "$n" > "$FAKE_SSH_LOG.facts"
    case "$n" in
      1) printf '1~done~3~3~0~надо записать сына к врачу | и купить продуктов | ещё забрать вещи из химчистки~0\\n' ;;
      2) printf '2~done,done~2~2~0~первая мысль // вторая мысль, пришла в момент разбора~0\\n' ;;
      *) printf '1~done~1~1~0~мысль, которую прервёт перезапуск~0\\n' ;;
    esac ;;
  *delete*)
    [ -z "\${FAKE_SSH_FAIL_DELETE:-}" ] || exit 1 ;;
esac
`;

const FAKE_SLEEP = '#!/usr/bin/env bash\nexit 0\n';

/** Медленные проверки: настоящий bash, десятки процессов на прогон. */
const SLOW = 60_000;

let fakeDir = '';
let runs = 0;

beforeAll(() => {
  fakeDir = mkdtempSync(join(tmpdir(), 'vydoh-e2e-stage1-'));
  writeFileSync(join(fakeDir, 'ssh'), FAKE_SSH, { mode: 0o755 });
  writeFileSync(join(fakeDir, 'sleep'), FAKE_SLEEP, { mode: 0o755 });
});

afterAll(() => {
  rmSync(fakeDir, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Команды, ушедшие бы на сервер, в порядке отправки. */
  readonly remote: string;
  /** Секунда эпохи, в которую скрипт запущен: от неё он ведёт номера. */
  readonly startedAtSec: number;
}

function run(args: readonly string[], answer: string, extraEnv: Record<string, string> = {}): Run {
  runs += 1;
  const log = join(fakeDir, `run-${String(runs)}.log`);

  // На Windows переменная зовётся Path, и node подставит именно её.
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [pathKey]: `${fakeDir}${delimiter}${process.env[pathKey] ?? ''}`,
    FAKE_SSH_LOG: log.replaceAll('\\', '/'),
    ...extraEnv,
  };

  const startedAtSec = Math.floor(Date.now() / 1000);
  const result = spawnSync('bash', [script, ...args], { env, input: answer, encoding: 'utf8' });
  if (result.error !== undefined) throw result.error;

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    remote: existsSync(log) ? readFileSync(log, 'utf8') : '',
    startedAtSec,
  };
}

/**
 * Один прогон стоит секунды: на Windows каждый поддельный ssh — процесс.
 * Подтверждённый прогон без флагов нужен нескольким проверкам, и он один.
 */
let confirmedOnce: Run | undefined;

function confirmed(): Run {
  confirmedOnce ??= run([], 'да\n');
  return confirmedOnce;
}

function sentMessageIds(remote: string): number[] {
  return [...remote.matchAll(/send-test-update\.js 999000001 (\d+) /gu)].map((m) => Number(m[1]));
}

describe('сквозной тест этапа 1 на боевой базе', () => {
  it('без слова «да» не трогает сервер вовсе — и говорит, что именно сделал бы', () => {
    const declined = run([], '');

    expect(declined.status).not.toBe(0);
    expect(declined.remote, 'на сервер ушла команда до подтверждения').toBe('');
    expect(declined.stdout).toContain('боевой системе');
    expect(declined.stdout).toContain('база «vydoh»');
    expect(declined.stdout).toContain('деньги заказчицы');

    const wrongWord = run([], 'yes\n');
    expect(wrongWord.status).not.toBe(0);
    expect(wrongWord.remote).toBe('');
  });

  it(
    'после «да» проходит сценарии 1 и 2, не трогая журнал апдейтов и не перезапуская бота',
    () => {
      const done = confirmed();

      expect(done.status, done.stdout + done.stderr).toBe(0);
      expect(sentMessageIds(done.remote)).toHaveLength(5);
      expect(done.remote, 'журнал дедупликации боевого бота чистится').not.toContain(
        'telegram_updates',
      );
      expect(done.remote, 'боевой бот перезапущен без --restart').not.toContain('restart');
      // Пропущенное названо рядом с числами, а не спрятано в них.
      expect(done.stdout).toContain('пропущено: сценарий 3');
    },
    SLOW,
  );

  it(
    'перезапускает бота только по --restart, один раз и после третьего сообщения',
    () => {
      const withRestart = run(['--restart'], 'да\n');

      expect(withRestart.status, withRestart.stdout + withRestart.stderr).toBe(0);
      expect(withRestart.stdout, 'о перезапуске не предупредили').toContain('ПЕРЕЗАПУСТИТ');

      const restarts = withRestart.remote.match(/restart bot/gu) ?? [];
      expect(restarts).toHaveLength(1);

      const ids = sentMessageIds(withRestart.remote);
      expect(ids).toHaveLength(6);
      const third = withRestart.remote.indexOf(`send-test-update.js 999000001 ${String(ids[5])} `);
      expect(withRestart.remote.indexOf('restart bot')).toBeGreaterThan(third);
      expect(withRestart.stdout).not.toContain('пропущено');
    },
    SLOW,
  );

  it(
    'два прогона не делят номера сообщений — дедупликации нечего отсекать',
    async () => {
      const first = confirmed();
      // Номера идут от секунды запуска; настоящий прогон длится минуты, а
      // здесь `sleep` подменён, и другую секунду надо дождаться честно.
      while (Math.floor(Date.now() / 1000) <= first.startedAtSec) await sleep(100);
      const second = run([], 'да\n');

      const firstIds = sentMessageIds(first.remote);
      const secondIds = sentMessageIds(second.remote);
      expect(firstIds).toHaveLength(5);
      expect(secondIds).toHaveLength(5);

      const overlap = firstIds.filter((id) => secondIds.includes(id));
      expect(overlap, 'повторный прогон отсёкся бы дедупликацией').toEqual([]);

      // Внутри прогона порядок сообщений — порядок номеров: склейка
      // разрешает ничью по времени именно номером.
      expect([...firstIds].sort((a, b) => a - b)).toEqual(firstIds);
    },
    SLOW,
  );

  it(
    'номера апдейтов теста недостижимы для счётчика Telegram',
    () => {
      for (const id of sentMessageIds(confirmed().remote)) {
        /**
         * Запись теста живёт в боевом `telegram_updates` сутки. Окажись её
         * номер тем, что Telegram выдаст настоящему апдейту, тот отсёкся
         * бы как повтор — человек потерял бы сообщение. Номера Bot API —
         * 32-битные, а счётчик растёт по единице на апдейт: за границей
         * int32 настоящих номеров не бывает.
         */
        expect(updateIdOf(id)).toBeGreaterThan(2 ** 31);
        expect(Number.isSafeInteger(updateIdOf(id))).toBe(true);
      }
    },
    SLOW,
  );

  it(
    'неудавшаяся уборка тестового человека не молчит',
    () => {
      const noisy = run([], 'да\n', { FAKE_SSH_FAIL_DELETE: '1' });

      expect(noisy.stderr).toContain(`tg_id=${String(CHAT_ID)}`);
      expect(noisy.stderr).toContain('уберите руками');
    },
    SLOW,
  );
});
