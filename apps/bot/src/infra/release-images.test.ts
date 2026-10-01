import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const image = `sha256:${'a'.repeat(64)}`;
const otherImage = `sha256:${'b'.repeat(64)}`;
const rollbackTag = `vydoh-bot:rollback-${'a'.repeat(64)}`;
const releaseTag = `vydoh-bot:release-${'a'.repeat(64)}`;
const posix = (path: string): string => path.replaceAll('\\', '/');
const unavailableReleaseEnvs: Record<string, string>[] = [
  { FAKE_CONTAINER: '' },
  { FAKE_STATE: 'restarting' },
  { FAKE_HEALTH: 'starting' },
];

function bashPath(): string {
  if (process.platform !== 'win32') return 'bash';
  const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  return resolve(execPath, '../../..', 'bin', 'bash.exe');
}

let fixture = '';

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'vydoh-release-images-'));
  mkdirSync(join(fixture, 'ops'));
  for (const script of ['preserve-image.sh', 'rollback.sh']) {
    writeFileSync(join(fixture, 'ops', script), readFileSync(join(root, 'ops', script)));
  }
  writeFileSync(join(fixture, 'docker-compose.prod.yml'), 'name: vydoh\nservices: {}\n');
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

/** Настоящие скрипты, но все обращения к Docker заменены функцией. */
function run(script: string, args: readonly string[], env: Record<string, string> = {}) {
  const calls = join(fixture, 'calls.txt');
  const tagged = join(fixture, 'tagged.txt');
  writeFileSync(calls, '');
  const driver = `
export PATH="/usr/bin:/bin:$PATH"
docker() {
  printf '%s\\n' "$*" >> "$FAKE_CALLS"
  case "$1 $2" in
    'compose -f')
      if [[ "$*" == *'ps -a -q bot' ]]; then
        printf '%s\\n' "$FAKE_CONTAINER"
      fi
      ;;
    'inspect --format')
      case "$3" in
        '{{.Image}}') printf '%s\\n' "$FAKE_IMAGE" ;;
        '{{.State.Status}}') printf '%s\\n' "$FAKE_STATE" ;;
        *) printf '%s\\n' "$FAKE_HEALTH" ;;
      esac
      ;;
    'image inspect')
      if [ -f "$FAKE_TAGGED" ]; then
        cat "$FAKE_TAGGED"
      elif [ -n "$FAKE_EXISTING" ]; then
        printf '%s\\n' "$FAKE_EXISTING"
      else
        return 1
      fi
      ;;
    'image tag') printf '%s\\n' "$3" > "$FAKE_TAGGED" ;;
    *) printf 'Неожиданная команда Docker\\n' >&2; return 90 ;;
  esac
}
export -f docker
exec bash "$@"
`;
  const result = spawnSync(
    bashPath(),
    ['-c', driver, 'release-test', posix(join(fixture, 'ops', script)), ...args],
    {
      timeout: 15_000,
      encoding: 'utf8',
      env: {
        ...process.env,
        VYDOH_DIR: posix(fixture),
        FAKE_CALLS: posix(calls),
        FAKE_TAGGED: posix(tagged),
        FAKE_CONTAINER: 'container-id',
        FAKE_IMAGE: image,
        FAKE_STATE: 'running',
        FAKE_HEALTH: 'healthy',
        FAKE_EXISTING: '',
        ...env,
      },
    },
  );
  expect(result.error, 'bash не запустился').toBeUndefined();
  return { ...result, calls: readFileSync(calls, 'utf8') };
}

describe('сохранение образов', { timeout: 30_000 }, () => {
  it('сохраняет ID запущенного контейнера, не копирует ярлык latest и не запускает сервисы', () => {
    const result = run('preserve-image.sh', []);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain(`image tag ${image} ${rollbackTag}`);
    expect(result.calls).not.toMatch(/latest|\bup\b|\bbuild\b|\brun\b/u);
    const record = readFileSync(
      join(fixture, '.data/releases', `rollback-${'a'.repeat(64)}.txt`),
      'utf8',
    );
    expect(record).toContain(`image_id=${image}`);
    expect(record).toContain('health=healthy');
  });

  it('уже сохранённый образ не перезаписывает', () => {
    const result = run('preserve-image.sh', ['rollback'], { FAKE_EXISTING: image });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).not.toContain('image tag');
  });

  it('при подменённой сохранённой метке отказывает без её перезаписи', () => {
    const result = run('preserve-image.sh', [], { FAKE_EXISTING: otherImage });
    expect(result.status).not.toBe(0);
    expect(result.calls).not.toContain('image tag');
    expect(existsSync(join(fixture, '.data/releases'))).toBe(false);
  });

  it('первая выкладка без прежнего контейнера остаётся возможной', () => {
    const result = run('preserve-image.sh', [], { FAKE_CONTAINER: '' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).not.toContain('image tag');
  });

  it.each(unavailableReleaseEnvs)(
    'неготовый контейнер не отмечает как успешный релиз: %j',
    (env) => {
      const result = run('preserve-image.sh', ['release'], env);
      expect(result.status).not.toBe(0);
      expect(result.calls).not.toContain('image tag');
    },
  );

  it('здоровый контейнер получает отдельную метку релиза', () => {
    const result = run('preserve-image.sh', ['release']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain(`image tag ${image} ${releaseTag}`);
  });
});

describe('возврат на сохранённый образ', { timeout: 30_000 }, () => {
  it('без --apply показывает план и ничего не создаёт или перезапускает', () => {
    const result = run('rollback.sh', [rollbackTag], { FAKE_EXISTING: image });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('План готов');
    expect(result.calls).not.toMatch(/\bcompose\b|\btag\b/u);
    expect(existsSync(join(fixture, '.data/releases'))).toBe(false);
  });

  it.each(['', 'vydoh-bot:latest', `${rollbackTag};echo unsafe`])(
    'не принимает произвольную метку: %s',
    (tag) => {
      const result = run('rollback.sh', [tag, '--apply'], { FAKE_EXISTING: image });
      expect(result.status).not.toBe(0);
      expect(result.calls).toBe('');
    },
  );

  it.each(['', otherImage])('без исходного образа возврат не запускает: %s', (existing) => {
    const result = run('rollback.sh', [rollbackTag, '--apply'], { FAKE_EXISTING: existing });
    expect(result.status).not.toBe(0);
    expect(result.calls).not.toContain('compose');
  });

  it('применение выбирает конкретный образ и запускает только bot без сборки и зависимостей', () => {
    const result = run('rollback.sh', [rollbackTag, '--apply'], { FAKE_EXISTING: image });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain('up -d --no-build --no-deps bot');
    expect(result.calls).not.toMatch(/\btag\b|\bmigrate\b|\bpostgres\b|\bredis\b|\bdown\b/u);
    const override = readFileSync(
      join(fixture, '.data/releases', `rollback-${'a'.repeat(64)}.yml`),
      'utf8',
    );
    expect(override).toBe(`services:\n  bot:\n    image: ${rollbackTag}\n`);
  });
});

it('выкладка сохраняет предыдущий образ до сборки, а релиз отмечает после проверок', () => {
  const deploy = readFileSync(join(root, 'ops/deploy.sh'), 'utf8');
  const preserve = deploy.indexOf('bash ops/preserve-image.sh rollback');
  const build = deploy.indexOf('$COMPOSE up -d --build');
  const ready = deploy.indexOf('say "Жду готовности бота"');
  const prompts = deploy.indexOf('dist/scripts/check-prompts.js');
  const release = deploy.indexOf('bash ops/preserve-image.sh release');
  expect(preserve).toBeGreaterThan(-1);
  expect(build).toBeGreaterThan(preserve);
  expect(ready).toBeGreaterThan(build);
  expect(release).toBeGreaterThan(ready);
  expect(release).toBeGreaterThan(prompts);
});
