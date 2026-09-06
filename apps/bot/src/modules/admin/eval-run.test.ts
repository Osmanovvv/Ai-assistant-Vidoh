import { describe, expect, it } from 'vitest';

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
