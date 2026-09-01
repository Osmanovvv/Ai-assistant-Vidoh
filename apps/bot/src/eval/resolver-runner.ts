import type { AiClientDeps } from '../modules/ai/client.js';
import { resolveSegment } from '../modules/resolver/resolver.service.js';
import { candidatesOf, targetsOf, type ResolverCase } from './resolver-dataset.js';
import type { ResolverCaseOutcome } from './resolver-report.js';

/**
 * Прогон одного случая через настоящий резолвер (§10.3 ТЗ).
 *
 * Через `resolveSegment`, а не через отдельную копию логики: набор должен
 * мерить то, что работает в бою, вместе с построением запроса и
 * переводом номера обратно в запись. Своя упрощённая обвязка мерила бы
 * промпт, а не продукт.
 */

export async function runResolverCase(
  deps: AiClientDeps,
  item: ResolverCase,
): Promise<ResolverCaseOutcome> {
  const now = new Date(item.now);
  const candidates = candidatesOf(item);

  const result = await resolveSegment(deps, {
    segment: item.segment,
    candidates,
    timeZone: item.timeZone,
    now,
  });

  const decision = result.decision;
  const acceptable = targetsOf(item).map((number) => candidates[number - 1]?.id);

  /**
   * Запись сверяется только там, где решение о ней и есть.
   *
   * При «создать новую» речь ни о какой существующей записи не идёт, и
   * требовать совпадения было бы требованием к пустоте.
   */
  const targetOk =
    item.expected.kind === 'create' ? true : acceptable.includes(decision.candidate?.id);

  /**
   * Срок сверяется по тому, что назвала модель, а не по базе.
   *
   * «Нет, в пятницу» обязано превратиться в конкретный день, и ошибка
   * здесь — настоящая ошибка разбора: напоминание придёт не вовремя.
   * Применение этого срока к записи проверяет свой интеграционный тест,
   * с базой; здесь мерится решение.
   */
  const deadlineOk =
    item.expected.deadline === undefined
      ? true
      : result.changes?.deadline === item.expected.deadline;

  /**
   * Режим сверяется только там, где случай его задал.
   *
   * §7.4 различает замену и дополнение, но большинство случаев про
   * другое, и требовать от них угаданного режима значило бы мерить шум.
   */
  const modeOk = item.expected.mode === undefined ? true : result.mode === item.expected.mode;

  /**
   * Переписан ли заголовок — и там ли, где просили.
   *
   * Самая тихая из ошибок разбора: запись остаётся, срок верный, а слова
   * человека подменены пересказом модели. Заметить это можно только
   * сверкой, потому оно и мерится.
   */
  const rewritten = (result.changes?.text ?? '').trim().length > 0;
  const textOk =
    item.expected.text === undefined
      ? true
      : item.expected.text === 'rewritten'
        ? rewritten
        : !rewritten;

  return {
    id: item.id,
    expected: item.expected.kind,
    actual: decision.kind,
    targetOk,
    deadlineOk,
    modeOk,
    textOk,
    confidence: result.confidence,
    failed: !result.ok,
  };
}

export async function runResolverDataset(
  deps: AiClientDeps,
  cases: readonly ResolverCase[],
  onCase?: (outcome: ResolverCaseOutcome) => void,
): Promise<ResolverCaseOutcome[]> {
  const outcomes: ResolverCaseOutcome[] = [];

  for (const item of cases) {
    const outcome = await runResolverCase(deps, item);
    outcomes.push(outcome);
    onCase?.(outcome);
  }

  return outcomes;
}
