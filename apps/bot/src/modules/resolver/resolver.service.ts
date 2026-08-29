import { requestStructured, type AiClientDeps } from '../ai/client.js';
import type { ResolverAnswer } from '../ai/schemas/index.js';
import { describeNow, localDateParts } from '../classifier/dates.js';
import type { Candidate } from './candidates.js';
import { decide, type Decision, type ResolverThresholds } from './decision.js';

/**
 * Резолвер: применить, спросить или создать (§7.3 ТЗ, задача 3.2).
 *
 * Модель получает текст сегмента и компактный список кандидатов и
 * возвращает структуру §7.3: действие, запись, уверенность, изменяемые
 * поля, обоснование. Решение из этого делает не она, а пороговая логика
 * (`decision.ts`) — модель о порогах ничего не знает.
 *
 * **Записи нумеруются, а не называются идентификаторами.** В список идут
 * номера «1», «2», «3», и ответ модели переводится обратно здесь. Две
 * причины. Первая — расход: сорок UUID это полторы тысячи знаков ни о
 * чём. Вторая важнее: выдуманный номер сразу виден, а выдуманный UUID
 * выглядит как настоящий.
 *
 * **Пустой список — не повод звонить модели.** Если кандидатов нет,
 * решать не из чего: сегмент станет новой записью. Вызов в этом случае
 * стоил бы денег и не мог бы изменить исход.
 */

export interface ResolveParams {
  /** Текст сегмента: то, что человек сказал сейчас. */
  readonly segment: string;
  readonly candidates: readonly Candidate[];
  readonly timeZone: string;
  readonly now?: Date | undefined;
  readonly userId?: string | undefined;
  readonly batchId?: string | undefined;
  readonly thresholds?: Partial<ResolverThresholds> | undefined;
}

export interface ResolveResult {
  /**
   * Ответ модели получен и разобран.
   *
   * При `false` решение всё равно есть — «создать новую запись». §7.3
   * говорит прямо: дубли лучше потери данных. Возвращать одну лишь
   * ошибку значило бы предложить каждому вызывающему изобретать этот
   * безопасный исход заново, и однажды кто-то изобрёл бы другой.
   */
  readonly ok: boolean;
  readonly decision: Decision;
  /** Пусто, если к модели не обращались. */
  readonly promptVersion: string;
  readonly problem?: string | undefined;
  /** Уверенность, как её назвала модель. В журнал, рядом с решением. */
  readonly confidence?: number | undefined;
  /**
   * Поля, которые модель предлагает изменить.
   *
   * Наружу они нужны двоим: тому, кто будет применять изменение, и
   * контрольному набору — иначе срок в разметке нечем сверить, а поле,
   * которое не проверяется, хуже отсутствующего.
   */
  readonly changes?: ResolverAnswer['changes'] | undefined;
}

const CREATE: Decision = {
  kind: 'create',
  action: 'new',
  why: 'кандидатов не нашлось',
};

/** Короткая дата в поясе человека: «04.09». */
function shortDate(at: Date, timeZone: string): string {
  const parts = localDateParts(at, timeZone);
  return `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}`;
}

/** Сколько времени прошло — словами, а не отметкой времени. */
function ago(at: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${String(minutes)} мин назад`;

  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${String(hours)} ч назад` : `${String(Math.round(hours / 24))} дн назад`;
}

/**
 * Строка кандидата.
 *
 * §7.2 перечисляет состав и запрещает полные тексты. Время последнего
 * изменения идёт словами: «2 мин назад» модель понимает как близость по
 * времени, а отметку `2026-08-29T11:58Z` ей пришлось бы вычитать.
 */
function describeCandidate(candidate: Candidate, index: number, params: ResolveParams, now: Date) {
  const deadline =
    candidate.deadlineAt === null
      ? 'без срока'
      : `срок ${shortDate(candidate.deadlineAt, params.timeZone)}`;

  return [
    `${String(index + 1)}. ${candidate.text}`,
    `тема: ${candidate.topic ?? 'нет'}`,
    deadline,
    `статус: ${candidate.status}`,
    `изменено: ${ago(candidate.updatedAt, now)}`,
  ].join(' · ');
}

function buildInput(params: ResolveParams, now: Date): string {
  const list = params.candidates
    .map((candidate, index) => describeCandidate(candidate, index, params, now))
    .join('\n');

  return [
    describeNow(now, params.timeZone),
    '',
    'Записи человека:',
    list,
    '',
    'Человек сказал:',
    params.segment,
  ].join('\n');
}

export async function resolveSegment(
  deps: AiClientDeps,
  params: ResolveParams,
): Promise<ResolveResult> {
  const now = params.now ?? new Date();

  if (params.candidates.length === 0) {
    return { ok: true, decision: CREATE, promptVersion: '' };
  }

  const outcome = await requestStructured<ResolverAnswer>(deps, {
    stage: 'resolver',
    input: buildInput(params, now),
    userId: params.userId,
    batchId: params.batchId,
  });

  if (!outcome.ok) {
    deps.logger?.warn(
      { promptVersion: outcome.promptVersion, problem: outcome.problem },
      'Резолвер не ответил, сегмент станет новой записью',
    );

    return {
      ok: false,
      decision: { ...CREATE, why: 'модель не ответила' },
      promptVersion: outcome.promptVersion,
      problem: outcome.problem,
    };
  }

  /**
   * Номер из ответа переводится в идентификатор записи.
   *
   * Всё, что номером не является или указывает за пределы списка,
   * превращается в пустую строку — и пороговая логика ответит «создать
   * новую». Она обязана получить настоящий идентификатор или ничего:
   * подставлять сюда догадку значило бы поправить случайную запись.
   */
  const position = Number.parseInt(outcome.value.itemId, 10);
  const chosen = Number.isInteger(position) ? params.candidates[position - 1] : undefined;

  const decision = decide({ ...outcome.value, itemId: chosen?.id ?? '' }, params.candidates, {
    now,
    thresholds: params.thresholds,
  });

  deps.logger?.debug(
    {
      promptVersion: outcome.promptVersion,
      action: outcome.value.action,
      confidence: outcome.value.confidence,
      kind: decision.kind,
      why: decision.why,
    },
    'Резолвер принял решение',
  );

  return {
    ok: true,
    decision,
    promptVersion: outcome.promptVersion,
    confidence: outcome.value.confidence,
    changes: outcome.value.changes,
  };
}
