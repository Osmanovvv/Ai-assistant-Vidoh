import type { ResolverAction, ResolverAnswer } from '../ai/schemas/index.js';
import type { Candidate } from './candidates.js';

/**
 * Пороговая логика резолвера (§7.3 ТЗ, задача 3.2).
 *
 * ТЗ задаёт три исхода: высокая уверенность — применить, средняя —
 * задать один короткий вопрос с двумя кнопками, низкая — создать новую
 * запись, потому что дубли лучше потери данных.
 *
 * **Решение стоит на двух сигналах, а не на одном.** Самооценка
 * уверенности у языковых моделей плохо калибрована, завышена и съезжает
 * при смене версии промпта. Одного числа от модели мало, чтобы менять
 * запись человека без спроса, — нужно подтверждение, к модели отношения
 * не имеющее.
 *
 * **Порог близости пришлось измерить, а не назначить.** В плане стояло
 * 0,75 — число, перенесённое из поиска дублей, где сравниваются похожие
 * тексты. Замер 29.08.2026 на живых формулировках показал другое:
 *
 * | Близость | Пара |
 * |---|---|
 * | 0,312 | «нет, в пятницу» → «Записать сына к врачу в четверг» |
 * | 0,415 | «не в 9, а в 9 30» → запись про няню |
 * | 0,391 | «продукты купила» → «Проверить список продуктов» |
 * | 0,523 | «перенеси врача на пятницу» → та же запись |
 * | 0,200 | «нет, в пятницу» → «Сверить кассу» (чужая запись) |
 *
 * Поправка почти не содержит слов исходной записи — в этом её природа.
 * При пороге 0,75 строка «применить» не сработала бы никогда, а кнопка
 * отмены из 3.4 осталась бы без изменения, которое можно отменять.
 *
 * Поэтому подтверждений три вида, и достаточно любого:
 *
 * 1. **Близость** ≥ 0,50 с отрывом от второго кандидата — человек назвал
 *    запись достаточно явно.
 * 2. **Свежесть** — запись из короткой памяти, тронутая минуты назад, и
 *    такая свежая она одна. Это ровно сценарий §7.2 «врач в четверг,
 *    через минуту — в пятницу»: ТЗ само назначает короткую память
 *    источником, который его закрывает.
 * 3. **Срок** — у записи срок в том самом дне, который человек назвал.
 *
 * **Чего это стоит честно сказать:** если человек наговорил десять дел, а
 * потом поправил одно вскользь, свежих кандидатов будет десять,
 * подтверждения не наберётся, и бот спросит. Так и задумано. §7.3: «бот
 * не угадывает», «ошибочный вопрос стоит одного тапа, ошибочное
 * изменение стоит доверия».
 *
 * Числа предварительные: измерены на шести парах. Уточнить их надо
 * контрольным набором резолвера — его ещё нет, и до него любая правка
 * порогов будет вкусовой.
 */

export interface ResolverThresholds {
  /** Ниже — бот вообще не считает, что речь о существующей записи. */
  readonly create: number;
  /** Выше — можно применять, если найдётся подтверждение. */
  readonly apply: number;
  /** Близость, начиная с которой она считается подтверждением правки. */
  readonly similarity: number;
  /**
   * То же для отметки выполнения и отмены — порог ниже, и это замер.
   *
   * §21 п.8 требует, чтобы отметка голосом проходила **без уточняющих
   * вопросов**, а §21 п.5 — чтобы неоднозначная реплика вопрос получала.
   * Спор между ними решается тем, что отметка выполнения повторяет слова
   * дела, а поправка нет:
   *
   * | Близость | Пара |
   * |---|---|
   * | 0,391 | «продукты купила» → «Проверить список продуктов» |
   * | 0,512 | «кассу сверила» → «Сверить кассу» |
   * | 0,575 | «кота записала на стрижку» → «Записать кота на стрижку» |
   * | 0,256 | «записалась к врачу» → «Сверить кассу» — чужое |
   * | 0,062 | «обед приготовила» → «Зайти в ВТБ» — чужое |
   *
   * Замер 30.08.2026 на десяти парах: верные 0,391–0,575, чужие
   * 0,062–0,256. Разрыв чистый, и порог 0,35 проходит между ними с
   * запасом в обе стороны. Отрыв от второго кандидата при этом остаётся
   * обязательным — он и отсекает «купила» при двух покупках сразу.
   */
  readonly similarityDone: number;
  /** На сколько кандидат должен опережать второго по близости. */
  readonly similarityGap: number;
  /** Сколько минут запись считается свежей для подтверждения. */
  readonly freshMinutes: number;
}

/**
 * Значения по умолчанию.
 *
 * §3.2 требует, чтобы пороги настраивались из админки, — она четвёртый
 * этап. До неё значения живут здесь, одним объектом: пороги, разбросанные
 * по коду, невозможно ни обсудить, ни поменять разом.
 */
export const DEFAULT_THRESHOLDS: ResolverThresholds = {
  create: 0.45,
  apply: 0.8,
  similarity: 0.5,
  similarityDone: 0.35,
  similarityGap: 0.1,
  freshMinutes: 15,
};

export type DecisionKind = 'apply' | 'ask' | 'create';

export interface Decision {
  readonly kind: DecisionKind;
  /** Что делать с записью. Для `create` всегда `new`. */
  readonly action: ResolverAction;
  /** Выбранная запись. Для `create` её нет. */
  readonly candidate?: Candidate | undefined;
  /**
   * Модель сама сказала «это новая мысль», а не пороги её к этому
   * принудили.
   *
   * Разница решает судьбу сказанного. «Надо ещё окна помыть», ошибочно
   * попавшее в правки, — настоящая новая мысль, и из неё выйдет запись.
   А «нет, в пятницу», для которого не нашлось цели, записью стать не
   * должно: получится задача «в пятницу». Одного `kind: create` для
   * этого различения мало.
   */
  readonly newThought: boolean;
  /**
   * Почему решено так — строкой, для журнала.
   *
   * Не для человека: реплику собирает представление. Без этой строки
   * разбирать жалобу «бот поменял не то» пришлось бы гаданием.
   */
  readonly why: string;
}

export interface DecideContext {
  readonly now: Date;
  readonly thresholds?: Partial<ResolverThresholds> | undefined;
}

/** Запись тронута только что, и такая она одна среди кандидатов. */
function freshAlone(
  candidate: Candidate,
  candidates: readonly Candidate[],
  now: Date,
  minutes: number,
): boolean {
  const isFresh = (item: Candidate): boolean =>
    item.sources.includes('session') &&
    now.getTime() - item.updatedAt.getTime() <= minutes * 60_000;

  if (!isFresh(candidate)) return false;

  return candidates.filter(isFresh).length === 1;
}

/** Близость выше порога и с отрывом от следующего кандидата. */
function clearlyClosest(
  candidate: Candidate,
  candidates: readonly Candidate[],
  thresholds: ResolverThresholds,
  action: ResolverAction,
): boolean {
  /**
   * У отметки выполнения и отмены свой порог, ниже.
   *
   * Не поблажка: человек, закрывающий дело, повторяет его слова, и
   * близость там выше по природе задачи. Мерено — см. `similarityDone`.
   */
  const floor =
    action === 'complete' || action === 'cancel'
      ? thresholds.similarityDone
      : thresholds.similarity;

  const own = candidate.similarity;
  if (own === null || own < floor) return false;

  const rivals = candidates
    .filter((item) => item.id !== candidate.id)
    .map((item) => item.similarity ?? 0);

  const best = rivals.length === 0 ? 0 : Math.max(...rivals);
  return own - best >= thresholds.similarityGap;
}

/**
 * Решает, что делать с ответом модели.
 *
 * Чистая функция: ни базы, ни модели, ни часов — иначе таблицу случаев
 * нечем проверить, а вся ценность порога в том, что его поведение
 * предсказуемо на каждом из них.
 */
export function decide(
  answer: ResolverAnswer,
  candidates: readonly Candidate[],
  context: DecideContext,
): Decision {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...context.thresholds };

  if (answer.action === 'new') {
    return {
      kind: 'create',
      action: 'new',
      newThought: true,
      why: 'модель не нашла подходящей записи',
    };
  }

  const candidate = candidates.find((item) => item.id === answer.itemId);

  if (candidate === undefined) {
    // Модель может назвать идентификатор, которого в списке не было.
    // Применять такое нельзя ни при какой уверенности: мы не знаем, что
    // это за запись и чья она.
    return {
      kind: 'create',
      action: 'new',
      newThought: false,
      why: 'модель назвала запись, которой не было среди кандидатов',
    };
  }

  if (answer.confidence < thresholds.create) {
    return {
      kind: 'create',
      action: 'new',
      newThought: false,
      why: 'уверенность ниже нижнего порога',
    };
  }

  if (answer.confidence < thresholds.apply) {
    return {
      kind: 'ask',
      action: answer.action,
      candidate,
      newThought: false,
      why: 'уверенность средняя',
    };
  }

  if (clearlyClosest(candidate, candidates, thresholds, answer.action)) {
    return {
      kind: 'apply',
      action: answer.action,
      candidate,
      newThought: false,
      why: 'подтверждено близостью',
    };
  }

  if (freshAlone(candidate, candidates, context.now, thresholds.freshMinutes)) {
    return {
      kind: 'apply',
      action: answer.action,
      candidate,
      newThought: false,
      why: 'подтверждено свежестью',
    };
  }

  if (candidate.sources.includes('deadline')) {
    return {
      kind: 'apply',
      action: answer.action,
      candidate,
      newThought: false,
      why: 'подтверждено сроком',
    };
  }

  // Уверенность высокая, но подтвердить нечем. §7.3 в этом случае велит
  // спросить: одного числа от модели мало.
  return {
    kind: 'ask',
    action: answer.action,
    candidate,
    newThought: false,
    why: 'уверенность высокая, но второго сигнала нет',
  };
}
