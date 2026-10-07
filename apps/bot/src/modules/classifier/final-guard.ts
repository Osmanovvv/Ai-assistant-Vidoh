import type { ExtractedUnit } from '../extractor/extractor.service.js';
import type { ItemType } from '../ai/schemas/classifier.js';
import { sameWord } from '../resolver/clarify.js';
import { FUNCTION_WORDS, namesDay, tokens } from './own-sentence.js';
import { semanticTopicFor } from './topic-routing.js';
import type { ResolvedDeadline } from './dates.js';

export interface FinalGuardItem {
  readonly text: string;
  readonly type?: ItemType | undefined;
  readonly topic: string;
  readonly wantedTopic?: string | undefined;
  readonly deadline?: ResolvedDeadline | undefined;
}

export interface FinalGuardParams {
  readonly units: readonly ExtractedUnit[];
  readonly items: readonly FinalGuardItem[];
  readonly topics: readonly string[];
  readonly spoken?: string | undefined;
  readonly now: Date;
  readonly timeZone: string;
}

export type FinalGuardIssueKind = 'coverage' | 'merged' | 'deadline' | 'topic';

export interface FinalGuardIssue {
  readonly kind: FinalGuardIssueKind;
  readonly itemIndex?: number;
  readonly unitIndex?: number;
  readonly detail: string;
}

/**
 * Последняя проверка результата классификации перед сохранением.
 *
 * Модель и промежуточные коррекции могут вернуть формально валидный JSON,
 * который всё ещё содержит две единицы в одном тексте, переносит срок из
 * соседней единицы или оставляет явную смысловую сферу без исправления.
 * Такой результат безопаснее отправить в черновик, чем записать в бэклог.
 */
export function validateFinalItems(params: FinalGuardParams): readonly FinalGuardIssue[] {
  const activeUnits = params.units
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => !unit.isEmotion);
  if (activeUnits.length === 0) return [];

  const unitWords = activeUnits.map(({ unit }) => significantWords(unit.text));
  // Идеи, сведения и эмоции не являются задачами, а короткие/одинаковые
  // единицы нельзя надёжно сопоставить по словам («дело», «ещё дело»).
  // Их оставляет существующая логика классификатора; страж проверяет только
  // атомарные задачи с достаточным количеством отличительных слов.
  if (unitWords.some((words) => words.length < 2)) return [];

  const checkedItems = params.items.filter(
    (item) => item.type === undefined || item.type === 'TASK',
  );
  if (checkedItems.length === 0) return [];
  // A shorter result is handled by the dedicated missing-unit retry.  It is
  // intentionally not rejected here: a single compound thought may be a
  // legitimate one-record result (projects and list tails use this path).
  const canCheckCrossUnitMerge = checkedItems.length >= activeUnits.length;
  const scores = checkedItems.map((item) =>
    unitWords.map((words) => overlap(significantWords(item.text), words)),
  );
  const issues: FinalGuardIssue[] = [];

  for (const [itemIndex, itemScores] of scores.entries()) {
    const item = checkedItems[itemIndex];
    if (item === undefined) continue;

    const owners = itemScores
      .map((score, position) => ({ score, position }))
      .filter(({ score, position }) => score >= ownershipThreshold(unitWords[position] ?? []));

    const owner = owners.sort((one, two) => two.score - one.score)[0];
    if (owner === undefined) continue;
    const unit = activeUnits[owner.position];
    if (unit === undefined) continue;

    // Cross-unit contamination is only actionable when the item has a clear
    // owner and at least two *exclusive* words from another unit. Shared
    // heads ("молоко"/"два литра") are elaborations, not a merge. A project
    // may also intentionally absorb a short list tail.
    if (canCheckCrossUnitMerge && !activeUnits.some(({ unit: source }) => source.isProject)) {
      const ownWords = unitWords[owner.position] ?? [];
      const itemWords = significantWords(item.text);
      const foreign = activeUnits.some(({ unit: source }, position) => {
        if (position === owner.position) return false;
        const sharedWithOwner = new Set(
          ownWords.filter((word) =>
            significantWords(source.text).some((candidate) => sameWord(candidate, word)),
          ),
        );
        const exclusiveMatches = significantWords(source.text).filter(
          (word) =>
            !sharedWithOwner.has(word) && itemWords.some((candidate) => sameWord(candidate, word)),
        );
        return exclusiveMatches.length >= 2;
      });
      if (foreign) {
        issues.push({
          kind: 'merged',
          itemIndex,
          detail: `запись «${item.text}» содержит слова нескольких единиц извлечения`,
        });
        continue;
      }
    }

    // When the caller has no original speech, only the literal unit text is
    // evidence we can use. In that limited mode, do not let a date-bearing
    // neighbour lend its date to a unit that contains no date of its own.
    // With speech available the established sentence/date resolver is the
    // source of truth and this conservative check stays out of the way.
    if (
      params.spoken === undefined &&
      item.deadline !== undefined &&
      activeUnits.some(
        ({ unit: source }, position) => position !== owner.position && namesDay(source.text),
      ) &&
      !namesDay(unit.unit.text)
    ) {
      issues.push({
        kind: 'deadline',
        itemIndex,
        unitIndex: unit.index,
        detail: `срок записи «${item.text}» не подтверждён словами её единицы`,
      });
    }

    const semantic =
      item.wantedTopic === undefined
        ? semanticTopicFor(`${unit.unit.text} ${item.text}`, params.topics)
        : undefined;
    if (semantic !== undefined && item.topic.trim().toLowerCase() !== semantic.name.toLowerCase()) {
      issues.push({
        kind: 'topic',
        itemIndex,
        unitIndex: unit.index,
        detail: `сфера записи «${item.text}» не совпадает с сильным признаком «${semantic.name}»`,
      });
    }
  }

  return issues;
}

function significantWords(text: string): readonly string[] {
  return tokens(text).filter((word) => word.length >= 4 && !FUNCTION_WORDS.has(word));
}

function overlap(one: readonly string[], other: readonly string[]): number {
  return other.filter((word) => one.some((candidate) => sameWord(candidate, word))).length;
}

function ownershipThreshold(words: readonly string[]): number {
  return Math.min(2, words.length);
}
