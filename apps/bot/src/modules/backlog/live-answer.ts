import {
  requestStructured,
  type AiClientDeps,
  type StructuredOutcome,
  type StructuredRequest,
} from '../ai/client.js';
import { ANSWERER_SCHEMA_NAME, type LiveAnswer } from '../ai/schemas/index.js';
import type { Item } from '../../db/schema.js';
import { isoDateIn, localDateParts, startOfDayInZone } from '../classifier/dates.js';
import { deadlineWords, dueWords, shortDate } from '../items/deadline-words.js';
import { partOfDayIn } from '../presenter/context-pack.js';
import { checkVoice, type CheckedLine, type VoiceLimits } from '../presenter/context-line.js';
import type { ProjectContext } from '../projects/projects.service.js';
import { titleWithoutDate } from '../resolver/title-date.js';
import type { TextProfile } from '../../texts/index.js';
import { counted } from '../../texts/plural.js';
import type { BacklogAnswer } from './query.service.js';

/**
 * Живой ответ на вопрос о своих делах (слой B, 22.09.2026).
 *
 * §13.4 ТЗ: «Напомни, что я хотела сделать с альбомом» → «Ты хотела
 * сделать семейный альбом. Последний шаг, на котором мы остановились:
 * выбрать первые фотографии.» Заказчица 21.09: «чтобы помнил из
 * контекста… а не только набором конкретных реплик». Сейчас на такой
 * вопрос уходит шапка «Вот что у меня про это записано:» и список.
 *
 * Разделение труда прежнее: **записи находит код** (`answerBacklogQuery`
 * — рамки дня, списки по признаку, смысловой поиск), модель только
 * **говорит о найденном словами** — по закрытому списку фактов, под тем
 * же стражем, что живая строка (`checkVoice`), с пределами ответа: до
 * трёх фраз, один вопрос. Не прошла, пусто или модель молчит — ответ
 * словарный, как раньше. Списки по рамке дня и сферам остаются кодом:
 * там точность важнее прозы.
 */

const MAX_FOUND = 8;
const MAX_OVERVIEW = 4;
const SOON_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

export interface QuestionFactsParams {
  readonly question: string;
  readonly now: Date;
  readonly timeZone: string;
  readonly texts: TextProfile;
  readonly answer: BacklogAnswer;
  /** Для большой цели — её шаги. */
  readonly project?: ProjectContext | undefined;
  /** Когда по вопросу ничего не найдено — открытые дела для обзора. */
  readonly overview?: readonly Item[] | undefined;
}

function title(item: Item): string {
  return titleWithoutDate(item.text);
}

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function daysBetween(from: Date, to: Date, timeZone: string): number {
  const start = startOfDayInZone(localDateParts(from, timeZone), timeZone);
  const end = startOfDayInZone(localDateParts(to, timeZone), timeZone);
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}

function dueOf(
  item: Item,
  context: { readonly now: Date; readonly timeZone: string; readonly texts: TextProfile },
): string {
  if (item.deadlineAt === null) return 'без срока';
  // Прошедший день — назван прошедшим: «срок: 10.09» модель читала как
  // будущее и отвечала «определишься 10 сентября» про давно прошедшее.
  if (
    item.deadlineAccuracy === 'day' &&
    isoDateIn(item.deadlineAt, context.timeZone) < isoDateIn(context.now, context.timeZone)
  ) {
    const late = daysBetween(item.deadlineAt, context.now, context.timeZone);
    return `срок прошёл: ${shortDate(item.deadlineAt, context.timeZone)}, ${counted(late, ['день', 'дня', 'дней'])} назад`;
  }
  const words = dueWords(
    {
      deadlineAt: item.deadlineAt,
      deadlineAccuracy: item.deadlineAccuracy,
      deadlineTime: item.deadlineTime,
    },
    context,
    context.texts,
  );
  return `срок: ${words ?? 'сегодня'}`;
}

function stateOf(item: Item): string | undefined {
  if (item.status === 'done') return 'сделано';
  if (item.status === 'cancelled') return 'отменено';
  if (item.backgroundedAt !== null) return 'убрано в фон';
  if (item.deferredAt !== null) return 'отложено на потом';
  if (item.assignee !== null && item.assignee !== '') return `поручено: ${item.assignee}`;
  return undefined;
}

function foundLine(
  item: Item,
  context: { readonly now: Date; readonly timeZone: string; readonly texts: TextProfile },
): string {
  const state = stateOf(item);
  const kind =
    item.type === 'DESIRE'
      ? ', желание'
      : item.type === 'INFO'
        ? ', сведение'
        : item.type === 'IDEA'
          ? ', идея'
          : '';
  const base = `— ${title(item)} (${item.topic ?? 'без сферы'}${kind})`;
  if (state !== undefined) return `${base} — ${state}`;
  return `${base}, ${dueOf(item, context)}`;
}

/** Текст фактов для модели — и словарь для стража: числа и люди только отсюда. */
export function questionFacts(params: QuestionFactsParams): string {
  const { now, timeZone, texts, answer } = params;
  const context = { now, timeZone, texts };
  const lines: string[] = [
    `Вопрос: ${params.question.trim()}`,
    `Сейчас: ${partOfDayIn(now, timeZone)}`,
  ];

  if (answer.kind === 'about' || answer.kind === 'aboutClosed') {
    lines.push('Найдено по вопросу:');
    for (const item of answer.items.slice(0, MAX_FOUND)) lines.push(foundLine(item, context));
    return lines.join('\n');
  }

  if (answer.kind === 'project') {
    lines.push(`Большая цель: ${title(answer.item)}`);
    const project = params.project;
    if (project === undefined || project.done.length + project.remaining.length === 0) {
      lines.push('Шаги ещё не разложены');
      return lines.join('\n');
    }
    if (project.done.length > 0)
      lines.push(`Сделано: ${project.done.map((step) => step.text).join('; ')}`);
    if (project.next === undefined) lines.push('Все шаги закрыты');
    else {
      lines.push(`Следующий шаг: ${project.next.text}`);
      const rest = project.remaining.filter((step) => step.id !== project.next?.id);
      if (rest.length > 0) lines.push(`Осталось ещё: ${rest.map((step) => step.text).join('; ')}`);
    }
    return lines.join('\n');
  }

  // Ничего не найдено — обзор: сегодня, срок прошёл, ближайшие дни, цели.
  lines.push('По вопросу ничего не найдено');
  const open = (params.overview ?? []).filter(
    (item) => item.type === 'TASK' || item.type === 'DESIRE',
  );
  const todayKey = isoDateIn(now, timeZone);
  const dated = open.filter((item) => item.deadlineAt !== null && item.deadlineAccuracy === 'day');
  const today = dated
    .filter((item) => isoDateIn(item.deadlineAt ?? now, timeZone) === todayKey)
    .sort((left, right) => (left.deadlineTime ?? 1440) - (right.deadlineTime ?? 1440))
    .slice(0, MAX_OVERVIEW);
  const overdue = dated
    .filter((item) => isoDateIn(item.deadlineAt ?? now, timeZone) < todayKey)
    .sort((left, right) => (left.deadlineAt?.getTime() ?? 0) - (right.deadlineAt?.getTime() ?? 0))
    .slice(0, MAX_OVERVIEW);
  const soon = dated
    .filter((item) => {
      const days = daysBetween(now, item.deadlineAt ?? now, timeZone);
      return days >= 1 && days <= SOON_DAYS;
    })
    .sort((left, right) => (left.deadlineAt?.getTime() ?? 0) - (right.deadlineAt?.getTime() ?? 0))
    .slice(0, MAX_OVERVIEW);
  const projects = open.filter((item) => item.isProject).slice(0, 2);

  if (today.length > 0) {
    lines.push(
      `На сегодня: ${today.map((item) => (item.deadlineTime === null ? title(item) : `${title(item)} в ${clock(item.deadlineTime)}`)).join('; ')}`,
    );
  }
  if (overdue.length > 0) {
    lines.push(
      `Срок прошёл: ${overdue.map((item) => `${title(item)} — ${counted(daysBetween(item.deadlineAt ?? now, now, timeZone), ['день', 'дня', 'дней'])} назад`).join('; ')}`,
    );
  }
  if (soon.length > 0) {
    lines.push(
      `Ближайшие дни: ${soon.map((item) => `${title(item)} — ${shortDate(item.deadlineAt ?? now, timeZone)}`).join('; ')}`,
    );
  }
  if (projects.length > 0) lines.push(`Большие цели: ${projects.map(title).join('; ')}`);
  const inexact = open
    .filter((item) => item.deadlineAt !== null && item.deadlineAccuracy !== 'day')
    .slice(0, 2);
  if (inexact.length > 0) {
    lines.push(
      `Неточные сроки: ${inexact.map((item) => `${title(item)} — ${deadlineWords({ deadlineAt: item.deadlineAt ?? now, deadlineAccuracy: item.deadlineAccuracy }, timeZone, texts)}`).join('; ')}`,
    );
  }
  lines.push(`Открытых дел всего: ${String(open.length)}`);
  return lines.join('\n');
}

/** Ответ на вопрос — до трёх фраз и один вопрос (§13.9). */
const ANSWER_LIMITS: VoiceLimits = {
  maxLength: 400,
  maxSentences: 3,
  maxQuestions: 1,
  forbidOpening: false,
  // «Сегодня надо купить молоко» на «мне надо что-то купить?» — ответ её
  // словами, не понукание; «попробуй», «пора», «не забудь» остаются советом.
  allowMust: true,
};

export function checkLiveAnswer(raw: string, facts: string): CheckedLine {
  return checkVoice(raw, facts, ANSWER_LIMITS);
}

export interface LiveAnswerParams {
  readonly facts: string;
  readonly userId?: string | undefined;
  readonly batchId?: string | undefined;
}

export interface LiveAnswerOutcome {
  readonly line?: string | undefined;
  readonly why?: string | undefined;
  readonly rejected?: string | undefined;
}

export type AskAnswer = (
  deps: AiClientDeps,
  request: StructuredRequest,
) => Promise<StructuredOutcome<LiveAnswer>>;

const MAX_TOKENS = 300;

/** Спросить ответ и проверить. Никогда не бросает: словарный ответ всегда есть. */
export async function askLiveAnswer(
  deps: AiClientDeps,
  params: LiveAnswerParams,
  ask: AskAnswer = requestStructured,
): Promise<LiveAnswerOutcome> {
  try {
    const active = await deps.prompts.get('answerer');
    if (active.schemaName !== ANSWERER_SCHEMA_NAME) {
      const why = 'промпт ответа на вопрос не той схемы';
      deps.logger?.warn({ version: active.version, schema: active.schemaName }, why);
      return { why };
    }

    const outcome = await ask(deps, {
      stage: 'answerer',
      input: params.facts,
      userId: params.userId,
      batchId: params.batchId,
      maxTokens: MAX_TOKENS,
    });
    if (!outcome.ok) {
      deps.logger?.info(
        { batchId: params.batchId, problem: outcome.problem },
        'Живой ответ не получен',
      );
      return { why: outcome.problem };
    }

    const checked = checkLiveAnswer(outcome.value.answer, params.facts);
    if (!checked.ok) {
      if (checked.why === 'пусто') return { why: checked.why };
      deps.logger?.info(
        { batchId: params.batchId, why: checked.why, answer: outcome.value.answer },
        'Живой ответ отвергнут стражем',
      );
      return { why: checked.why, rejected: outcome.value.answer };
    }

    return { line: checked.line };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    deps.logger?.warn({ batchId: params.batchId, err: error }, 'Живой ответ: модель не ответила');
    return { why };
  }
}
