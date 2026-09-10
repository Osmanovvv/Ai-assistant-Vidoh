import { isAlreadyPaid, PermanentError, SpendCeilingError, TransientError } from './failures.js';

/**
 * Повтор с растущей паузой и таймаут (задачи 1.15, 2.3).
 *
 * §10.2 ТЗ: каждый вызов оборачивается таймаутом и повтором с увеличением
 * паузы. §17: при недоступности модели выгрузка сохраняется в очередь и
 * обрабатывается позже — терять текст нельзя ни при каких обстоятельствах.
 *
 * Постоянные ошибки не повторяются: битый файл не станет целым от третьей
 * попытки, а мы за неё заплатим.
 */

export interface RetryOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Подмена ожидания в тестах: настоящие паузы делают тесты медленными. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const DEFAULTS = {
  attempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function backoffDelayMs(
  attempt: number,
  baseDelayMs = DEFAULTS.baseDelayMs,
  maxDelayMs = DEFAULTS.maxDelayMs,
): number {
  return Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULTS.attempts;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (error instanceof PermanentError) {
        throw error;
      }

      /**
       * За этот вызов уже заплачено — повторять его нельзя (3.82).
       *
       * Распознавание речи платит отправка, а не результат: сорвавшийся
       * опрос готовности отправлял те же секунды звука заново, и минута
       * записи стоила три. Отказ при этом остаётся временным — наверху
       * он читается как «попробую позже», — но тесный повтор вокруг
       * платной отправки прекращается здесь.
       */
      if (isAlreadyPaid(error)) {
        throw error;
      }

      /**
       * Потолок расхода за секунды не опустеет (§10.5, ревизия этапа 2).
       *
       * Отказ потолка — временный по классу: наверху он читается как
       * «вернусь позже», и выгрузка не хоронится. Но повторять его тесно
       * бессмысленно: три захода с паузами в секунду и две упрутся в тот
       * же потолок и задержат честный отказ на три секунды.
       *
       * Стало важно после того, как учёт переехал внутрь повтора: страж
       * расхода спрашивается теперь на каждой отправке, а не раз на
       * вызов, — см. `metering/metered-send.ts`.
       */
      if (error instanceof SpendCeilingError) {
        throw error;
      }
      if (attempt === attempts) {
        break;
      }

      const delayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * Ограничение по времени: зависший вызов не должен держать очередь.
 *
 * **И не должен продолжать тратить деньги** (задача 3.81). Раньше здесь
 * стояла одна гонка: мы переставали ждать, а запрос к модели жил дальше
 * — соединение открыто, генерация идёт, счётчик тикает. При трёх
 * попытках повтора один вызов мог оплатиться трижды, а в учёт попадала
 * одна строка: у сорвавшегося вызова расход пустой.
 *
 * Поэтому обработчику отдаётся `AbortSignal`, и по выходу отсюда он
 * отменяется **в любом случае** — и по таймауту, и когда ответ пришёл
 * вовремя (там отмена безвредна: всё уже сделано).
 *
 * **Отказ отменённого запроса гасится отдельно, и это не мелочь.**
 * Проигравшая сторона гонки отклоняется позже победившей, и без своего
 * обработчика её отказ становится необработанным. Такое уже роняло этот
 * процесс однажды — на express пятой версии, см. `index.ts`.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label = 'операция',
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const running = fn(controller.signal);

  // Гасим отказ проигравшей стороны: сам результат гонка отдаст ниже.
  running.catch(() => undefined);

  try {
    return await Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          /**
           * Таймаут — **временный** сбой, и класс здесь важнее текста.
           *
           * Прежде бросалась голая `Error`: без класса, без `code`, без
           * причины. Конвейер такую не узнаёт и считает постоянной —
           * значит выгрузка помечалась `failed`, а сбойные выгрузки
           * намеренно не переподхватываются. Слова человека оставались
           * целы в `messages_raw`, но разобрать их было уже нечему:
           * только руками из панели.
           *
           * Три места обещали обратное — шапка `failures.ts` называет
           * таймаут примером временного сбоя, `ai/client.ts` обещает
           * «выгрузка возвращается в очередь», а ТЗ говорит прямо:
           * «терять текст пользователя нельзя ни при каких
           * обстоятельствах». Намерение было верным, класс не поставили.
           *
           * Повтор внутри `withRetry` таймаут и так считал временным —
           * расходились только он и конвейер. Одна правка лечит все три
           * платных пути: речь, модель, векторы.
           */
          reject(new TransientError(`${label}: превышен таймаут ${String(timeoutMs)} мс`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
