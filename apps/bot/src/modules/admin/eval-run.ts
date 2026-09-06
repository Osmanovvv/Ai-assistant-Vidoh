import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Кнопка прогона контрольного набора (§15 ТЗ, задача 4.8).
 *
 * План требует рядом с предупреждением «набор не прогонялся» дать кнопку
 * прогона. Причина простая: заслон, который только запрещает, обходят —
 * а заслон, рядом с которым лежит способ сделать правильно, соблюдают.
 *
 * **Прогон стоит денег.** Он ходит к живой модели по всему контрольному
 * набору, и это не фигура речи: 05.09.2026 у продукта кончился грант
 * Yandex, в том числе на таких прогонах. Поэтому:
 *
 *  - **один прогон за раз** — вторая кнопка, нажатая от нетерпения, не
 *    удваивает счёт;
 *  - **запуск отдельным процессом**, а не в процессе бота: прогон идёт
 *    минутами, и держать на нём обработчик запроса значило бы, что
 *    панель «висит», а перезапуск бота посреди прогона рвал бы его;
 *  - **потолок расхода стоит внутри самого прогона** (`run-eval.ts`
 *    поднимает страж), и панель его не дублирует: два потолка в разных
 *    местах однажды разойдутся.
 *
 * **Состояние живёт в памяти процесса, и это названная цена.** Перезапуск
 * бота посреди прогона теряет его состояние: сам прогон продолжится
 * отдельным процессом, а панель об этом забудет и покажет «прогонов не
 * было». Таблица ради одной кнопки у одного администратора — дороже, чем
 * эта неточность; когда администраторов станет несколько, здесь появится
 * строка в базе.
 *
 * **Оболочка не используется, и это не мелочь.** Имя версии приходит из
 * панели, а `shell: true` склеивает аргументы в одну строку без
 * экранирования: версия вида `a & что-нибудь` выполнилась бы как вторая
 * команда. Панель за паролем и вторым множителем, но исполнение чужой
 * строки на сервере не должно зависеть только от этого.
 */

export type EvalRunState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      readonly startedAt: Date;
      /** Что меряем: стадия и версия, либо активные версии. */
      readonly measuring?: { readonly stage: string; readonly version: string } | undefined;
    }
  | {
      readonly kind: 'finished';
      readonly startedAt: Date;
      readonly finishedAt: Date;
      readonly ok: boolean;
      /** Хвост вывода: человеку нужен итог, а не весь журнал. */
      readonly tail: string;
      readonly measuring?: { readonly stage: string; readonly version: string } | undefined;
    };

export interface EvalRunnerDeps {
  /** Папка контрольного набора: та же, что у проверки свежести. */
  readonly evalDir: string;
  /**
   * Чем запускать. Подменяется в проверках: настоящий прогон стоит
   * денег и требует доступа к модели, а механизм кнопки — нет.
   */
  readonly command?: readonly string[] | undefined;
  readonly now?: (() => Date) | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
}

/**
 * Чем запускать прогон: сам Node, без оболочки и без `npx`.
 *
 * В собранном виде рядом лежит `.js` — его Node запускает сам. Из
 * исходников (разработка) нужен `tsx`: у него разрешение путей с
 * расширением `.js`, которого у голого Node нет. Ищется он через
 * `require.resolve`, а не запускается командой `npx`: команда потребовала
 * бы оболочки, а оболочка — это склейка аргументов без экранирования.
 */
function nodeRunner(script: string): readonly string[] {
  const here = fileURLToPath(import.meta.url);
  const fromSource = here.endsWith('.ts');
  const path = join(dirname(here), '..', '..', 'scripts', `${script}.${fromSource ? 'ts' : 'js'}`);

  if (!fromSource) return [process.execPath, path];

  try {
    return [process.execPath, createRequire(import.meta.url).resolve('tsx/cli'), path];
  } catch {
    // tsx — зависимость разработки, в образе её нет. Но и исходников
    // там нет тоже, так что сюда попасть можно только в странной сборке.
    return [process.execPath, path];
  }
}

/** Сколько знаков вывода показываем человеку. */
const TAIL_LIMIT = 4_000;

/** Какую версию мерить. Без неё меряются активные. */
export interface EvalTarget {
  readonly stage: string;
  readonly version: string;
}

export interface EvalRunner {
  readonly state: () => EvalRunState;
  /**
   * Запустить прогон. Возвращает `false`, если прогон уже идёт: второй
   * запуск — это второй счёт за то же самое.
   *
   * `target` — версия, которую надо измерить **до** включения. Без неё
   * §15 и §10.3 запирают друг друга: горячую правку не включить, пока
   * не измерена, и не измерить, пока не включена.
   */
  readonly start: (target?: EvalTarget) => boolean;
}

export function createEvalRunner(deps: EvalRunnerDeps): EvalRunner {
  const clock = (): Date => deps.now?.() ?? new Date();
  const base = deps.command ?? [...nodeRunner('run-eval'), deps.evalDir];

  /**
   * Резолвер меряется своим набором, всё остальное — общим.
   *
   * Разные наборы, разные отчёты, разные пороги (см. `eval/freshness.ts`).
   * Запускать общий прогон ради версии резолвера значило бы потратить
   * деньги и не сдвинуть заслон ни на шаг.
   */
  const commandFor = (target: EvalTarget | undefined): readonly string[] => {
    if (target === undefined) return base;

    if (target.stage === 'resolver') {
      return deps.command === undefined
        ? [
            ...nodeRunner('run-resolver-eval'),
            join(deps.evalDir, 'resolver'),
            '--use',
            `resolver=${target.version}`,
          ]
        : [...base, '--use', `resolver=${target.version}`];
    }

    return [...base, '--use', `${target.stage}=${target.version}`];
  };

  let state: EvalRunState = { kind: 'idle' };

  return {
    state: () => state,

    start: (target?: EvalTarget) => {
      if (state.kind === 'running') return false;

      const startedAt = clock();
      const measuring = target === undefined ? undefined : { ...target };
      state = { kind: 'running', startedAt, measuring };

      const [file, ...args] = commandFor(target);
      if (file === undefined) return false;

      let output = '';

      const keep = (chunk: Buffer): void => {
        output = (output + chunk.toString('utf8')).slice(-TAIL_LIMIT);
      };

      try {
        // Без `shell`: имя версии приходит из панели, а оболочка склеила
        // бы аргументы в строку без экранирования (см. пояснение выше).
        const child = spawn(file, args, { env: process.env });

        child.stdout.on('data', keep);
        child.stderr.on('data', keep);

        /**
         * Сбой запуска перекрывает код возврата.
         *
         * Node шлёт `error`, а следом всё равно `close` с пустым кодом.
         * Без этой отметки второе стирало бы первое, и человек видел бы
         * «прогон не прошёл» без единого слова о том, что прогон вообще
         * не начинался.
         */
        let broken = false;

        child.on('error', (error: unknown) => {
          broken = true;
          deps.onError?.(error);
          state = {
            kind: 'finished',
            startedAt,
            finishedAt: clock(),
            measuring,
            ok: false,
            tail: `не удалось запустить прогон: ${String(error)}`,
          };
        });

        child.on('close', (code) => {
          if (broken) return;

          // Код возврата — единственное, чему тут можно верить: прогон
          // сам решает, прошёл порог или нет, и говорит это кодом.
          state = {
            kind: 'finished',
            startedAt,
            finishedAt: clock(),
            measuring,
            ok: code === 0,
            tail: output.trim(),
          };
        });

        return true;
      } catch (error) {
        deps.onError?.(error);
        state = {
          kind: 'finished',
          startedAt,
          finishedAt: clock(),
          measuring,
          ok: false,
          tail: `не удалось запустить прогон: ${String(error)}`,
        };

        return false;
      }
    },
  };
}
