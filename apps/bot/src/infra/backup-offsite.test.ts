import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Копия базы уезжает с сервера — или скрипт говорит, что не уехала
 * (задача 1.22; ревизия этапов 1–2, дефект 22).
 *
 * План 1.22 обещал «хранение в объектном хранилище в РФ», шапка
 * `backup.sh` утверждала это как сделанное, а на деле дамп ложился в
 * `/var/backups` на ту же машину, где живёт база, и скрипт называл эту
 * папку «хранилищем». От единственного риска, ради которого копии и
 * делают, — потеря машины, — не защищало ничто, и ни один документ не
 * говорил, что так решено.
 *
 * Страж гоняет настоящий `ops/backup.sh` настоящим bash, подменив через
 * PATH только `pg_dump` (отдаёт заготовленные байты) и `rclone` (remote
 * `offsite:` отображается на папку, команды пишутся в журнал). Шифрует
 * настоящий gpg. Проверяется не текст скрипта, а что оказалось в
 * «хранилище» и с каким кодом скрипт вышел.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const backupScript = resolve(root, 'ops/backup.sh').replaceAll('\\', '/');
const docsScript = resolve(root, 'ops/backup-docs.sh').replaceAll('\\', '/');
const offsiteScript = resolve(root, 'ops/offsite.sh').replaceAll('\\', '/');

const FAKE_PG_DUMP = `#!/usr/bin/env bash
printf 'FAKE DUMP OF %s\\n' "$*"
head -c 3000 /dev/zero | tr '\\0' 'x'
`;

/**
 * Поддельный rclone. Remote `offsite:путь` — это папка
 * `$FAKE_REMOTE_ROOT/путь`; всё остальное считается путём на диске, как и
 * у настоящего rclone. Каждый вызов пишется в журнал. По просьбе теста
 * отказывает (FAKE_RCLONE_FAIL) или кладёт обрезанный файл, отчитавшись
 * успехом (FAKE_RCLONE_TRUNCATE), — так проверяется, что скрипт верит не
 * слову «выгружено», а размеру в хранилище.
 */
const FAKE_RCLONE = `#!/usr/bin/env bash
printf 'rclone %s\\n' "$*" >> "$FAKE_LOG"
if [ -n "\${FAKE_RCLONE_FAIL:-}" ]; then
  echo "fake rclone: отказ по просьбе теста" >&2
  exit 1
fi
format=""; minage=""; include=""; pos=()
while [ $# -gt 0 ]; do
  case "$1" in
    --format) format="$2"; shift 2 ;;
    --min-age) minage="$2"; shift 2 ;;
    --include) include="$2"; shift 2 ;;
    --files-only) shift ;;
    *) pos+=("$1"); shift ;;
  esac
done
map() {
  case "$1" in
    offsite:*) printf '%s/%s' "$FAKE_REMOTE_ROOT" "\${1#offsite:}" ;;
    *) printf '%s' "$1" ;;
  esac
}
case "\${pos[0]}" in
  copy)
    dst="$(map "\${pos[2]}")"
    mkdir -p "$dst"
    if [ -n "\${FAKE_RCLONE_TRUNCATE:-}" ]; then
      head -c 10 "\${pos[1]}" > "$dst/$(basename "\${pos[1]}")"
    else
      cp "\${pos[1]}" "$dst/"
    fi ;;
  lsf)
    target="$(map "\${pos[1]}")"
    if [ "$format" = "s" ]; then
      [ -f "$target" ] || { echo "fake rclone: нет $target" >&2; exit 3; }
      wc -c < "$target" | tr -d ' '
    else
      [ -z "\${FAKE_RCLONE_FAIL_LIST:-}" ] || { echo "fake rclone: перечень отказал по просьбе теста" >&2; exit 1; }
      [ -d "$target" ] || { echo "fake rclone: нет папки $target" >&2; exit 3; }
      find "$target" -maxdepth 1 -type f -name "\${include:-*}" -exec basename {} \\;
    fi ;;
  delete)
    target="$(map "\${pos[1]}")"
    find "$target" -maxdepth 1 -type f -name "\${include:-*}" -mtime "+\${minage%d}" -delete ;;
  *) echo "fake rclone: неизвестная команда \${pos[0]}" >&2; exit 2 ;;
esac
`;

/**
 * Поддельные ssh и scp для backup-docs.sh: пишут команду в тот же журнал.
 * На запрос парольной фразы отвечают словом, на подсчёт копий — числом,
 * выгрузку в хранилище по просьбе теста проваливают.
 */
const FAKE_SSH = `#!/usr/bin/env bash
cmd="\${@: -1}"
printf 'ssh %s\\n' "$cmd" >> "$FAKE_LOG"
case "$cmd" in
  *BACKUP_ENCRYPTION_PASSPHRASE*) echo "фраза-для-теста" ;;
  *"wc -l"*) echo 2 ;;
  *offsite.sh*) [ -z "\${FAKE_SSH_FAIL_OFFSITE:-}" ] || { echo "offsite отказал" >&2; exit 1; } ;;
esac
`;

const FAKE_SCP = `#!/usr/bin/env bash
printf 'scp %s\\n' "$*" >> "$FAKE_LOG"
`;

/** Настоящий bash и gpg: секунды на прогон. */
const SLOW = 60_000;

let fakeDir = '';
let runs = 0;

beforeAll(() => {
  fakeDir = mkdtempSync(join(tmpdir(), 'vydoh-backup-offsite-'));
  writeFileSync(join(fakeDir, 'pg_dump'), FAKE_PG_DUMP, { mode: 0o755 });
  writeFileSync(join(fakeDir, 'rclone'), FAKE_RCLONE, { mode: 0o755 });
  writeFileSync(join(fakeDir, 'ssh'), FAKE_SSH, { mode: 0o755 });
  writeFileSync(join(fakeDir, 'scp'), FAKE_SCP, { mode: 0o755 });
});

afterAll(() => {
  rmSync(fakeDir, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Вызовы rclone, ssh и scp в порядке отправки. */
  readonly calls: string;
  /** Папка копий на «сервере». */
  readonly backupDir: string;
  /** Папка, в которую отображается remote `offsite:`. */
  readonly remoteRoot: string;
}

interface RunOptions {
  readonly cwd?: string;
  readonly args?: readonly string[];
  /** Папки, которые в «хранилище» есть ещё до запуска. */
  readonly remoteDirs?: readonly string[];
}

function run(script: string, extraEnv: Record<string, string>, opts: RunOptions = {}): Run {
  runs += 1;
  const work = join(fakeDir, `run-${String(runs)}`);
  const backupDir = join(work, 'backups');
  const remoteRoot = join(work, 'remote');
  mkdirSync(backupDir, { recursive: true });
  mkdirSync(remoteRoot, { recursive: true });
  for (const dir of opts.remoteDirs ?? []) mkdirSync(join(remoteRoot, dir), { recursive: true });
  const log = join(work, 'calls.log');

  // На Windows переменная зовётся Path, и node подставит именно её.
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [pathKey]: `${fakeDir}${delimiter}${process.env[pathKey] ?? ''}`,
    FAKE_LOG: log.replaceAll('\\', '/'),
    FAKE_REMOTE_ROOT: remoteRoot.replaceAll('\\', '/'),
    DATABASE_URL: 'postgres://vydoh:vydoh@localhost:5432/vydoh',
    BACKUP_DIR: backupDir.replaceAll('\\', '/'),
    BACKUP_ENCRYPTION_PASSPHRASE: 'фраза-для-теста',
    BACKUP_KEEP_DAYS: '14',
  };
  // Без чата мониторинга оповещение уходит в stderr — там его и читаем.
  // Хранилище задаёт только сам тест, а не окружение машины.
  delete env['MONITORING_BOT_TOKEN'];
  delete env['MONITORING_CHAT_ID'];
  delete env['BACKUP_REMOTE'];
  Object.assign(env, extraEnv);

  const result = spawnSync('bash', [script, ...(opts.args ?? [])], {
    env,
    encoding: 'utf8',
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
  });
  if (result.error !== undefined) throw result.error;

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls: existsSync(log) ? readFileSync(log, 'utf8') : '',
    backupDir,
    remoteRoot,
  };
}

function localCopies(backupDir: string): string[] {
  return readdirSync(backupDir).filter((name) => /^vydoh-.*\.dump\.gpg$/u.test(name));
}

describe('копия базы и хранилище вне сервера', () => {
  it(
    'без BACKUP_REMOTE копия снимается на диск, но скрипт отказывает и говорит, что она осталась на сервере',
    () => {
      const r = run(backupScript, {});

      // Сначала копия, потом претензии: локальная копия и тревога лучше,
      // чем ни того ни другого.
      expect(localCopies(r.backupDir), 'локальная копия не снята').toHaveLength(1);
      expect(r.status, r.stdout + r.stderr).not.toBe(0);
      expect(r.stderr).toContain('BACKUP_REMOTE');
      expect(r.stderr).toContain('на том же сервере');
      // Оповещение §18 ушло (в stderr, раз чата нет), а не только строка в журнале.
      expect(r.stderr).toContain('Оповещение');
      expect(r.calls, 'rclone звали без настроенного хранилища').not.toContain('rclone');
      expect(r.stdout, 'локальная папка снова названа хранилищем').not.toContain(
        'Копий в хранилище',
      );
    },
    SLOW,
  );

  it(
    'BACKUP_REMOTE=local — осознанный отказ от хранилища: копия остаётся, код 0, об этом сказано',
    () => {
      const r = run(backupScript, { BACKUP_REMOTE: 'local' });

      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(localCopies(r.backupDir)).toHaveLength(1);
      expect(r.stdout).toContain('BACKUP_REMOTE=local');
      expect(r.stdout).toContain('риск');
      expect(r.calls).not.toContain('rclone');
    },
    SLOW,
  );

  it(
    'с remote rclone копия уезжает байт в байт, старые копии в хранилище убираются, чужие файлы — нет',
    () => {
      const work = join(fakeDir, `run-${String(runs + 1)}`);
      const remoteDir = join(work, 'remote', 'vydoh', 'base');
      mkdirSync(remoteDir, { recursive: true });
      const old = join(remoteDir, 'vydoh-20260801T000000Z.dump.gpg');
      const foreign = join(remoteDir, 'other.txt');
      writeFileSync(old, 'старая копия');
      writeFileSync(foreign, 'чужой файл');
      const twentyDaysAgo = new Date(Date.now() - 20 * 86_400_000);
      utimesSync(old, twentyDaysAgo, twentyDaysAgo);
      utimesSync(foreign, twentyDaysAgo, twentyDaysAgo);

      const r = run(backupScript, { BACKUP_REMOTE: 'offsite:vydoh/base' });

      expect(r.status, r.stdout + r.stderr).toBe(0);
      const [name] = localCopies(r.backupDir);
      expect(name).toBeDefined();
      const remoteCopy = join(remoteDir, name ?? '');
      expect(existsSync(remoteCopy), 'копии нет в хранилище').toBe(true);
      expect(readFileSync(remoteCopy)).toEqual(readFileSync(join(r.backupDir, name ?? '')));

      expect(existsSync(old), 'старая копия в хранилище не убрана').toBe(false);
      expect(existsSync(foreign), 'ротация тронула чужой файл').toBe(true);
      expect(r.stdout).toContain('Выгружено в offsite:vydoh/base');
      expect(r.stdout).toContain('Копий в хранилище offsite:vydoh/base: 1');
      expect(r.stdout).toContain('Копий на сервере: 1');
    },
    SLOW,
  );

  it(
    'путь на диске вместо remote — отказ до вызова rclone: иначе копия легла бы на тот же сервер',
    () => {
      const r = run(backupScript, { BACKUP_REMOTE: '/var/backups/vydoh-offsite' });

      expect(localCopies(r.backupDir)).toHaveLength(1);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('/var/backups/vydoh-offsite');
      expect(r.stderr).toContain('на диске');
      expect(r.calls).not.toContain('rclone');
    },
    SLOW,
  );

  it(
    'отказ выгрузки — не молчание: копия на диске есть, код не ноль, названо хранилище',
    () => {
      const r = run(backupScript, { BACKUP_REMOTE: 'offsite:vydoh/base', FAKE_RCLONE_FAIL: '1' });

      expect(localCopies(r.backupDir)).toHaveLength(1);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('offsite:vydoh/base');
      expect(r.stderr).toContain('не удалась');
      expect(r.stderr).toContain('Оповещение');
    },
    SLOW,
  );

  it(
    'слову «выгружено» не верит: обрезанная копия в хранилище — отказ по размеру',
    () => {
      const r = run(backupScript, {
        BACKUP_REMOTE: 'offsite:vydoh/base',
        FAKE_RCLONE_TRUNCATE: '1',
      });

      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('размер');
      expect(r.stderr).toContain('Оповещение');
      expect(r.stdout).not.toContain('Выгружено');
    },
    SLOW,
  );
});

describe('копия документации тоже уезжает с сервера', () => {
  it(
    'после scp на сервер зовёт offsite.sh с настройками из backup.env сервера — и убирает старые',
    () => {
      const cwd = join(fakeDir, 'docs-root');
      mkdirSync(join(cwd, 'docs'), { recursive: true });
      writeFileSync(join(cwd, 'docs', 'readme.md'), '# документ\n');

      const r = run(docsScript, { VYDOH_HOST: 'vydoh-test' }, { cwd });

      expect(r.status, r.stdout + r.stderr).toBe(0);
      const scpAt = r.calls.indexOf('scp ');
      const putAt = r.calls.indexOf('offsite.sh');
      expect(scpAt, 'копия на сервер не отправлена').toBeGreaterThanOrEqual(0);
      expect(putAt, 'в хранилище копию не отправили').toBeGreaterThan(scpAt);

      const offsiteCall = r.calls.split('\n').find((line) => line.includes('offsite.sh')) ?? '';
      // Доступы к хранилищу живут только на сервере, как и парольная фраза.
      expect(offsiteCall).toContain('/opt/vydoh/backup.env');
      expect(offsiteCall).toMatch(/offsite\.sh'? put/u);
      expect(offsiteCall).toContain('/var/backups/vydoh-docs/docs-');
      expect(offsiteCall).toMatch(/offsite\.sh'? prune/u);
      expect(offsiteCall).toContain('docs-*.tar.gz.gpg');
      expect(offsiteCall).toContain('14');
    },
    SLOW,
  );

  it(
    'offsite.sh, который сервер получит по ssh, работает и сам по себе: put кладёт, prune считает',
    () => {
      const work = join(fakeDir, 'offsite-direct');
      mkdirSync(work, { recursive: true });
      const archive = join(work, 'docs-20260911T000000Z.tar.gz.gpg');
      writeFileSync(archive, 'архив документации');

      const put = run(
        offsiteScript,
        { BACKUP_REMOTE: 'offsite:docs' },
        { args: ['put', 'копия документации', archive.replaceAll('\\', '/')] },
      );
      expect(put.status, put.stdout + put.stderr).toBe(0);
      expect(
        readFileSync(join(put.remoteRoot, 'docs', 'docs-20260911T000000Z.tar.gz.gpg')),
      ).toEqual(readFileSync(archive));

      // Уборка прошла, а перечень не удался: это отказ, а не «ноль копий» —
      // ноль вместо «не смогли» та же ложь, что и молчание.
      const pruneArgs = ['prune', 'копия документации', 'docs-*.tar.gz.gpg', '14'];
      const noList = run(
        offsiteScript,
        { BACKUP_REMOTE: 'offsite:docs', FAKE_RCLONE_FAIL_LIST: '1' },
        { args: pruneArgs, remoteDirs: ['docs'] },
      );
      expect(noList.status, 'неудавшийся перечень хранилища сошёл за пустой').not.toBe(0);
      expect(noList.stdout).not.toContain('Копий в хранилище');
      expect(noList.stderr).toContain('перечислить');

      const empty = run(
        offsiteScript,
        { BACKUP_REMOTE: 'offsite:docs' },
        { args: pruneArgs, remoteDirs: ['docs'] },
      );
      expect(empty.status, empty.stdout + empty.stderr).toBe(0);
      expect(empty.stdout).toContain('Копий в хранилище offsite:docs: 0');

      const usage = run(offsiteScript, { BACKUP_REMOTE: 'offsite:docs' }, { args: ['put'] });
      expect(usage.status).toBe(2);
    },
    SLOW,
  );

  it(
    'отказ выгрузки в хранилище — отказ всей копии, с оповещением',
    () => {
      const cwd = join(fakeDir, 'docs-root-fail');
      mkdirSync(join(cwd, 'docs'), { recursive: true });
      writeFileSync(join(cwd, 'docs', 'readme.md'), '# документ\n');

      const r = run(docsScript, { VYDOH_HOST: 'vydoh-test', FAKE_SSH_FAIL_OFFSITE: '1' }, { cwd });

      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('копия документации');
      expect(r.stderr).toContain('Оповещение');
    },
    SLOW,
  );
});
