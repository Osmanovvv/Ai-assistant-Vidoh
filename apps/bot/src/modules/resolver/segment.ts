import type { Logger } from 'pino';
import { effectiveThresholds, type SettingsRegistry } from '../settings/settings.repo.js';

import type { Database } from '../../infra/db.js';
import type { AiClientDeps } from '../ai/client.js';
import type { Intent } from '../ai/schemas/router.js';
import { embedText } from '../embedder/embedder.service.js';
import type { EmbeddingProvider } from '../embedder/providers/types.js';
import type { ModelPricing } from '../metering/pricing.js';
import { collectCandidates } from './candidates.js';
import { reembedIfRetitled } from '../embedder/reembed.js';
import { applyDecision, emptyChanges, type Applied, type ApplyOutcome } from './patch.js';
import { DEFAULT_THRESHOLDS } from './decision.js';
import { deicticAction, namesNoDeed } from './deixis.js';
import { lastDiscussed } from './deixis.repo.js';
import type { ClarifyKind } from './clarify.js';
import { mentionedPeriod } from './period.js';
import { askQuestion } from './questions.repo.js';
import { resolveSegment } from './resolver.service.js';
import { startsWithReplacement } from '../router/append.js';
import { looksLikeThought } from '../router/thought-words.js';

/**
 * Разбор одной правки: от сегмента до последствия (§7 ТЗ, задача 3.6а).
 *
 * **Задачи с таким номером в плане нет, и это дыра плана.** 3.1 собирает
 * кандидатов, 3.2 принимает решение, 3.3–3.5 применяют его, откатывают и
 * спрашивают — а вызвать всё это некому. До сих пор сегменты с
 * намерением `PATCH` уходили в черновик с пометкой «ждёт резолвера», и
 * ждали бы вечно.
 *
 * Здесь та самая недостающая склейка:
 *
 * 1. из текста вынимается упомянутый день — дёшево, без модели;
 * 2. считается вектор сегмента для смыслового поиска;
 * 3. собираются кандидаты из трёх источников (§7.2);
 * 4. резолвер решает: применить, спросить или создать (§7.3);
 * 5. решение исполняется.
 *
 * **Вектор считается, но его отсутствие не останавливает разбор.** У
 * поправки два других источника кандидатов, и терять правку из-за
 * недоступного эмбеддера было бы обидно.
 */

export interface ResolveDeps {
  readonly db: Database;
  readonly ai: AiClientDeps;
  readonly embedder?: EmbeddingProvider | undefined;
  readonly pricing?: Readonly<Record<string, ModelPricing>> | undefined;
  readonly logger?: Logger | undefined;
  /**
   * Реестр настроек — ради порогов резолвера (§15, ревизия этапа 4).
   *
   * **Мост от панели до решателя не был построен вовсе.** Три порога
   * объявлены в панели, у каждого поле ввода и страшное предупреждение
   * «значение получено замером», а читателя не было ни одного:
   * `effectiveThresholds` не имел вызывающих, и решатель всегда работал
   * на константах из кода. То есть человека пугали ценой правки, которая
   * ни на что не влияет.
   *
   * Необязателен: без него действуют умолчания из кода — и они те же
   * самые, потому что берутся из `SETTINGS.fallback`.
   */
  readonly settings?: SettingsRegistry | undefined;
}

export interface ResolveSegmentParams {
  readonly userId: string;
  readonly batchId: string;
  readonly text: string;
  readonly timeZone: string;
  /** §8.1: сообщение внутри ветки сужает поиск до её темы. */
  readonly topic?: string | undefined;
  readonly now?: Date | undefined;
  /**
   * Искать цель только среди записей этой выгрузки (задача 3.24).
   *
   * Ставит проход по правкам, сказанным после мысли этой же выгрузки:
   * поправка к только что произнесённому относится к нему, а не к
   * похожей записи из прошлого. Подробности в `candidates.ts`.
   */
  readonly onlyOwnBatch?: boolean | undefined;
  /**
   * Вопрос за этот обмен уже задан (§13.9) — второй не заводить.
   *
   * Ревизия этапа 3, A2: вопрос записывался в базу здесь, до того как
   * конвейер решал его не показывать, — и запись снимала показанный
   * первый как `superseded`. Человек видел вопрос, которого уже нет.
   * Теперь при занятом вопросе правка паркуется, не касаясь базы.
   */
  readonly questionTaken?: boolean | undefined;
  /**
   * Что маршрутизатор услышал в отрезке (прогон 15.09.2026, находка 5).
   *
   * Закрытие и отмена говорят о **существующей** записи. Если модель не
   * нашла подходящей, «это новая мысль» для них невозможно: «мусор я уже
   * вынес» не имеет права стать открытым делом «Вынести мусор», что бы
   * ни ответила модель. Для правки развилка прежняя: «нет, в пятницу»
   * без цели — действительно мысль.
   */
  readonly intent?: Intent | undefined;
}

export type SegmentResult =
  /** Изменение применено, есть что отменять. */
  | { readonly kind: 'applied'; readonly applied: Applied }
  /** Задан уточняющий вопрос: его надо показать человеку. */
  | {
      readonly kind: 'asked';
      readonly questionId: string;
      readonly itemTitle: string;
      /** Отложенное действие и новый срок — по ним выбирается текст вопроса. */
      readonly action: string;
      readonly deadline: string;
    }
  /** Сказанное — новая мысль: пусть идёт в обычный разбор. */
  | { readonly kind: 'newThought' }
  /** Ни то, ни другое: сохранить черновиком, чтобы не потерять. */
  | {
      readonly kind: 'parked';
      readonly reason: string;
      /**
       * Чем кончилось применение, если цель нашлась (ревизия этапа 3,
       * A3): по этому конвейер подбирает слово человеку. Пусто — цели
       * не было, и говорить не о чем сверх «сохранила».
       */
      /** `absent` — сказано как о сделанном или отменённом, а записи нет. */
      /** `which` — сказано «это», а только что тронутых записей не одна. */
      readonly said?: 'unchanged' | 'refused' | 'gone' | 'absent' | 'which' | undefined;
      /** При `unchanged`: час назван с двумя чтениями, см. `ApplyOutcome`. */
      readonly timeUnclear?: readonly [number, number] | undefined;
      /**
       * Цель нашлась, но правка не легла («менять нечего», срок не
       * подошёл) — разговор всё равно был о ней, и «удали это» следом
       * должно её найти (бой 23.09.2026, 03:41 → 03:47).
       */
      readonly itemId?: string | undefined;
      /**
       * Переспрос без кнопок: бот ждёт одну следующую реплику — название
       * дела или утро/вечер (см. `clarify.ts`).
       */
      readonly clarify?: ClarifyKind | undefined;
      /**
       * Цель не нашлась потому, что модель не ответила (панель, п. 4):
       * человеку — та же реплика, а в журнале это сбой, не непонимание.
       */
      readonly fault?: string | undefined;
      /**
       * Стоит ли попробовать ещё раз после сохранения новых записей
       * (задача 3.24).
       *
       * Цель могла не найтись по двум разным причинам, и путать их
       * нельзя. Либо её действительно нет — тогда черновик и есть верный
       * исход. Либо она **сказана в этой же выгрузке** и ещё не
       * сохранена: правки разбираются до новых мыслей, и в базе её пока
       * не существует.
       *
       * Второй случай найден на боевом 01.09.2026: «...не в 11, а в 9»,
       * сразу «Нет, лучше не в 9, а в 9 30» — и поправка ушла в
       * черновик, а в записи осталось промежуточное значение.
       */
      readonly retryAfterSave?: boolean | undefined;
    };

/** Вектор сегмента. Не посчитался — работаем без смыслового поиска. */
async function vectorOf(
  deps: ResolveDeps,
  params: ResolveSegmentParams,
): Promise<readonly number[] | undefined> {
  if (deps.embedder === undefined) return undefined;

  try {
    return await embedText(
      {
        db: deps.db,
        provider: deps.embedder,
        ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        ...(deps.pricing === undefined ? {} : { pricing: deps.pricing }),
        // Страж расхода: вектор правки — платный вызов, и потолок
        // обязан его останавливать так же, как вызов модели (3.82).
        ...(deps.ai.spendGuard === undefined ? {} : { spendGuard: deps.ai.spendGuard }),
      },
      {
        text: params.text,
        purpose: 'query',
        userId: params.userId,
        batchId: params.batchId,
      },
    );
  } catch (error) {
    deps.logger?.warn({ err: error }, 'Вектор правки не посчитан, ищу без смыслового поиска');
    return undefined;
  }
}

export async function resolvePatchSegment(
  deps: ResolveDeps,
  params: ResolveSegmentParams,
): Promise<SegmentResult> {
  const now = params.now ?? new Date();

  const period = mentionedPeriod(params.text, { now, timeZone: params.timeZone });
  const vector = await vectorOf(deps, params);

  const candidates = await collectCandidates(deps.db, {
    userId: params.userId,
    now,
    ...(vector === undefined ? {} : { vector }),
    ...(period === undefined ? {} : { period }),
    ...(params.topic === undefined ? {} : { topic: params.topic }),
    ...(params.onlyOwnBatch === true ? { onlyBatch: params.batchId } : {}),
  });

  /**
   * Пусто при сужении до выгрузки — не «новая мысль» (задача 3.68).
   *
   * **Найдено живым прогоном проджекта 04.09.2026.** Он сказал: «наушники
   * я пока покупать не собираюсь, но желание оставь, потом к этому
   * вернусь». Маршрутизатор верно отнёс это к правкам. Но правка сказана
   * после мысли, а такие ищут цель **только внутри своей выгрузки**
   * (задача 3.24, чтобы не поправить похожую старую запись). Запись
   * «Купить себе новые наушники» лежала в **предыдущей** выгрузке —
   * кандидатов ноль.
   *
   * А при пустом списке `resolveSegment` не спрашивает модель вовсе и
   * возвращает «завести»: разбирать нечего. Дальше это читается как
   * «новая мысль», и просьба «желание оставь» превратилась в запись
   * «Подумать о покупке наушников» — двойник рядом с настоящим желанием.
   *
   * **Пустота при сужении ничего не доказывает.** Она означает, что мы
   * искали в слишком маленьком месте, а не что цели нет. Поэтому здесь
   * отказ с просьбой поискать шире: конвейер повторит тот же отрезок с
   * широким поиском (`searchEverywhere`), и только там пустота станет
   * настоящим ответом.
   *
   * Модель при этом не зовётся ни разу — лишнего расхода нет.
   */
  if (params.onlyOwnBatch === true && candidates.length === 0) {
    deps.logger?.info(
      { userId: params.userId, batchId: params.batchId },
      'Внутри выгрузки цели нет — прошу поискать шире, а не считаю новой мыслью',
    );

    return {
      kind: 'parked',
      reason: 'внутри своей выгрузки цели не нашлось, нужен широкий поиск',
      retryAfterSave: true,
    };
  }

  /**
   * «Удали это дело» — указание, а не название (живой прогон Никиты
   * 23.09.2026, 03:16; см. `deixis.ts`). «Это» — запись, которую только
   * что трогали, если такая одна; сигнал тот же, что «подтверждено
   * свежестью» в `decision.ts`. Отмена и выполнение применяются без
   * модели: ей тут опереться не на что, на бою она вернула номер вне
   * списка. Перенос идёт к модели, но выбирать ей не из чего — только
   * указанная запись.
   */
  /**
   * Дело не названо (решение Никиты 23.09.2026): «Перенеси дело на пол 3».
   * Недавно говорили о деле — предложить его; нет — «Какое дело?», без
   * угадывания. Внутри выгрузки не работает: там «перенеси на завтра»
   * после мысли — про неё, и это решают соседи (задача 3.24).
   */
  if (params.onlyOwnBatch !== true && namesNoDeed(params.text)) {
    // «Это» — дело из последнего разговора, а не только последнее
    // изменённое (бой 23.09.2026: «менять нечего» запись не меняет).
    const discussed = await lastDiscussed(deps.db, {
      userId: params.userId,
      batchId: params.batchId,
      now,
      windowMs: DEFAULT_THRESHOLDS.freshMinutes * 60_000,
    });
    const target = discussed.length === 1 ? discussed[0] : undefined;

    if (target === undefined) {
      return {
        kind: 'parked',
        reason: `сказано «это», а дел в последнем разговоре ${String(discussed.length)}`,
        said: 'which',
        clarify: 'which',
      };
    }

    const action =
      deicticAction(params.text) ??
      (params.intent === 'CANCEL'
        ? 'cancel'
        : params.intent === 'COMPLETE'
          ? 'complete'
          : undefined);

    if (action !== undefined) {
      deps.logger?.info(
        { userId: params.userId, batchId: params.batchId, action },
        'Указание «это» — только что тронутая запись, модель не зовётся',
      );
      const outcome = await applyDecision(deps.db, {
        userId: params.userId,
        itemId: target.id,
        action,
        changes: emptyChanges(),
        spoken: params.text,
        timeZone: params.timeZone,
        now,
        reason: 'указано «это» — только что тронутая запись',
        changedBy: 'resolver',
      });
      return await settle(deps, outcome, target.id);
    }

    /**
     * Перенос и прочие правки — предложением, не применением: дело не
     * названо, и человек подтверждает одним нажатием. Модель зовётся
     * ради срока, но выбирать ей не из чего — только это дело.
     */
    if (params.questionTaken === true) {
      return {
        kind: 'parked',
        reason: 'дело не названо, а вопрос за эту выгрузку уже задан (§13.9)',
        itemId: target.id,
      };
    }

    const offered = await resolveSegment(deps.ai, {
      segment: params.text,
      candidates: [target],
      timeZone: params.timeZone,
      now,
      userId: params.userId,
      batchId: params.batchId,
    });
    const changes = offered.changes ?? emptyChanges();
    const question = await askQuestion(deps.db, {
      userId: params.userId,
      itemId: target.id,
      batchId: params.batchId,
      segment: params.text,
      action: 'update',
      changes,
      ...(offered.mode === undefined ? {} : { mode: offered.mode }),
      now,
    });

    return {
      kind: 'asked',
      questionId: question.id,
      itemTitle: target.text,
      action: 'update',
      deadline: changes.deadline,
    };
  }

  /**
   * Пороги читаются здесь — в момент решения, а не при старте.
   *
   * §15 обещает правку без выкладки: значение, запомненное при подъёме
   * бота, этого обещания не исполняет.
   */
  const thresholds = await effectiveThresholds(deps.settings);

  const resolved = await resolveSegment(deps.ai, {
    segment: params.text,
    candidates,
    timeZone: params.timeZone,
    now,
    userId: params.userId,
    batchId: params.batchId,
    ...(thresholds === undefined ? {} : { thresholds }),
  });

  const decision = resolved.decision;

  deps.logger?.info(
    {
      userId: params.userId,
      batchId: params.batchId,
      candidates: candidates.length,
      kind: decision.kind,
      why: decision.why,
      confidence: resolved.confidence,
    },
    'Резолвер разобрал правку',
  );

  if (decision.kind === 'create') {
    /**
     * «Новая мысль» и «не разобрались» — разные исходы.
     *
     * Первое сказала модель, глядя на записи человека: значит из
     * сказанного выйдет запись. Второе означает, что цели не нашлось, и
     * записью «нет, в пятницу» становиться не должно — получится задача
     * «в пятницу», а это хуже, чем не разобрать вовсе.
     */
    /**
     * Закрытие и отмена без записи — не мысль (прогон 15.09.2026,
     * находка 5): «мусор я уже вынес, можно убрать» становилось открытым
     * делом «Вынести мусор». Модель честно сказала «записи нет» — и это
     * верный ответ, когда её нет; неверной была развилка. Слова — в
     * черновик, человеку — «такого дела не было». Цель могла быть
     * сказана в этой же выгрузке (на бою — «выкинуть мусор» внутри дела
     * про балкон): конвейер попробует ещё раз после сохранения.
     */
    if (decision.newThought && (params.intent === 'COMPLETE' || params.intent === 'CANCEL')) {
      return {
        kind: 'parked',
        reason: 'сказано как о сделанном или отменённом, а такой записи нет',
        said: 'absent',
        retryAfterSave: true,
      };
    }

    /**
     * Правка без единого кандидата, но с делом внутри, — мысль (стенд
     * 21.09.2026, живой набор `live-08`).
     *
     * «Зато надо записаться к стоматологу, ой, не к стоматологу, к
     * косметологу» маршрутизатор отдаёт правкой; у человека без записей
     * кандидатов нет, модель не зовётся, и решение «создать, но не
     * мысль» отправляло дело в черновик. Правило второго этапа верно для
     * «нет, в пятницу» — там мысли нет. Но слово долга или глагол дела
     * (`thought-words.ts`, закрытые списки) отличают дело от обрывка, и
     * без записей спорить с ними некому. Только когда кандидатов не
     * было вовсе: решение модели, видевшей записи, не перебивается.
     */
    const thoughtWithoutCandidates =
      candidates.length === 0 && params.intent === 'PATCH' && looksLikeThought(params.text);

    if (thoughtWithoutCandidates) {
      deps.logger?.info(
        { userId: params.userId, batchId: params.batchId },
        'Правка без кандидатов несёт дело — разбираем как мысль',
      );
    }

    return decision.newThought || thoughtWithoutCandidates
      ? { kind: 'newThought' }
      : {
          kind: 'parked',
          reason: `резолвер не нашёл цели: ${decision.why}`,
          ...(resolved.ok ? {} : { fault: `резолвер не ответил: ${resolved.problem ?? '?'}` }),
          // Цель могла быть названа в этой же выгрузке и ещё не
          // сохранена — конвейер попробует снова после сохранения.
          retryAfterSave: true,
        };
  }

  const candidate = decision.candidate;
  if (candidate === undefined) return { kind: 'parked', reason: 'решение без записи' };

  if (decision.kind === 'ask') {
    if (params.questionTaken === true) {
      return {
        kind: 'parked',
        reason: 'цель нашлась, но вопрос за эту выгрузку уже задан (§13.9)',
      };
    }

    const question = await askQuestion(deps.db, {
      userId: params.userId,
      itemId: candidate.id,
      batchId: params.batchId,
      segment: params.text,
      action: decision.action,
      changes: resolved.changes ?? emptyChanges(),
      /**
       * Режим правки едет с вопросом (задача 3.82).
       *
       * Без него ответ на вопрос про **дополнение** применялся как
       * замена: подробность выбрасывалась, менять оказывалось нечего, а
       * человек получал «Добавила к прошлой». Различие §7.4 резолвер
       * возвращает — терять его между вопросом и ответом нельзя.
       */
      ...(resolved.mode === undefined ? {} : { mode: resolved.mode }),
      now,
    });

    return {
      kind: 'asked',
      questionId: question.id,
      itemTitle: candidate.text,
      action: decision.action,
      deadline: (resolved.changes ?? emptyChanges()).deadline,
    };
  }

  /**
   * Замена не может стать дополнением (§7.1, боевое 02.09.2026).
   *
   * «нет, няня пусть приходит в 9 30» модель разобрала дополнением: время
   * ушло в подробности, а заголовок остался врать «в 9». Признак замены
   * §7.1 задан закрытым списком, значит решает он.
   *
   * **Но только если модель дала новый текст.** Без него замена вышла бы
   * пустой: `applyDecision` не нашёл бы что менять, правка стала бы
   * «запись уже в нужном состоянии» и ушла в черновик **молча**. Это
   * хуже неточного дополнения — там человек хотя бы видит, что его
   * услышали, и может отменить. Замер на контрольном наборе показал, что
   * модель здесь чаще отвечает вопросом, а не дополнением, поэтому
   * случай редкий и осторожность дешёвая.
   */
  const replaceInstead =
    resolved.mode === 'append' &&
    startsWithReplacement(params.text) &&
    (resolved.changes?.text ?? '').trim().length > 0;

  const mode = replaceInstead ? 'replace' : resolved.mode;

  const outcome = await applyDecision(deps.db, {
    userId: params.userId,
    itemId: candidate.id,
    action: decision.action === 'new' ? 'update' : decision.action,
    ...(mode === undefined ? {} : { mode }),
    changes: resolved.changes ?? emptyChanges(),
    // §3.8б: «запомни» видно только в сказанном.
    spoken: params.text,
    timeZone: params.timeZone,
    now,
    reason: decision.why,
    changedBy: 'resolver',
  });

  return await settle(deps, outcome, candidate.id);
}

/** Исход применения — в исход отрезка: парковка с причиной или правка. */
async function settle(
  deps: ResolveDeps,
  outcome: ApplyOutcome,
  /** О каком деле шла речь: и при «менять нечего» это разговор о нём. */
  itemId: string,
): Promise<SegmentResult> {
  /**
   * Не применилось — парковка с настоящей причиной и словом человеку
   * (ревизия этапа 3, A3 и A4).
   *
   * Раньше все три исхода звались «запись уже в нужном состоянии», и
   * черновик в панели врал разбирающему, а человек не слышал ничего.
   * «Менять нечего» — правда только для `unchanged`; отвергнутый срок и
   * исчезнувшая запись — свои причины и своя реплика.
   */
  if (outcome.kind !== 'applied') {
    return {
      kind: 'parked',
      reason:
        outcome.kind === 'unchanged'
          ? 'запись уже в нужном состоянии'
          : outcome.kind === 'refused'
            ? `правка отвергнута: ${outcome.reason}`
            : 'запись исчезла между поиском и правкой',
      said: outcome.kind,
      ...(outcome.kind === 'gone' ? {} : { itemId }),
      ...(outcome.kind === 'unchanged' && outcome.timeUnclear !== undefined
        ? { timeUnclear: outcome.timeUnclear, clarify: 'time' as const }
        : {}),
    };
  }

  const { applied } = outcome;

  /**
   * Заголовок сменился — пересчитываем вектор (план 2.9).
   *
   * Обещание плана дословно: «Считается при создании записи **и при
   * изменении заголовка**». Вторая половина не работала вовсе, и после
   * «не к врачу, а к стоматологу» смысловой источник кандидатов §7.2
   * продолжал искать запись по словам, которых в ней уже нет.
   *
   * **После записи, а не внутри неё.** Внутри `applyDecision` висит
   * `select … for update`, и платный вызов под открытой транзакцией
   * держал бы строку запертой всё время ожидания сети.
   *
   * **Только при смене текста.** Срок, тема и правило вектора не
   * касаются: он считается от заголовка. Платить за неизменившийся
   * текст — это тот же расход, за который проект уже бил себя по рукам.
   */
  await reembedIfRetitled(
    {
      db: deps.db,
      ...(deps.embedder === undefined ? {} : { provider: deps.embedder }),
      ...(deps.ai.spendGuard === undefined ? {} : { spendGuard: deps.ai.spendGuard }),
      ...(deps.pricing === undefined ? {} : { pricing: deps.pricing }),
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    },
    applied,
  );

  return { kind: 'applied', applied };
}
