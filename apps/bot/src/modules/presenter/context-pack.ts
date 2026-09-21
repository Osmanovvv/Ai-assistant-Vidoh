import { isoDateIn, localDateParts, startOfDayInZone } from '../classifier/dates.js';
import type { ItemType } from '../ai/schemas/index.js';
import { dueWords } from '../items/deadline-words.js';
import { titleWithoutDate } from '../resolver/title-date.js';
import type { TextProfile } from '../../texts/index.js';
import { counted } from '../../texts/plural.js';
import type { Mood } from './mood.js';

/**
 * Контекст для живой строки (22.09.2026, слой A).
 *
 * Заказчица (голос 21.09.2026): бот «не живой, шаблонный… чтобы он помнил
 * из контекста, что это за женщина, какие у неё задачи, что ей нужно
 * напоминать». Разбор остаётся кодом; поверх ответа модель пишет одну-две
 * фразы — и всё, что она может знать, собирается **здесь**, из её же
 * записей, а не ищется моделью. Так строка не может «вспомнить» того,
 * чего нет: контекст — закрытый список фактов, и страж строки сверяет
 * числа и даты с ним.
 *
 * Отбор нарочно скупой: три просроченных, пять на сегодня, две большие
 * цели, три недавно закрытых. Модели не нужен весь список — ей нужно то,
 * за что можно зацепиться одной фразой. Длинный контекст дороже и хуже:
 * она начинает пересказывать.
 */
export type PartOfDay = 'утро' | 'день' | 'вечер' | 'ночь';

export interface RecordedItem {
  readonly title: string;
  readonly topic: string;
  /** Срок словами человека: «завтра», «25.09», «на неделе». */
  readonly due: string | undefined;
}

export interface ContextPack {
  readonly name?: string | undefined;
  readonly partOfDay: PartOfDay;
  /** Дней с прошлой выгрузки; нет — эта первая. */
  readonly daysSinceLast?: number | undefined;
  /** Записанное в этой выгрузке: дела и желания. */
  readonly recorded: readonly RecordedItem[];
  /** Из записанного — то, что совпало с прежней записью. */
  readonly alreadyKnown: readonly string[];
  readonly overdue: readonly { readonly title: string; readonly daysLate: number }[];
  /** Прежние дела на сегодня — не из этой выгрузки. */
  readonly today: readonly { readonly title: string; readonly time?: string | undefined }[];
  readonly projects: readonly string[];
  readonly doneRecently: readonly string[];
  /** Открытых дел до этой выгрузки. */
  readonly openTotal: number;
  readonly mood?: Mood | undefined;
}

interface ItemLike {
  readonly text: string;
  readonly deadlineAt: Date | null;
  readonly deadlineAccuracy: 'day' | 'week' | 'month' | null;
  readonly deadlineTime?: number | null | undefined;
  readonly isProject: boolean;
  readonly sourceBatchId: string | null;
  readonly completedAt?: Date | null | undefined;
}

export interface PackContextInput {
  readonly now: Date;
  readonly timeZone: string;
  readonly texts: TextProfile;
  /** Эта выгрузка: её записи в открытых не считаются «прежними». */
  readonly batchId: string;
  readonly name?: string | undefined;
  readonly previousBatchAt?: Date | undefined;
  readonly units: readonly {
    readonly text: string;
    readonly type: ItemType;
    readonly topic: string;
    readonly deadline?: { readonly at: Date; readonly accuracy: string } | undefined;
  }[];
  /** Заголовки из выгрузки, совпавшие с прежними записями. */
  readonly known: readonly string[];
  /** Открытые дела человека (все, включая только что записанные). */
  readonly openItems: readonly ItemLike[];
  /** Закрытые дела за последние дни. */
  readonly doneItems: readonly ItemLike[];
  readonly mood?: Mood | undefined;
}

const MAX_OVERDUE = 3;
const MAX_TODAY = 5;
const MAX_PROJECTS = 2;
const MAX_DONE = 3;
const DONE_WINDOW_DAYS = 3;
const MAX_TITLE = 80;
const DAY_MS = 24 * 60 * 60_000;

function shortTitle(text: string): string {
  const title = titleWithoutDate(text);
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE)}…` : title;
}

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function partOfDayIn(now: Date, timeZone: string): PartOfDay {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(now),
  );
  return hour < 5 ? 'ночь' : hour < 12 ? 'утро' : hour < 17 ? 'день' : hour < 23 ? 'вечер' : 'ночь';
}

/** Целых дней между полуночами в поясе человека. */
function daysBetween(from: Date, to: Date, timeZone: string): number {
  const start = startOfDayInZone(localDateParts(from, timeZone), timeZone);
  const end = startOfDayInZone(localDateParts(to, timeZone), timeZone);
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}

export function packContext(input: PackContextInput): ContextPack {
  const { now, timeZone, texts } = input;
  const todayKey = isoDateIn(now, timeZone);

  const recorded: RecordedItem[] = input.units
    .filter((unit) => unit.type === 'TASK' || unit.type === 'DESIRE')
    .map((unit) => ({
      title: shortTitle(unit.text),
      topic: unit.topic.trim(),
      due:
        unit.deadline === undefined
          ? undefined
          : (dueWords(
              { deadlineAt: unit.deadline.at, deadlineAccuracy: unit.deadline.accuracy },
              { now, timeZone },
              texts,
            ) ?? 'сегодня'),
    }));

  const alreadyKnown = input.known.map(shortTitle);

  const previous = input.openItems.filter((item) => item.sourceBatchId !== input.batchId);

  const overdue = previous
    .filter(
      (item) =>
        item.deadlineAt !== null &&
        item.deadlineAccuracy === 'day' &&
        isoDateIn(item.deadlineAt, timeZone) < todayKey,
    )
    .map((item) => ({
      title: shortTitle(item.text),
      daysLate: daysBetween(item.deadlineAt ?? now, now, timeZone),
    }))
    .sort((left, right) => right.daysLate - left.daysLate)
    .slice(0, MAX_OVERDUE);

  const today = previous
    .filter(
      (item) =>
        item.deadlineAt !== null &&
        item.deadlineAccuracy === 'day' &&
        isoDateIn(item.deadlineAt, timeZone) === todayKey,
    )
    .sort((left, right) => (left.deadlineTime ?? 1440) - (right.deadlineTime ?? 1440))
    .slice(0, MAX_TODAY)
    .map((item) => ({
      title: shortTitle(item.text),
      time:
        item.deadlineTime === null || item.deadlineTime === undefined
          ? undefined
          : clock(item.deadlineTime),
    }));

  const projects = previous
    .filter((item) => item.isProject)
    .slice(0, MAX_PROJECTS)
    .map((item) => shortTitle(item.text));

  const doneRecently = input.doneItems
    .filter(
      (item) =>
        item.completedAt !== null &&
        item.completedAt !== undefined &&
        daysBetween(item.completedAt, now, timeZone) <= DONE_WINDOW_DAYS,
    )
    .sort((left, right) => (right.completedAt?.getTime() ?? 0) - (left.completedAt?.getTime() ?? 0))
    .slice(0, MAX_DONE)
    .map((item) => shortTitle(item.text));

  return {
    name: input.name,
    partOfDay: partOfDayIn(now, timeZone),
    daysSinceLast:
      input.previousBatchAt === undefined
        ? undefined
        : daysBetween(input.previousBatchAt, now, timeZone),
    recorded,
    alreadyKnown,
    overdue,
    today,
    projects,
    doneRecently,
    openTotal: previous.length,
    mood: input.mood,
  };
}

const MOOD_WORDS: Readonly<Record<Mood, string>> = {
  tired: 'устала',
  annoyed: 'раздражена, досада',
  heavy: 'сильная эмоция, тяжело',
};

const DAYS = ['день', 'дня', 'дней'] as const;

/**
 * Текст для промпта: разделы строками, пустые — не печатаются. Это же и
 * «словарь фактов» для стража строки: числа и даты, которых здесь нет,
 * в строке быть не могут.
 */
export function renderContextPack(pack: ContextPack): string {
  const lines: string[] = [];

  if (pack.name !== undefined && pack.name.trim() !== '') lines.push(`Имя: ${pack.name.trim()}`);
  lines.push(`Сейчас: ${pack.partOfDay}`);
  lines.push(
    pack.daysSinceLast === undefined
      ? 'Первая выгрузка: раньше она сюда ничего не записывала'
      : pack.daysSinceLast === 0
        ? 'Прошлая выгрузка: сегодня'
        : `Прошлая выгрузка: ${counted(pack.daysSinceLast, DAYS)} назад`,
  );

  if (pack.recorded.length > 0) {
    const known = new Set(pack.alreadyKnown);
    lines.push('Записано сейчас:');
    for (const item of pack.recorded) {
      const due = item.due === undefined ? '' : `, срок: ${item.due}`;
      const was = known.has(item.title) ? ' — уже было записано раньше' : '';
      lines.push(`— ${item.title} (${item.topic})${due}${was}`);
    }
  }

  if (pack.overdue.length > 0) {
    lines.push(
      `Срок прошёл: ${pack.overdue.map((item) => `${item.title} — ${counted(item.daysLate, DAYS)} назад`).join('; ')}`,
    );
  }
  if (pack.today.length > 0) {
    lines.push(
      `Ещё на сегодня: ${pack.today.map((item) => (item.time === undefined ? item.title : `${item.title} в ${item.time}`)).join('; ')}`,
    );
  }
  if (pack.projects.length > 0) lines.push(`Большие цели: ${pack.projects.join('; ')}`);
  if (pack.doneRecently.length > 0) lines.push(`Недавно закрыла: ${pack.doneRecently.join('; ')}`);
  lines.push(`Открытых дел всего: ${String(pack.openTotal)}`);
  if (pack.mood !== undefined) lines.push(`Состояние: ${MOOD_WORDS[pack.mood]}`);

  return lines.join('\n');
}
