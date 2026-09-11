import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Диагностика упавшей выкладки показывает причину, а не старый хвост.
 *
 * Ревизия этапов 1–2. Когда бот не дождался готовности, выкладка печатала
 * сорок строк `logs/vydoh.log`, а вывод контейнера — только если файл не
 * прочитался. Но самый частый провал старта — отказ конфигурации:
 * `getEnv()` бросает до создания логгера, сообщение уходит в stderr
 * контейнера, а в файл не попадает ни строки. Файл при этом есть, и
 * выкладка показывала сорок бодрых строк предыдущего, здорового прогона.
 * Человек читал их и причины не видел нигде. То же в петле перезапусков:
 * цикл досиживал три минуты и печатал тот же устаревший хвост.
 *
 * Проверяется **поведением**: из `ops/deploy.sh` берётся настоящий блок
 * ожидания и запускается так же, как на сервере, — `bash -s` со
 * стандартного ввода, — только `docker` и `sleep` подменены функциями.
 * Сценарии задают, что говорит docker о контейнере и что лежит в его
 * выводе, а в файле журнала — заведомо старые строки.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const deploy = readFileSync(resolve(root, 'ops/deploy.sh'), 'utf8');

const SSH_LINE = 'ssh $SSH_OPTS "$HOST" "bash -s" <<REMOTE';

/** Блок ожидания готовности — от заголовка до конца heredoc, как есть. */
function readinessBlock(): string {
  const start = deploy.indexOf('say "Жду готовности бота"');
  const from = deploy.indexOf(SSH_LINE, start);
  const end = deploy.indexOf('\nREMOTE\n', from);

  expect(start, 'в выкладке нет шага ожидания готовности').toBeGreaterThan(-1);
  expect(from, 'шаг ожидания больше не идёт через bash -s').toBeGreaterThan(start);
  expect(end, 'heredoc ожидания не закрыт').toBeGreaterThan(from);

  return deploy.slice(from, end + '\nREMOTE\n'.length);
}

/**
 * Git Bash, а не то, что лежит в PATH под именем `bash`: на Windows это
 * подсистема Linux, которой на машине может не быть вовсе.
 */
function bashPath(): string {
  if (process.platform !== 'win32') return 'bash';

  // C:/Program Files/Git/mingw64/libexec/git-core → C:/Program Files/Git/bin/bash.exe
  const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  return resolve(execPath, '../../..', 'bin', 'bash.exe');
}

const posix = (path: string): string => path.replaceAll('\\', '/');

interface Scenario {
  /** Идентификатор контейнера; пустой — контейнера нет. */
  readonly container: string;
  readonly status: string;
  readonly health: string;
  readonly restarts: number;
  readonly exitCode: number;
  /** Что показывает `docker compose logs` — вывод контейнера этого запуска. */
  readonly containerOutput: string;
}

interface Outcome {
  readonly status: number;
  readonly stderr: string;
  readonly calls: string;
}

const STALE_LINE = '{"level":30,"msg":"Бот инициализирован","time":"вчера"}';
const STALE_TAIL = Array.from({ length: 60 }, () => STALE_LINE).join('\n');

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vydoh-deploy-'));
  mkdirSync(join(dir, 'logs'));
  // Файл журнала есть и полон — строками прошлого, здорового прогона.
  writeFileSync(join(dir, 'logs', 'vydoh.log'), `${STALE_TAIL}\n`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(scenario: Scenario): Outcome {
  const calls = join(dir, 'calls.txt');
  const output = join(dir, 'container.log');
  writeFileSync(output, scenario.containerOutput);
  writeFileSync(calls, '');

  /**
   * Подделка docker отвечает на то, что спрашивает выкладка: список
   * контейнеров службы, их состояние по шаблону, вывод. Шаблон
   * подставляется по полям, которые выкладка вправе спросить; остальное
   * — ошибка, как у настоящего docker на незнакомом поле.
   */
  const wrapper = `
docker() {
  printf '%s\\n' "docker $*" >> "$CALLS"
  case "$*" in
    "compose -f docker-compose.prod.yml ps "*)
      printf '%s\\n' "$FAKE_CONTAINER" ;;
    "compose -f docker-compose.prod.yml logs "*)
      cat "$FAKE_OUTPUT" ;;
    inspect*)
      shift
      local fmt=""
      if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi
      [ $# -gt 0 ] || { echo 'Error: "docker inspect" requires at least 1 argument' >&2; return 1; }
      fmt="\${fmt//"{{.State.Health.Status}}"/$FAKE_HEALTH}"
      fmt="\${fmt//"{{.State.Status}}"/$FAKE_STATUS}"
      fmt="\${fmt//"{{.RestartCount}}"/$FAKE_RESTARTS}"
      fmt="\${fmt//"{{.State.ExitCode}}"/$FAKE_EXIT}"
      case "$fmt" in
        *"{{"*) echo "Error: неизвестное поле в шаблоне: $fmt" >&2; return 1 ;;
      esac
      printf '%s\\n' "$fmt" ;;
    *)
      echo "Error: подделка docker не знает: $*" >&2; return 1 ;;
  esac
}
sleep() { :; }
export -f docker sleep

COMPOSE="docker compose -f docker-compose.prod.yml"
REMOTE_DIR="${posix(dir)}"
${readinessBlock().replace(SSH_LINE, '"$BASH" -s <<REMOTE')}
`;

  const script = join(dir, 'wait.sh');
  writeFileSync(script, wrapper);

  const result = spawnSync(bashPath(), [posix(script)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CALLS: posix(calls),
      FAKE_CONTAINER: scenario.container,
      FAKE_OUTPUT: posix(output),
      FAKE_STATUS: scenario.status,
      FAKE_HEALTH: scenario.health,
      FAKE_RESTARTS: String(scenario.restarts),
      FAKE_EXIT: String(scenario.exitCode),
    },
  });

  expect(result.error, 'bash не запустился').toBeUndefined();

  return {
    status: result.status ?? -1,
    stderr: result.stderr,
    calls: readFileSync(calls, 'utf8'),
  };
}

const CONFIG_FAILURE = [
  'file:///app/apps/bot/dist/config/env.js:525',
  '    throw new EnvValidationError(issues);',
  'EnvValidationError: Некорректная конфигурация окружения:',
  '  DATABASE_URL: Invalid URL',
].join('\n');

/**
 * Цикл ожидания настоящий — девяносто оборотов, по два `$(…)` в каждом, —
 * а на Windows каждая подстановка команды это fork MSYS. В одиночку
 * сценарий идёт две секунды, под полным прогоном — шесть.
 */
const SLOW_FORKS_MS = 60_000;

describe('выкладка, не дождавшись бота, показывает причину', { timeout: SLOW_FORKS_MS }, () => {
  it('отказ конфигурации виден, хотя в файле журнала его нет', () => {
    /**
     * Самый частый провал: бросок до логгера, stderr контейнера, петля
     * перезапусков. В файле — только вчерашнее.
     */
    const outcome = run({
      container: 'abc123',
      status: 'restarting',
      health: 'starting',
      restarts: 5,
      exitCode: 1,
      containerOutput: `${CONFIG_FAILURE}\n`,
    });

    expect(outcome.status).toBe(1);
    expect(outcome.stderr, 'причина из вывода контейнера не напечатана').toContain(
      'Некорректная конфигурация окружения',
    );
    expect(outcome.stderr, 'напечатан хвост прошлого прогона вместо причины').not.toContain(
      'Бот инициализирован',
    );

    // Петля названа петлёй: состояние, число перезапусков, код выхода.
    expect(outcome.stderr).toContain('restarting');
    expect(outcome.stderr, 'число перезапусков не напечатано').toMatch(/перезапусков:\s*5/u);
    expect(outcome.stderr, 'код выхода не напечатан').toMatch(/код выхода:\s*1/u);
  });

  it('живой, но не готовый бот: две его строки — правда, а не нехватка журнала', () => {
    /**
     * 05.09.2026: getMe отвечал 104 секунды, свежий контейнер сказал две
     * строки и ждал. Выкладка показала их — и это прочли как «в docker
     * logs ничего нет», хотя это и была вся правда о запуске.
     */
    const outcome = run({
      container: 'abc123',
      status: 'running',
      health: 'starting',
      restarts: 0,
      exitCode: 0,
      containerOutput:
        '{"level":40,"msg":"PRIVACY_POLICY_URL заглушка"}\n{"level":30,"msg":"Postgres и Redis отвечают"}\n',
    });

    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain('Postgres и Redis отвечают');
    expect(outcome.stderr).toMatch(/перезапусков:\s*0/u);
    expect(outcome.stderr, 'к двум строкам примешан хвост прошлого прогона').not.toContain(
      'Бот инициализирован',
    );
  });

  it('контейнера нет — сказано прямо, и вывод всё равно запрошен', () => {
    /**
     * `set -e` в удалённом блоке: отказ `docker inspect` на пустом списке
     * не должен обрывать диагностику до того, как она что-то показала.
     */
    const outcome = run({
      container: '',
      status: '',
      health: '',
      restarts: 0,
      exitCode: 0,
      containerOutput: '',
    });

    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toMatch(/контейнера bot нет/u);
    expect(outcome.calls, 'вывод контейнера не запрошен').toMatch(/logs --tail \d+ bot/u);
    expect(outcome.stderr).not.toContain('Бот инициализирован');
  });

  it('здоровый бот проходит, как прежде', () => {
    // Не страж дефекта, а доказательство, что стенд гоняет настоящий цикл.
    const outcome = run({
      container: 'abc123',
      status: 'running',
      health: 'healthy',
      restarts: 0,
      exitCode: 0,
      containerOutput: '',
    });

    expect(outcome.status).toBe(0);
    expect(outcome.calls).not.toMatch(/logs --tail/u);
  });
});
