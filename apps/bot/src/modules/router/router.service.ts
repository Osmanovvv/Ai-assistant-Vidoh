import { requestStructured, type AiClientDeps } from '../ai/client.js';
import type { Intent, RoutedSegments } from '../ai/schemas/index.js';
import { looksLikeAppend, looksLikeCorrection } from './append.js';

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

  const { segments, reordered } = orderByText(params.input, outcome.value.segments);

  /**
   * Дополнение к сказанному — правкой, а не новой мыслью (§7.4).
   *
   * Признаки правки в §7.1 перечислены закрытым списком, и «а ещё туда»
   * в него не входит: модель отвечает по спецификации, дыра между §7.1 и
   * §7.4 закрывается здесь, в коде. Промпт маршрутизатора не трогаем — он
   * теряет единицы от любого утяжеления.
   *
   * **Цена ошибки ограничена.** Если сегмент на самом деле новая мысль,
   * резолвер не найдёт цели и вернёт его в обычный разбор — запись всё
   * равно появится, потерян будет один вызов модели. Поэтому признак
   * требует двух примет сразу, а не одной.
   */
  const marked = segments.map((segment) =>
    segment.intent === 'DUMP' &&
    (looksLikeAppend(segment.text) || looksLikeCorrection(segment.text))
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

  if (reordered) {
    deps.logger?.warn(
      { promptVersion: outcome.promptVersion, count: segments.length },
      'Модель вернула намерения не в порядке текста, порядок исправлен',
    );
  }

  return {
    segments: marked,
    crisis: outcome.value.crisis,
    promptVersion: outcome.promptVersion,
    reordered,
    fallback: false,
  };
}
