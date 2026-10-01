import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const archiveScript = resolve(root, 'ops/deploy-archive.sh');
const posix = (path: string): string => path.replaceAll('\\', '/');

function bashPath(): string {
  if (process.platform !== 'win32') return 'bash';

  const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  return resolve(execPath, '../../..', 'bin', 'bash.exe');
}

/** Только упаковщик и чтение tar: deploy.sh, SSH и Docker здесь не запускаются. */
function shell(args: readonly string[]) {
  return spawnSync(
    bashPath(),
    ['-c', 'export PATH="/usr/bin:/bin:$PATH"; exec "$@"', 'deploy-archive-test', ...args],
    { timeout: 15_000, maxBuffer: 32 * 1024 * 1024 },
  );
}

const PUBLIC_FILES = [
  'Dockerfile',
  '.dockerignore',
  'docker-compose.prod.yml',
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
  'apps/bot/package.json',
  'apps/bot/tsconfig.json',
  'apps/bot/tsconfig.build.json',
  'apps/bot/src/index.ts',
  'apps/bot/src/new-handler.ts',
  'apps/bot/drizzle/0001.sql',
  'apps/bot/assets/brand.svg',
  'apps/admin/package.json',
  'apps/admin/tsconfig.json',
  'apps/admin/vite.config.ts',
  'apps/admin/index.html',
  'apps/admin/src/App.tsx',
  'ops/caddy/Caddyfile',
  'ops/caddy/Caddyfile.selfsigned',
  'ops/cron/vydoh',
  'ops/logrotate/vydoh',
  'ops/seed-prompts.sh',
  'ops/backup.sh',
  'ops/preserve-image.sh',
  'ops/rollback.sh',
];

const PRIVATE_FILES = [
  '.env',
  '.env.local',
  '.data/visual/session.json',
  '.claude/settings.local.json',
  'docs/25-peredacha-zakazchice.md',
  'docs/prompts/router.md',
  'docs/eval/private-case.json',
  'docs-backup-2026-10-02.zip',
  'secrets/yandex-sa-key.json',
  'playwright-report/index.html',
  'test-results/trace.zip',
  'unknown-local-file.json',
  'apps/bot/node_modules/example/index.js',
  'apps/bot/dist/index.js',
  'apps/bot/src/.env.local',
  'apps/bot/src/.npmrc',
  'apps/bot/src/secrets/account.json',
  'apps/bot/src/docs/private.md',
  'apps/bot/src/.data/session.json',
  'apps/admin/dist/index.html',
  'apps/admin/src/.claude/settings.local.json',
  'ops/caddy/certs/webhook.pem',
  'ops/caddy/certs/webhook.key',
  'ops/backup.env',
  'ops/backup.env.old',
  'ops/backups/database.sql',
  'ops/logs/bot.log',
  'ops/account.p12',
  'ops/account.pfx',
  'ops/database.dump',
  'ops/database.backup',
  'ops/settings.bak',
  'ops/docs.zip',
  'ops/docs.tar',
  'ops/docs.tar.gz',
  'ops/docs.tgz',
  'ops/docs.sql.gz',
  'ops/docs.tar.bz2',
  'ops/docs.tar.xz',
  'ops/docs.tar.zst',
  'ops/docs.7z',
  'ops/docs.rar',
];

let fixture = '';

function put(path: string, contents: string): void {
  const fullPath = join(fixture, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'vydoh-deploy-archive-'));
  for (const path of PUBLIC_FILES) put(path, 'public-file\n');
  for (const path of PRIVATE_FILES) put(path, 'fake-private-test-marker\n');
  put('ops/deploy-archive.sh', readFileSync(archiveScript, 'utf8'));
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

function members(script: string): readonly string[] {
  const packed = shell(['bash', posix(script)]);
  expect(packed.error, 'упаковщик не запустился').toBeUndefined();
  expect(packed.status, packed.stderr.toString('utf8')).toBe(0);

  const archive = join(fixture, 'checked.tar.gz');
  writeFileSync(archive, packed.stdout);
  // GNU tar иначе считает двоеточие диска Windows адресом удалённого архива.
  const listed = shell(['tar', '--force-local', '-tzf', posix(archive)]);
  expect(listed.error, 'tar не запустился').toBeUndefined();
  expect(listed.status, listed.stderr.toString('utf8')).toBe(0);

  return listed.stdout
    .toString('utf8')
    .trim()
    .split('\n')
    .map((path) => path.replace(/^\.\//u, '').replace(/\/$/u, ''));
}

describe('архив выкладки', { timeout: 30_000 }, () => {
  it('сохраняет код, миграции, бренд и конфигурацию, включая новые локальные файлы', () => {
    const found = members(join(fixture, 'ops/deploy-archive.sh'));

    for (const path of PUBLIC_FILES) expect(found, path).toContain(path);
    expect(found).toContain('ops/deploy-archive.sh');
  });

  it('исключает документы, доступы и артефакты также внутри каталогов приложения', () => {
    const found = members(join(fixture, 'ops/deploy-archive.sh'));

    for (const path of PRIVATE_FILES) expect(found, path).not.toContain(path);
  });

  it('при неполном комплекте отказывает до записи частичного архива', () => {
    rmSync(join(fixture, 'Dockerfile'));
    const packed = shell(['bash', posix(join(fixture, 'ops/deploy-archive.sh'))]);

    expect(packed.error).toBeUndefined();
    expect(packed.status).not.toBe(0);
    expect(packed.stdout.length).toBe(0);
    expect(packed.stderr.toString('utf8')).toContain('Dockerfile');
  });

  it('настоящий проект содержит входы Dockerfile и конфигурацию служб', () => {
    const found = members(archiveScript);
    const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
    const copies = [...dockerfile.matchAll(/^COPY (?!.*--from=)(.+?)\s+\S+\s*$/gmu)];
    expect(copies.length).toBeGreaterThan(0);

    for (const copy of copies) {
      for (const input of (copy[1] ?? '').split(/\s+/u)) expect(found, input).toContain(input);
    }
    for (const path of [
      'docker-compose.prod.yml',
      'apps/bot/tsconfig.json',
      'apps/bot/tsconfig.build.json',
      'apps/admin/tsconfig.json',
      'apps/admin/vite.config.ts',
      'apps/admin/index.html',
      'apps/bot/src/test/database-safety.ts',
      'ops/caddy/Caddyfile',
      'ops/caddy/Caddyfile.selfsigned',
      'ops/cron/vydoh',
      'ops/logrotate/vydoh',
      'ops/seed-prompts.sh',
      'ops/preserve-image.sh',
      'ops/rollback.sh',
    ]) {
      expect(found, path).toContain(path);
    }
  });

  it('выкладка использует тот же проверяемый упаковщик', () => {
    const deploy = readFileSync(resolve(root, 'ops/deploy.sh'), 'utf8');

    expect(deploy).toContain('if bash ops/deploy-archive.sh');
  });
});
