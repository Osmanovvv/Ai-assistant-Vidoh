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
  readonly overdue: readonly {
    readonly id?: string | undefined;
    readonly title: string;
    readonly daysLate: number;
  }[];
  /** Прежние дела на сегодня — не из этой выгрузки. */
  readonly today: readonly {
    readonly id?: string | undefined;
    readonly title: string;
    readonly time?: string | undefined;
  }[];
  readonly projects: readonly string[];
  readonly doneRecently: readonly string[];
  /**
   * Поводы с идентификаторами — чтобы после ответа отметить, о ком
   * сказала строка (`mentionedIn`), и три дня к ним не возвращаться.
   */
  readonly candidates?: readonly { readonly id: string; readonly title: string }[] | undefined;
  /** Открытых дел до этой выгрузки. */
  readonly openTotal: number;
  readonly mood?: Mood | undefined;
}

interface ItemLike {
  readonly id?: string | undefined;
  readonly text: string;
  /** Когда живая строка уже говорила об этой записи. */
  readonly lineMentionedAt?: Date | null | undefined;
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
/** Три дня после упоминания запись в поводы не идёт: один повод подряд — шаблон. */
export const MENTION_COOLDOWN_DAYS = 3;

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
  const cooldownSince = now.getTime() - MENTION_COOLDOWN_DAYS * DAY_MS;
  const fresh = (item: ItemLike): boolean =>
    item.lineMentionedAt === null ||
    item.lineMentionedAt === undefined ||
    item.lineMentionedAt.getTime() < cooldownSince;
  const candidates: { id: string; title: string }[] = [];
  const remember = <T extends { readonly id?: string | undefined; readonly title: string }>(
    hook: T,
  ): T => {
    if (hook.id !== undefined) candidates.push({ id: hook.id, title: hook.title });
    return hook;
  };

  const overdue = previous
    .filter(fresh)
    .filter(
      (item) =>
        item.deadlineAt !== null &&
        item.deadlineAccuracy === 'day' &&
        isoDateIn(item.deadlineAt, timeZone) < todayKey,
    )
    .map((item) => ({
      id: item.id,
      title: shortTitle(item.text),
      daysLate: daysBetween(item.deadlineAt ?? now, now, timeZone),
    }))
    .sort((left, right) => right.daysLate - left.daysLate)
    .slice(0, MAX_OVERDUE)
    .map(remember);

  const today = previous
    .filter(fresh)
    .filter(
      (item) =>
        item.deadlineAt !== null &&
        item.deadlineAccuracy === 'day' &&
        isoDateIn(item.deadlineAt, timeZone) === todayKey,
    )
    .sort((left, right) => (left.deadlineTime ?? 1440) - (right.deadlineTime ?? 1440))
    .slice(0, MAX_TODAY)
    .map((item) => ({
      id: item.id,
      title: shortTitle(item.text),
      time:
        item.deadlineTime === null || item.deadlineTime === undefined
          ? undefined
          : clock(item.deadlineTime),
    }))
    .map(remember);

  const projects = previous
    .filter(fresh)
    .filter((item) => item.isProject)
    .slice(0, MAX_PROJECTS)
    .map((item) => remember({ id: item.id, title: shortTitle(item.text) }).title);

  const doneRecently = input.doneItems
    .filter(fresh)
    .filter(
      (item) =>
        item.completedAt !== null &&
        item.completedAt !== undefined &&
        daysBetween(item.completedAt, now, timeZone) <= DONE_WINDOW_DAYS,
    )
    .sort((left, right) => (right.completedAt?.getTime() ?? 0) - (left.completedAt?.getTime() ?? 0))
    .slice(0, MAX_DONE)
    .map((item) => remember({ id: item.id, title: shortTitle(item.text) }).title);

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
    candidates,
  };
}

/** Слова строки, которые есть в любой строке: по ним запись не узнать. */
const LINE_NOISE = new Set([
  'помню',
  'запись',
  'записи',
  'место',
  'месте',
  'никуда',
  'делась',
  'делось',
  'прошёл',
  'прошел',
  'срок',
  'дней',
  'день',
  'дня',
  'закрыт',
  'закрыта',
  'вопрос',
  'тишины',
  'теперь',
  'здесь',
  'первый',
  'дальше',
  'можно',
  'просто',
  'скидывать',
  'сюда',
  'голову',
  'голова',
  'занята',
  'другим',
  'записывала',
  'вторую',
  'завела',
  'одна',
  'всего',
  'который',
  'которая',
  'которую',
]);

function stemsOf(text: string): Set<string> {
  const stems = new Set<string>();
  for (const word of text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .match(/\p{L}+/gu) ?? []) {
    if (word.length < 4 || LINE_NOISE.has(word)) continue;
    stems.add(word.length > 5 ? word.slice(0, 5) : word);
  }
  return stems;
}

/**
 * О каких записях говорит строка — по общей основе значимого слова с
 * заголовком повода. Модель идентификаторов не отдаёт; слова — то, что
 * есть. Порядок — как у поводов.
 */
export function mentionedIn(
  line: string,
  candidates: readonly { readonly id: string; readonly title: string }[],
): string[] {
  const said = stemsOf(line);
  return candidates
    .filter((one) => [...stemsOf(one.title)].some((stem) => said.has(stem)))
    .map((one) => one.id);
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
