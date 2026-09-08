import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEvalRunner, type EvalRunner, type EvalRunState } from './eval-run.js';

/**
 * Кнопка прогона контрольного набора (§15, задача 4.8).
 *
 * **Каждый прогон стоит денег** — он ходит к живой модели по всему
 * набору. 05.09.2026 у продукта именно на таких прогонах кончился грант
 * Yandex. Поэтому проверяется не «кнопка нажимается», а «второй счёт не
 * выставляется» и «меряется то, что просили».
 *
 * Настоящий прогон здесь не запускается: подменяется команда.
 */

/**
 * Команда, которая печатает свои аргументы и завершается.
 *
 * Без пробелов и кавычек внутри: на Windows дочерний процесс
 * запускается через оболочку, и кавычки до него не доезжают. Аргументы
 * печатаются через запятую — так одинаково на всех системах.
 */
const ECHO = [
  process.execPath,
  '-e',
  'process.stdout.write(String(process.argv.slice(1)))',
  'прогон',
] as const;

/** Аргументы, с которыми запустился прогон. */
function argsOf(state: EvalRunState): readonly string[] {
  return state.kind === 'finished' ? state.tail.split(',') : [];
}

/** Команда, которая заканчивается отказом. */
const FAIL = [process.execPath, '-e', 'process.exit(1)'] as const;

/** Ждёт, пока прогон закончится. Без опроса тут никак: процесс внешний. */
async function finished(runner: EvalRunner): Promise<EvalRunState> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = runner.state();
    if (state.kind === 'finished') return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('прогон не завершился за пять секунд');
}

describe('прогон по кнопке', () => {
  it('пока прогон идёт, второй не запускается', async () => {
    /**
     * Главное здесь. Вторая кнопка, нажатая от нетерпения, — это второй
     * счёт за ту же работу.
     */
    const runner = createEvalRunner({ evalDir: 'н', command: ECHO });

    expect(runner.start()).toBe(true);
    expect(runner.start()).toBe(false);
    expect(runner.state().kind).toBe('running');

    await finished(runner);

    // А после завершения — можно снова.
    expect(runner.start()).toBe(true);
  });

  it('вывод прогона сохраняется, чтобы человек увидел итог', async () => {
    const runner = createEvalRunner({ evalDir: 'н', command: ECHO });
    runner.start();

    const state = await finished(runner);

    expect(state.kind === 'finished' ? state.tail : '').toContain('прогон');
    expect(state.kind === 'finished' ? state.ok : false).toBe(true);
  });

  it('отказ прогона виден как отказ, а не как успех', async () => {
    // Прогон сам решает, прошёл порог или нет, и говорит это кодом
    // возврата. Считать любое завершение успехом значило бы снять заслон.
    const runner = createEvalRunner({ evalDir: 'н', command: FAIL });
    runner.start();

    const state = await finished(runner);

    expect(state.kind === 'finished' ? state.ok : true).toBe(false);
  });

  it('несуществующая команда — отказ, а не вечное «идёт»', async () => {
    /**
     * Иначе кнопка залипала бы навсегда: состояние осталось бы
     * «выполняется», и прогнать набор стало бы нельзя до перезапуска
     * бота.
     */
    const runner = createEvalRunner({ evalDir: 'н', command: ['такой-команды-нет-совсем'] });

    runner.start();

    const state = await finished(runner);

    expect(state.kind === 'finished' ? state.ok : true).toBe(false);
    // И сказано, что случилось: пустой итог заставил бы гадать. Откуда
    // придёт объяснение, зависит от системы (на Windows команду не
    // находит оболочка, на Linux — сам Node), но оно должно быть.
    expect(state.kind === 'finished' ? state.tail : '').not.toBe('');
    expect(runner.start()).toBe(true);
  });

  it('меряет названную версию, а не активную', async () => {
    /**
     * Ради этого кнопка и существует. Горячую правку нельзя включить,
     * пока набор на ней не прогнан (§10.3), а прогон активной версии про
     * правку не говорит ничего.
     */
    const runner = createEvalRunner({ evalDir: 'н', command: ECHO });

    runner.start({ stage: 'classifier', version: 'classifier@1-hotfix-20260907T1030' });

    const state = await finished(runner);
    const tail = state.kind === 'finished' ? state.tail : '';

    expect(tail).toContain('classifier@1-hotfix-20260907T1030');
    expect(argsOf(state)).toContain('--use');
  });

  it('имя версии доезжает одним куском, а не двумя командами', async () => {
    /**
     * Имя версии приходит из панели. Запускай мы прогон через оболочку,
     * аргументы склеились бы в строку без экранирования — и амперсанд в
     * имени стал бы второй командой на сервере. Панель за паролем и
     * вторым множителем, но исполнение чужой строки не должно зависеть
     * только от этого.
     */
    const runner = createEvalRunner({ evalDir: 'н', command: ECHO });

    runner.start({ stage: 'classifier', version: 'c@1&echo беда' });

    const state = await finished(runner);

    expect(argsOf(state)).toContain('classifier=c@1&echo беда');
    expect(state.kind === 'finished' ? state.tail : '').not.toContain('беда\n');
  });

  it('видно, что именно меряется, пока прогон идёт', async () => {
    const runner = createEvalRunner({ evalDir: 'н', command: ECHO });

    runner.start({ stage: 'router', version: 'router@2' });

    const running = runner.state();

    expect(running.kind === 'running' ? running.measuring?.version : undefined).toBe('router@2');

    await finished(runner);
  });

  it('резолвер меряется своим набором, а не общим', async () => {
    /**
     * Разные наборы, разные отчёты, разные пороги. Общий прогон ради
     * версии резолвера потратил бы деньги и не сдвинул заслон ни на шаг.
     */
    const runner = createEvalRunner({ evalDir: 'докс/eval' });

    // Настоящий прогон не запускаем — смотрим только на то, что бы
    // запустилось: подмена команды здесь как раз мешала бы.
    expect(runner.state().kind).toBe('idle');

    const real = createEvalRunner({ evalDir: 'докс/eval', command: ECHO });
    real.start({ stage: 'resolver', version: 'resolver@8' });

    const state = await finished(real);

    expect(argsOf(state)).toContain('--use');
    expect(argsOf(state)).toContain('resolver=resolver@8');
  });
});

/** Настоящая папка набора: под замок нужна та, что существует. */
function realDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'vydoh-eval-'));
  made.push(path);
  mkdirSync(join(path, 'runs'), { recursive: true });

  return path;
}

const made: string[] = [];

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Команда, которая ничего не делает и выходит с нужным кодом. */
function exits(code: number): readonly string[] {
  return [process.execPath, '-e', `process.exit(${String(code)})`];
}

describe('запрет второго прогона переживает перезапуск бота (ревизия этапа)', () => {
  /**
   * **Ревизия нашла здесь неверно названную цену.** Запрет «один прогон
   * за раз» жил в замыкании, а докстринг называл ценой перезапуска
   * забывчивость панели. Настоящая цена другая: перезапуск снимал
   * запрет, и следующее нажатие платило **второй раз** за тот же набор.
   * Обещание «вторая кнопка не удваивает счёт» держалось на том, что
   * бота не перезапускают, — а выкладки в этом проекте регулярно
   * совпадают с часовым проходом.
   */

  it('чужой живой прогон виден новому процессу и второй раз не запускается', () => {
    const evalDir = realDir();

    // Замок от заведомо живого процесса — своего же родителя.
    writeFileSync(
      join(evalDir, 'runs', '.running'),
      JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }),
      'utf8',
    );

    const runner = createEvalRunner({ evalDir, command: ECHO });

    expect(runner.state().kind).toBe('running');
    expect(runner.start()).toBe(false);
  });

  it('замок мёртвого процесса снимается сам — иначе кнопка заперта навсегда', () => {
    /**
     * Один упавший прогон запер бы кнопку до правки руками, а рядом с
     * кнопкой стоит заслон §10.3: обойти его правильно стало бы нечем.
     */
    const evalDir = realDir();

    writeFileSync(
      join(evalDir, 'runs', '.running'),
      JSON.stringify({ pid: 2_147_483_647, startedAt: new Date().toISOString() }),
      'utf8',
    );

    const runner = createEvalRunner({ evalDir, command: ECHO });

    expect(runner.state().kind).toBe('idle');
    expect(existsSync(join(evalDir, 'runs', '.running'))).toBe(false);
  });

  it('свой прогон ставит замок и снимает его в конце', async () => {
    const evalDir = realDir();
    const runner = createEvalRunner({ evalDir, command: ECHO });

    expect(runner.start()).toBe(true);

    const held = JSON.parse(readFileSync(join(evalDir, 'runs', '.running'), 'utf8')) as {
      readonly pid: number;
    };

    expect(held.pid).toBe(process.pid);

    await finished(runner);

    expect(existsSync(join(evalDir, 'runs', '.running'))).toBe(false);
  });

  it('папка набора под замок не создаётся на пустом месте', () => {
    // Прогон без набора всё равно ничего не измерит, а сорить в чужом
    // каталоге ради замка неправильно.
    const runner = createEvalRunner({ evalDir: 'нет-такой-папки-совсем', command: ECHO });

    runner.start();

    expect(existsSync('нет-такой-папки-совсем')).toBe(false);
  });
});

describe('исход прогона различает случаи (ревизия этапа)', () => {
  /**
   * Скрипты различают их давно — кодами возврата, — а панель складывала
   * в булево. «Кончились деньги» показывалось человеку как «порог не
   * пройден», то есть обвинением промпта в том, чего он не делал: правку
   * шли искать в промпте вместо потолка расхода.
   */

  it.each([
    [0, 'passed'],
    [1, 'failed'],
    [2, 'bad-call'],
    [3, 'not-started'],
  ])('код %i означает %s', async (code, outcome) => {
    const runner = createEvalRunner({ evalDir: realDir(), command: exits(code) });

    runner.start();
    const state = await finished(runner);

    expect(state.kind === 'finished' ? state.outcome : undefined).toBe(outcome);
  });
});

describe('хвост прогона не выносит слов человека (§16, ревизия этапа)', () => {
  /**
   * `run-eval.ts` печатает промахи вместе с текстом единиц: «лишнее [id]
   * „купить корм коту"». Хвост уезжает в раздел «Промпты», объявленный
   * **не данными человека**, — значит доступ к нему не журналируется
   * вовсе. А набор живёт в `docs/eval`, и в нём настоящие расшифровки:
   * они оттуда и приходят.
   *
   * Панели нужны вердикт, счёт и идентификаторы промахов — по ним случай
   * находится в наборе. Само сказанное не нужно ни для чего.
   */
  it('содержимое кавычек заменяется многоточием, а счёт остаётся', async () => {
    const say = 'лишнее [c-12] «купить корм коту»; промахов 3';
    const runner = createEvalRunner({
      evalDir: realDir(),
      command: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(say)})`],
    });

    runner.start();
    const state = await finished(runner);
    const tail = state.kind === 'finished' ? state.tail : '';

    expect(tail).not.toContain('корм коту');
    expect(tail).toContain('[c-12]');
    expect(tail).toContain('промахов 3');
  });
});
