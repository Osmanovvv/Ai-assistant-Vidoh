import type { RecognizedUtterance } from './providers/types.js';

/**
 * Паузы между словами речи — **пока только замер** (задача 3.59, шаг 1).
 *
 * **Зачем это понадобилось.** Точки в расшифровке ставит не человек и не
 * языковая модель: их вставляет Yandex своей литературной нормализацией.
 * И ставит не там. Живая запись 04.09.2026:
 *
 * > «…позвонить бабушке, желательно вечером, завтра надо. Отнести ноутбук
 * > в сервис на проверку…»
 *
 * Человек сказал «Ещё сегодня хотел позвонить бабушке. Желательно
 * вечером. Завтра надо отнести ноутбук в сервис». Точка встала после
 * «надо», где паузы не было, а на месте настоящих пауз оказались запятые.
 * Правила срока опираются на предложения — и «завтра» из мысли про
 * ноутбук досталось бабушке. Дело встало не на тот день.
 *
 * **Почему сначала замер, а не починка.** Порог паузы, выбранный на глаз,
 * — это догадка, а догадки в этом проекте уже давали выдуманные сроки.
 * Поэтому шаг первый: считать разрывы между словами и писать распределение
 * в журнал. Поведение при этом **не меняется ни на что**: числа считаются
 * из данных, которые расшифровка и так отдаёт, и никуда, кроме журнала, не
 * идут.
 *
 * Шаг второй — переставить границы предложений по измеренному порогу — в
 * задаче 3.68, и он делается только после того, как распределение увидено
 * на живых записях.
 */

/** Разрывы между соседними словами, в миллисекундах, по возрастанию. */
export function gapsBetweenWords(utterances: readonly RecognizedUtterance[]): readonly number[] {
  const gaps: number[] = [];

  for (const utterance of utterances) {
    const words = utterance.words;

    for (let index = 1; index < words.length; index++) {
      const previous = words[index - 1];
      const current = words[index];
      if (previous === undefined || current === undefined) continue;

      /**
       * Отрицательный разрыв — не ошибка, а норма распознавания: у
       * соседних слов времена перекрываются. В счёт такие идут нулём:
       * паузы там нет.
       */
      gaps.push(Math.max(0, current.startMs - previous.endMs));
    }
  }

  return gaps.sort((left, right) => left - right);
}

export interface PauseStats {
  readonly words: number;
  readonly gaps: number;
  /** Разрывы по долям: половина, три четверти, девять десятых, крайние. */
  readonly median: number;
  readonly p75: number;
  readonly p90: number;
  readonly p95: number;
  readonly max: number;
  /**
   * Сколько разрывов длиннее порога — для нескольких порогов сразу.
   *
   * Ровно то, ради чего замер и делается: по этим числам видно, сколько
   * границ предложений добавит каждый порог. Если порог 300 мс даёт
   * границу на каждом третьем слове, он не годится, и это видно сразу.
   */
  readonly over: Readonly<Record<string, number>>;
}

/** Значение доли в отсортированном ряду. */
function quantile(sorted: readonly number[], share: number): number {
  if (sorted.length === 0) return 0;

  const position = Math.min(sorted.length - 1, Math.floor(sorted.length * share));
  return sorted[position] ?? 0;
}

/** Пороги, по которым считается число границ. Шаг в сто миллисекунд. */
export const PAUSE_THRESHOLDS = [200, 300, 400, 500, 700, 1000] as const;

export function pauseStats(utterances: readonly RecognizedUtterance[]): PauseStats {
  const gaps = gapsBetweenWords(utterances);
  const words = utterances.reduce((sum, one) => sum + one.words.length, 0);

  const over: Record<string, number> = {};
  for (const threshold of PAUSE_THRESHOLDS) {
    over[`${String(threshold)}мс`] = gaps.filter((gap) => gap > threshold).length;
  }

  return {
    words,
    gaps: gaps.length,
    median: quantile(gaps, 0.5),
    p75: quantile(gaps, 0.75),
    p90: quantile(gaps, 0.9),
    p95: quantile(gaps, 0.95),
    max: gaps.length === 0 ? 0 : (gaps[gaps.length - 1] ?? 0),
    over,
  };
}
