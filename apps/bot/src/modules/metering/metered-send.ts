import type { Executor } from '../../infra/db.js';
import { withRetry, type RetryOptions } from '../../infra/retry.js';
import { meterCall, type AiCallContext, type MeteredResult } from './ai-calls.repo.js';
import type { ModelPricing } from './pricing.js';
import type { SpendGuard } from './spend-guard.js';

/**
 * Учёт на каждую отправку, а не на вызов целиком (§10.5 ТЗ).
 *
 * §10.5 дословно (`docs/00-tz-source.md:320`): «Таблица обращений к
 * моделям заполняется **на каждом вызове, включая неуспешные**: … задержка,
 * признак успеха, текст ошибки».
 *
 * **Что было.** Учёт стоял снаружи повтора: `meterCall(… withRetry(…))`.
 * Внутри одной записи жило до трёх отправок, и если первая срывалась, а
 * вторая удавалась, в `ai_calls` ложилась одна строка с «успех».
 * Сорвавшейся отправки в учёте не было вовсе — доля отказов модели в
 * отчёте занижена, а `onRetry` не задан нигде в проекте, так что и в
 * журнале от неё не оставалось следа. Заодно задержка считалась от входа
 * и включала паузы повтора в секунду и две: это не задержка вызова.
 *
 * **Денег это не искажало** — 429 и пятисотые не тарифицируются, а таймаут
 * отменяет генерацию, — но §10.5 просит видеть отказы, и просит прямо.
 *
 * **Порядок обёрток здесь единственный на все три платных пути** — модель,
 * распознавание речи и вектора. Он был одинаково неверен во всех трёх, и
 * повторить правку трижды значило бы завести три места, где её можно
 * забыть по отдельности.
 */
export async function meterEachSend<T>(
  db: Executor,
  context: AiCallContext,
  /** Одна отправка провайдеру: её и учитываем. */
  send: () => Promise<MeteredResult<T>>,
  options: {
    readonly pricing?: Readonly<Record<string, ModelPricing>> | undefined;
    readonly guard?: SpendGuard | undefined;
    readonly retry?: RetryOptions | undefined;
  } = {},
): Promise<T> {
  return await withRetry(
    () =>
      meterCall(db, context, send, {
        pricing: options.pricing,
        guard: options.guard,
      }),
    options.retry ?? {},
  );
}
