import { requestStructured, type AiClientDeps } from '../ai/client.js';
import type { Intent, RoutedSegments } from '../ai/schemas/index.js';
import {
  looksLikeAppend,
  looksLikeCorrection,
  looksLikeExplicitAppend,
  startsWithReplacement,
} from './append.js';
import { splitClosings } from './closing.js';
import { restoreUncovered } from './coverage.js';
import { splitDayQuestions } from './day-question.js';
import { splitPatchTails } from './patch-tail.js';
import { looksLikeThought } from './thought-words.js';

/**
 * Маршрутизатор намерений (задача 2.4).
 *
 * §7.1 ТЗ: одна выгрузка может содержать несколько разных намерений.
 * «Купил продукты, а ещё надо к врачу, и что у меня на завтра?» — это
 * `COMPLETE`, `DUMP` и `QUERY` в одной фразе.
 *
 * Порядок применения сегментов — строго по тексту. В ТЗ он не задан, а без
 * него фраза «записать сына к врачу в четверг… хотя нет, в пятницу» внутри
 * одного голосового создаст две записи вместо одной исправленной. Порядок
 * не доверяется модели: он проверяется по исходному тексту (см. ниже).
 *
 * Работает на лёгкой модели: здесь надо не понять смысл сказанного, а
 * различить семь видов намерения, и полная модель для этого дороже без
 * выигрыша в качестве.
 */

export interface Segment {
  readonly intent: Intent;
  readonly text: string;
}

export interface RouteParams {
  /** Склеенный текст выгрузки. */
  readonly input: string;
  readonly userId?: string | undefined;
  readonly batchId?: string | undefined;
  /**
   * Открытый уточняющий вопрос бота, если он есть.
   *
   * При открытом вопросе намерение `ANSWER` проверяется первым: человек
   * скорее отвечает на вопрос, чем начинает новую мысль. Без этого его
   * «в четверг» уйдёт в `DUMP` и создаст задачу без задачи.
   */
  readonly openQuestion?: string | undefined;
}

export interface RouteResult {
  readonly segments: readonly Segment[];
  /**
   * §13.7: модель увидела признаки острого кризиса. Второй контур из
   * двух — решение принимает не этот флаг сам по себе, а модуль safety.
   */
  readonly crisis: boolean;
  readonly promptVersion: string;
  /**
   * Модель вернула сегменты не в порядке текста, и порядок был исправлен.
   * Частые срабатывания — повод посмотреть промпт.
   */
  readonly reordered: boolean;
  /**
   * Разобрать намерения не удалось, вся выгрузка считается одной мыслью.
   * Не ошибка: `DUMP` — самое частое намерение, и такая замена ничего не
   * теряет, в отличие от отказа обрабатывать выгрузку.
   */
  readonly fallback: boolean;
}

/**
 * Приводит текст к виду, годному для поиска подстроки.
 *
 * Пунктуация и регистр снимаются с обеих сторон одинаково, поэтому
 * положения в нормализованной строке сопоставимы.
 */
function normalize(text: string): string {
  return (
    text
      .toLowerCase()
      // «ё» и «е» считаем одной буквой. Распознавание речи возвращает
      // «еще», а не «ещё» — это видно в живых расшифровках, — а модель
      // в своём ответе может написать и так и так. Без этого «успеть всё»
      // и «успеть все» окажутся разными делами.
      .replace(/ё/gu, 'е')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  );
}

/**
 * Сколько знаков сегмента искать в исходном тексте.
 *
 * Короче — начнутся ложные совпадения: «надо» встречается в выгрузке
 * пять раз. Длиннее — любой пересказ моделью перестанет находиться.
 */
const NEEDLE_LENGTH = 24;

interface Ordering {
  readonly segments: readonly Segment[];
  readonly reordered: boolean;
}

/**
 * Расставляет сегменты в порядке их появления в исходном тексте.
 *
 * Если хотя бы один сегмент в тексте не нашёлся — модель его пересказала —
 * порядок оставляется как есть целиком. Половинчатая перестановка хуже
 * любой из двух: она перемешала бы проверенное с непроверенным.
 */
export function orderByText(input: string, segments: readonly Segment[]): Ordering {
  if (segments.length < 2) return { segments, reordered: false };

  const haystack = normalize(input);

  const placed = segments.map((segment, index) => ({
    segment,
    index,
    at: haystack.indexOf(normalize(segment.text).slice(0, NEEDLE_LENGTH)),
  }));

  if (placed.some((item) => item.at < 0)) return { segments, reordered: false };

  const sorted = [...placed].sort((left, right) =>
    left.at === right.at ? left.index - right.index : left.at - right.at,
  );

  const reordered = sorted.some((item, position) => item.index !== position);

  return { segments: sorted.map((item) => item.segment), reordered };
}

/** Что отправляем модели: сама выгрузка плюс открытый вопрос, если он есть. */
function buildInput(params: RouteParams): string {
  if (params.openQuestion === undefined) return params.input;

  return `Открытый вопрос бота: ${params.openQuestion}\n\nСказанное человеком: ${params.input}`;
}

export async function routeIntents(deps: AiClientDeps, params: RouteParams): Promise<RouteResult> {
  const outcome = await requestStructured<RoutedSegments>(deps, {
    stage: 'router',
    input: buildInput(params),
    userId: params.userId,
    batchId: params.batchId,
  });

  if (!outcome.ok) {
    // Намерение не определилось — считаем, что человек просто выговорился.
    // Это самое частое намерение, и такая замена ничего не теряет, тогда
    // как отказ обрабатывать выгрузку оставил бы человека без ответа.
    deps.logger?.warn(
      { promptVersion: outcome.promptVersion, problem: outcome.problem },
      'Намерения не разобраны, вся выгрузка считается одной мыслью',
    );

    return {
      segments: [{ intent: 'DUMP', text: params.input }],
      // Модель не ответила — признака кризиса от неё нет. Второй контур
      // при этом остаётся: маркеры считаются в коде и без неё.
      crisis: false,
      promptVersion: outcome.promptVersion,
      reordered: false,
      fallback: true,
    };
  }

  // Пустой ответ тоже означает «просто мысль»: модель не нашла ни одного
  // намерения, но текст-то есть, и терять его нельзя.
  if (outcome.value.segments.length === 0) {
    return {
      segments: [{ intent: 'DUMP', text: params.input }],
      crisis: outcome.value.crisis,
      promptVersion: outcome.promptVersion,
      reordered: false,
      fallback: true,
    };
  }

  const ordered = orderByText(params.input, outcome.value.segments);
  const { reordered } = ordered;

  /**
   * Обрезанный ответ модели (бой 21.09.2026, выгрузка Никиты): третий
   * отрезок оборван на полуслове, хвоста с четырьмя делами в ответе нет.
   * Непокрытый отрезками кусок с делами возвращается в разбор мыслью
   * на своём месте — см. `coverage.ts`.
   */
  const segments = restoreUncovered(params.input, ordered.segments);

  if (segments.length !== ordered.segments.length) {
    deps.logger?.warn(
      {
        promptVersion: outcome.promptVersion,
        restored: segments.length - ordered.segments.length,
      },
      'Модель вернула не весь текст, непокрытый кусок с делами возвращён в разбор мыслью',
    );
  }

  /**
   * Дополнение к сказанному — правкой, а не новой мыслью (§7.4).
   *
   * Признаки правки в §7.1 перечислены закрытым списком, и «а ещё туда»
   * в него не входит: модель отвечает по спецификации, дыра между §7.1 и
   * §7.4 закрывается здесь, в коде. Промпт маршрутизатора не трогаем — он
   * теряет единицы от любого утяжеления.
   *
   * **Цена ошибки ограничена, но не нулевая.** Если сегмент на самом
   * деле новая мысль, резолвер не найдёт цели и вернёт его в обычный
   * разбор — запись появится, потерян будет один вызов модели. Сегмент
   * **после мысли** разбирается уже после сохранения, и в прошедший
   * разбор его не вставить — ему идёт свой проход извлечения и
   * классификации (`absorbLateThoughts` в конвейере выгрузки), то есть
   * ещё два вызова. Ревизия этапа 3, A4-средняя: до неё такой сегмент
   * ложился черновиком, а здесь обещалось «запись всё равно появится».
   * Поэтому признак требует двух примет сразу, а не одной: каждая ошибка
   * стоит вызовов модели.
   *
   * **Исключение — закрытый список §7.1.** Признаки замены («нет»,
   * «перенеси», «вместо», «лучше», «поменяй») названы спецификацией
   * прямо, и одной приметы там достаточно: список составляло ТЗ, а не
   * наш вкус. Требуется только место — начало реплики: «надо перенести
   * цветы на балкон» это дело, а «перенеси посылку на пятницу» — приказ.
   *
   * **Найдено живым прогоном Никиты 22.09.2026.** «Перенеси посылку на
   * пятницу на 10 утра» маршрутизатор назвал мыслью, и рядом с записью
   * про посылку встала третья — «Перенести посылку на пятницу на .».
   * `startsWithReplacement` к тому дню уже существовала, но её читал
   * только резолвер: то есть лишь тогда, когда модель **сама** назвала
   * отрезок правкой. На разметку признак не влиял вовсе.
   */
  const marked = segments.map((segment) =>
    (segment.intent === 'DUMP' &&
      (looksLikeAppend(segment.text) ||
        looksLikeCorrection(segment.text) ||
        startsWithReplacement(segment.text))) ||
    // «К банку добавь: …» — и мыслью, и вопросом (прогон 17.09.2026):
    // человек назвал и запись, и действие, спорить с этим модели нечем.
    ((segment.intent === 'DUMP' || segment.intent === 'QUERY') &&
      looksLikeExplicitAppend(segment.text))
      ? { ...segment, intent: 'PATCH' as const }
      : segment,
  );

  const appended = marked.filter((one, index) => one.intent !== segments[index]?.intent).length;

  if (appended > 0) {
    deps.logger?.info(
      { promptVersion: outcome.promptVersion, count: appended },
      'Сегмент похож на дополнение или поправку к сказанному, разбираем как правку',
    );
  }

  /**
   * Разговор с делами внутри — мысль (бой 21.09.2026, выгрузка Никиты).
   *
   * Хвост перечисления «потом надо будет позвонить маме… вот в общем
   * вроде всё» модель назвала разговором, и четыре дела пропали молча:
   * разговор конвейер не разбирает и в черновик не кладёт. Слово долга
   * или глагол дела в таком отрезке — признак мысли; списки закрытые,
   * см. `thought-words.ts`.
   */
  const thoughts = marked.map((segment) =>
    segment.intent === 'SMALLTALK' && looksLikeThought(segment.text)
      ? { ...segment, intent: 'DUMP' as const }
      : segment,
  );

  const rescued = thoughts.filter((one, index) => one.intent !== marked[index]?.intent).length;

  if (rescued > 0) {
    deps.logger?.info(
      { promptVersion: outcome.promptVersion, count: rescued },
      'Разговор с делами внутри разбираем как мысль',
    );
  }

  if (reordered) {
    deps.logger?.warn(
      { promptVersion: outcome.promptVersion, count: segments.length },
      'Модель вернула намерения не в порядке текста, порядок исправлен',
    );
  }

  /**
   * Вопрос о дне внутри мысли — кодом (серия голосовых 18.09.2026,
   * голос 3): расшифровка склеивает «что у меня на завтра» с соседними
   * мыслями, и модель то делает из вопроса дело, то теряет мысль в
   * вопросе. См. `day-question.ts`.
   */
  const withQuestions = splitDayQuestions(thoughts);

  if (withQuestions.length !== thoughts.length) {
    deps.logger?.info(
      {
        promptVersion: outcome.promptVersion,
        before: thoughts.length,
        after: withQuestions.length,
      },
      'Вопрос о дне внутри мысли выделен кодом',
    );
  }

  /**
   * Отметка и отмена — по одному делу на отрезок (серия голосовых
   * 18.09.2026, голос 5): «продукты купила, а в школу звонить не надо»
   * модель отдаёт одним закрытием, и резолвер не может выбрать дело.
   * См. `closing.ts`.
   */
  const split = splitClosings(withQuestions);

  if (split.length !== withQuestions.length) {
    deps.logger?.info(
      { promptVersion: outcome.promptVersion, before: withQuestions.length, after: split.length },
      'Закрытия разрезаны кодом по одному делу',
    );
  }

  /**
   * Мысль, приклеенная к правке (серия голосовых 18.09.2026, голос 10):
   * «хотя нет, лучше в пятницу ещё оплатить садик» без точек уходило
   * правкой целиком, и резолвер терял перенос. См. `patch-tail.ts`.
   */
  const withTails = splitPatchTails(split);

  if (withTails.length !== split.length) {
    deps.logger?.info(
      { promptVersion: outcome.promptVersion, before: split.length, after: withTails.length },
      'Мысль после правки отделена кодом',
    );
  }

  return {
    segments: withTails,
    crisis: outcome.value.crisis,
    promptVersion: outcome.promptVersion,
    reordered,
    fallback: false,
  };
}
