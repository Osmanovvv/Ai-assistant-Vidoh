import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Расписание берётся из репозитория, а не из чьей-то памяти.
 *
 * Ревизия этапов 1–2, молчаливый отказ. Файл `ops/cron/vydoh` лежал в
 * репозитории и доезжал выкладкой в `/opt/vydoh/ops/cron/vydoh`, но его
 * ничто не ставило и ни с чем не сверяло: слов `cron.d` не было ни в
 * `ops/`, ни в `Dockerfile`, ни в compose. Человек писал расписание руками
 * по прозе рантбука — и проза уже разошлась с файлом: обещала проверку
 * восстановления «по воскресеньям», тогда как файл гоняет её ежедневно, и
 * его же комментарий объясняет, почему недельная была ошибкой.
 *
 * Отсутствующее задание не даёт никакого сигнала: пропавший пульс выглядит
 * точно так же, как здоровый бот.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');

const deploy = readFileSync(resolve(root, 'ops/deploy.sh'), 'utf8');
const cron = readFileSync(resolve(root, 'ops/cron/vydoh'), 'utf8');
const runbook = readFileSync(resolve(root, 'docs/07-runbook.md'), 'utf8');

/** Скрипт без комментариев: ловушки тут принято описывать словами. */
const code = deploy
  .split('\n')
  .map((line) => line.replace(/(^|\s)#.*$/u, ''))
  .join('\n');

describe('выкладка ставит расписание', () => {
  it('файл из репозитория кладётся в /etc/cron.d', () => {
    expect(code, 'расписание снова никто не ставит').toContain('/etc/cron.d/vydoh');
    expect(code).toMatch(/install\s+-m\s+644/u);
  });

  it('и сверяется с тем, что встало', () => {
    /**
     * Cron молча игнорирует файл с чужими правами: «положили» и
     * «работает» — разные вещи, и узнать об этом иначе нельзя.
     */
    expect(code, 'встало ли расписание, никто не проверяет').toMatch(/cmp -s/u);
    expect(code).toContain('Расписание не встало');
  });

  it('в расписании три задания: пульс, копия, проверка восстановления', () => {
    // Число — не украшение: пропади строка пульса, и упавший бот перестал
    // бы о себе сообщать, а выглядело бы это как тишина здорового.
    const jobs = cron.split('\n').filter((line) => /^[\d*]/u.test(line.trim()));

    expect(jobs).toHaveLength(3);
    expect(cron).toContain('heartbeat.sh');
    expect(cron).toContain('backup.sh');
    expect(cron).toContain('restore-check.sh');
  });
});

describe('рантбук не переписывает расписание своими словами', () => {
  it('не обещает недельную проверку восстановления', () => {
    /**
     * Проза разошлась с файлом однажды и разойдётся снова: расписание
     * живёт в одном месте, и рантбук обязан отсылать к нему, а не хранить
     * копию.
     */
    expect(
      runbook.includes('по воскресеньям'),
      'рантбук снова обещает недельную проверку, а файл гоняет ежедневную',
    ).toBe(false);
  });

  it('ведёт к источнику расписания', () => {
    expect(runbook).toContain('/etc/cron.d/vydoh');
  });
});
