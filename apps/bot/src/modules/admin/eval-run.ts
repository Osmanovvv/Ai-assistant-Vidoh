import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * **Запрет второго прогона держится файлом-замком, а не памятью.**
 * Ревизия четвёртого этапа: прежде «один прогон за раз» жил в замыкании,
 * и цена была названа неверно — «панель забудет и покажет прогонов не
 * было». Настоящая цена другая: перезапуск бота посреди прогона снимал
 * запрет, и следующее нажатие платило **второй раз** за то же самое.
 * Обещание «вторая кнопка не удваивает счёт» держалось на том, что бота
 * не перезапускают, — а выкладки в этом проекте регулярно совпадают с
 * часовым проходом.
 *
 * Замок — файл `runs/.running` рядом с отчётами: там же, где лежат
 * результаты, и он переживает перезапуск. Внутри — pid, время старта и
 * что меряем. Живость pid проверяется (`process.kill(pid, 0)`): замок
 * от процесса, которого больше нет, снимается сам, иначе один упавший
 * прогон запер бы кнопку навсегда. Строка в базе была бы точнее, но
 * прогон запускается и без базы — из командной строки, — а замок нужен
 * обоим путям.
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
      /**
       * Чем кончился прогон — по коду возврата (ревизия этапа).
       *
       * Прежде исход был булевым, и «прогон не начался, потому что
       * кончились деньги» показывалось человеку как «порог не пройден».
       * Это обвинение промпта в том, чего он не делал: правку начинают
       * искать в промпте вместо потолка расхода. Скрипты различают
       * случаи давно — кодами 0/1/2/3, — а панель их складывала в один.
       */
      readonly outcome: 'passed' | 'failed' | 'not-started' | 'bad-call' | 'broken';
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

/**
 * Дословные фрагменты речи людей из хвоста прогона (§16, ревизия этапа).
 *
 * `run-eval.ts` печатает промахи вместе с текстом единиц: «лишнее [id]
 * „купить корм коту"». Хвост уезжает в раздел «Промпты», объявленный
 * **не данными человека**, — а значит доступ к нему не журналируется
 * вовсе. Набор живёт в `docs/eval`, и в нём настоящие расшифровки: они
 * оттуда и приходят.
 *
 * Панели нужны вердикт, счёт и идентификаторы промахов — по ним случай
 * находится в наборе. Само сказанное не нужно ни для чего.
 *
 * Помечать путь персональным не годится: у хвоста нет субъекта, и
 * журнал «смотрели на кого-то» бесполезен. Правильное место — здесь, до
 * того как хвост покинет процесс.
 */
const QUOTED = /«[^»]*»/gu;

function withoutQuotes(text: string): string {
  return text.replaceAll(QUOTED, '«…»');
}

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

/**
 * Что означает код возврата прогона (ревизия этапа).
 *
 * Скрипты различают случаи давно: `run-eval.ts` выходит с 3, когда
 * прогон **не начался** из-за потолка расхода, с 2 — при неверном
 * вызове, с 1 — когда порог не пройден. Панель складывала всё в булево
 * `ok`, и «денег не осталось» читалось как «промпт стал хуже» — то есть
 * правку шли искать в промпте вместо потолка.
 */
function outcomeOf(code: number | null): 'passed' | 'failed' | 'not-started' | 'bad-call' {
  if (code === 0) return 'passed';
  if (code === 3) return 'not-started';
  if (code === 2) return 'bad-call';

  return 'failed';
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

  /** Файл-замок: рядом с отчётами, чтобы переживал перезапуск бота. */
  const lockPath = join(deps.evalDir, 'runs', '.running');

  interface Held {
    readonly pid: number;
    readonly startedAt: string;
    readonly measuring?: EvalTarget | undefined;
  }

  /**
   * Чужой живой прогон, если он есть.
   *
   * `undefined` означает «замка нет либо он мёртв»: замок от процесса,
   * которого больше нет, снимается — иначе один упавший прогон запер бы
   * кнопку навсегда, и заслон §10.3 стало бы нечем обойти правильно.
   */
  const heldByOther = (): Held | undefined => {
    let held: Held;

    try {
      held = JSON.parse(readFileSync(lockPath, 'utf8')) as Held;
    } catch {
      return undefined;
    }

    if (typeof held.pid !== 'number' || held.pid === process.pid) return undefined;

    try {
      // Сигнал 0 ничего не посылает, только спрашивает: жив ли.
      process.kill(held.pid, 0);
      return held;
    } catch {
      // Процесса нет — замок мёртв. Снимаем его сами.
      try {
        rmSync(lockPath, { force: true });
      } catch (error) {
        deps.onError?.(error);
      }

      return undefined;
    }
  };

  const takeLock = (startedAt: Date, measuring: EvalTarget | undefined): void => {
    /**
     * Папка набора не создаётся на пустом месте.
     *
     * Замок живёт рядом с отчётами, и заводить под него папку там, где
     * набора нет вовсе, значило бы насорить в чужом каталоге — а прогон
     * без набора всё равно ничего не измерит. На боевом набора нет
     * нарочно (§16), и кнопки прогона там тоже нет.
     */
    if (!existsSync(deps.evalDir)) return;

    try {
      mkdirSync(join(deps.evalDir, 'runs'), { recursive: true });
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: startedAt.toISOString(),
          ...(measuring === undefined ? {} : { measuring }),
        }),
        'utf8',
      );
    } catch (error) {
      // Замок не взялся — прогон всё равно идёт. Молчать нельзя: в этом
      // состоянии второе нажатие после перезапуска заплатит второй раз.
      deps.onError?.(error);
    }
  };

  const freeLock = (): void => {
    try {
      rmSync(lockPath, { force: true });
    } catch (error) {
      deps.onError?.(error);
    }
  };

  return {
    state: () => {
      /**
       * Чужой живой прогон виден и после перезапуска бота.
       *
       * Иначе панель показала бы «прогонов не было», а нажатие заплатило
       * бы второй раз за тот же набор.
       */
      if (state.kind === 'idle') {
        const held = heldByOther();

        if (held !== undefined) {
          return {
            kind: 'running',
            startedAt: new Date(held.startedAt),
            ...(held.measuring === undefined ? {} : { measuring: held.measuring }),
          };
        }
      }

      return state;
    },

    start: (target?: EvalTarget) => {
      if (state.kind === 'running') return false;

      // Прогон, начатый до перезапуска бота, — тоже прогон: платить за
      // тот же набор второй раз нельзя.
      if (heldByOther() !== undefined) return false;

      const startedAt = clock();
      const measuring = target === undefined ? undefined : { ...target };
      state = { kind: 'running', startedAt, measuring };
      takeLock(startedAt, measuring);

      const [file, ...args] = commandFor(target);

      if (file === undefined) {
        freeLock();
        state = { kind: 'idle' };
        return false;
      }

      let output = '';

      const keep = (chunk: Buffer): void => {
        // Вымарывание — здесь, а не при выдаче: хвост не должен покидать
        // процесс со словами человека даже в памяти состояния (§16).
        output = (output + withoutQuotes(chunk.toString('utf8'))).slice(-TAIL_LIMIT);
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
          freeLock();
          state = {
            kind: 'finished',
            startedAt,
            finishedAt: clock(),
            measuring,
            ok: false,
            outcome: 'broken',
            tail: `не удалось запустить прогон: ${String(error)}`,
          };
        });

        child.on('close', (code) => {
          if (broken) return;

          freeLock();

          // Код возврата — единственное, чему тут можно верить: прогон
          // сам решает, прошёл порог или нет, и говорит это кодом. Коды
          // назначены скриптами: 0 — порог пройден, 1 — не пройден,
          // 2 — неверный вызов, 3 — прогон не начался (потолок расхода).
          state = {
            kind: 'finished',
            startedAt,
            finishedAt: clock(),
            measuring,
            ok: code === 0,
            outcome: outcomeOf(code),
            tail: output.trim(),
          };
        });

        return true;
      } catch (error) {
        deps.onError?.(error);
        freeLock();
        state = {
          kind: 'finished',
          startedAt,
          finishedAt: clock(),
          measuring,
          ok: false,
          outcome: 'broken',
          tail: `не удалось запустить прогон: ${String(error)}`,
        };

        return false;
      }
    },
  };
}
