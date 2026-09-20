import type { Item } from '../../db/schema.js';
import type { TextProfile } from '../../texts/types.js';
import { dueWords } from '../items/deadline-words.js';
import { withCapital } from '../items/item-text.js';
import type { StatusButton } from '../presenter/status.service.js';
import { ANSWER_ACTION } from '../presenter/presenter.service.js';
import { titleWithoutDate } from '../resolver/title-date.js';
import { FALLBACK_TOPIC } from '../topics/topics.repo.js';
import { topicIcon } from '../topics/topics.service.js';

/**
 * «Мои дела» — полный список актуальных незавершённых дел (ТЗ проджекта
 * 17.09.2026, 2.4).
 *
 * Женщина в любой момент должна получить ответ на «Что у меня вообще
 * сейчас есть?» и почувствовать не масштаб накопившегося, а порядок. Бот
 * ничего не прячет и не заставляет администрировать бэклог: маленький
 * список показывает целиком, большой — аккуратно раскладывает и дозирует.
 *
 * Что считается делами: открытые дела — со сроком, без срока, регулярные
 * и из «Позже»; выполненные, отменённые и ушедшие в фон — нет; идеи,
 * желания, сведения и чувства с делами не смешиваются. Пустые сферы не
 * показываются, одно дело выводится один раз. Даты — спокойным текстом,
 * без «просрочено» и красных меток; сколько дней прошло — не считается.
 *
 * Три яруса по числу дел: до 15 — одно сообщение; 16–30 — вступление про
 * объём и 2–3 сообщения по сферам, сфера по возможности не рвётся; больше
 * 30 — сводка по сферам и страницы по 10–12 с «Показать ещё / Назад»
 * правкой того же сообщения. Всё это — чистые функции над списком:
 * границы ярусов и раскладка проверяются без базы.
 */

export interface MyTasksGroup {
  readonly name: string;
  readonly icon: string | undefined;
  readonly items: readonly Item[];
}

export interface MyTasksLayout {
  readonly total: number;
  /** Сферы с делами: где дел больше — выше. */
  readonly groups: readonly MyTasksGroup[];
  /** Ушедшее в «Позже» — отдельным блоком в конце. */
  readonly later: readonly Item[];
}

export interface DayContext {
  readonly now: Date;
  readonly timeZone: string;
}

/** До этого числа — одно сообщение. */
export const SINGLE_LIMIT = 15;
/** До этого числа — 2–3 сообщения по сферам. */
export const PARTS_LIMIT = 30;
/** Дел в одной части или на одной странице. */
export const PAGE_SIZE = 12;

/** Иконка блока «Позже» — как в примере ТЗ. */
const LATER_ICON = '⏳';

function byDeadlineThenSaid(one: Item, two: Item): number {
  if (one.deadlineAt !== null && two.deadlineAt !== null) {
    return one.deadlineAt.getTime() - two.deadlineAt.getTime();
  }
  if (one.deadlineAt !== null) return -1;
  if (two.deadlineAt !== null) return 1;
  return one.createdAt.getTime() - two.createdAt.getTime();
}

export function layoutMyTasks(items: readonly Item[], _day: DayContext): MyTasksLayout {
  const seen = new Set<string>();
  const tasks = items.filter((item) => {
    if (item.type !== 'TASK' || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  const later = tasks.filter((item) => item.deferredAt !== null).sort(byDeadlineThenSaid);

  const byTopic = new Map<string, Item[]>();
  for (const item of tasks) {
    if (item.deferredAt !== null) continue;
    const name = item.topic ?? FALLBACK_TOPIC;
    const inTopic = byTopic.get(name) ?? [];
    inTopic.push(item);
    byTopic.set(name, inTopic);
  }

  const groups = [...byTopic.entries()]
    .sort(([a, one], [b, two]) => two.length - one.length || a.localeCompare(b, 'ru'))
    .map(([name, inTopic]) => ({
      name,
      icon: topicIcon(name),
      items: [...inTopic].sort(byDeadlineThenSaid),
    }));

  return { total: tasks.length, groups, later };
}

/** Шапка сферы: иконка, имя с заглавной, число дел. */
function headerOf(
  group: { readonly name: string; readonly icon: string | undefined },
  count: number,
  texts: TextProfile,
): string {
  const title = texts.backlog.sphereCount(withCapital(group.name), count);
  return group.icon === undefined ? title : `${group.icon} ${title}`;
}

/** Строка дела: заголовок без даты, срок или повтор — спокойным текстом. */
export function lineOf(item: Item, day: DayContext, texts: TextProfile): string {
  const title = withCapital(titleWithoutDate(item.text));

  if (item.recurrenceRule !== null && item.recurrenceText !== null && item.recurrenceText !== '') {
    return texts.summary.lineWithDate(title, item.recurrenceText);
  }

  if (item.deadlineAt !== null) {
    const when = dueWords(
      { deadlineAt: item.deadlineAt, deadlineAccuracy: item.deadlineAccuracy },
      day,
      texts,
    );
    return texts.summary.lineWithDate(title, when ?? texts.backlog.dueToday);
  }

  return texts.backlog.line(title);
}

/** Блоки в порядке показа: сферы, потом «Позже». */
function blocksOf(
  layout: MyTasksLayout,
  texts: TextProfile,
): readonly { readonly header: string; readonly items: readonly Item[] }[] {
  const blocks = layout.groups.map((group) => ({
    header: headerOf(group, group.items.length, texts),
    items: group.items,
  }));
  if (layout.later.length > 0) {
    blocks.push({
      header: headerOf(
        { name: texts.backlog.laterName, icon: LATER_ICON },
        layout.later.length,
        texts,
      ),
      items: layout.later,
    });
  }
  return blocks;
}

function renderBlock(
  block: { readonly header: string; readonly items: readonly Item[] },
  day: DayContext,
  texts: TextProfile,
): string[] {
  return [block.header, ...block.items.map((item) => lineOf(item, day, texts))];
}

export interface MyTasksView {
  readonly kind: 'empty' | 'single' | 'parts' | 'paged';
  /** Сообщения по порядку; у `paged` — сводка и первая страница. */
  readonly messages: readonly string[];
  /** Кнопки под последним сообщением. */
  readonly buttons: readonly StatusButton[];
}

const PICK: StatusButton = { label: '', action: ANSWER_ACTION.pick };

function mainButtons(texts: TextProfile): StatusButton[] {
  return [
    { ...PICK, label: texts.answer.buttonPick },
    { label: texts.backlog.buttonAddMore, action: ANSWER_ACTION.add },
  ];
}

/** «в двух / трёх коротких сообщениях» — частей бывает две или три. */
function partsWord(count: number): string {
  return count === 2 ? 'двух' : count === 3 ? 'трёх' : String(count);
}

/**
 * Части для среднего яруса: сферы складываются в части по ~PAGE_SIZE дел,
 * сфера не рвётся, если помещается в часть целиком; сфера крупнее части
 * делится одна.
 */
function partsOf(layout: MyTasksLayout, day: DayContext, texts: TextProfile): string[] {
  const parts: string[][] = [];
  let current: string[] = [];
  let currentCount = 0;

  const flush = (): void => {
    if (current.length > 0) parts.push(current);
    current = [];
    currentCount = 0;
  };

  for (const block of blocksOf(layout, texts)) {
    if (block.items.length <= PAGE_SIZE) {
      if (currentCount > 0 && currentCount + block.items.length > PAGE_SIZE) flush();
      if (current.length > 0) current.push('');
      current.push(...renderBlock(block, day, texts));
      currentCount += block.items.length;
      continue;
    }

    // Сфера крупнее части — делится только она, по PAGE_SIZE.
    flush();
    for (let from = 0; from < block.items.length; from += PAGE_SIZE) {
      const slice = block.items.slice(from, from + PAGE_SIZE);
      parts.push(renderBlock({ header: block.header, items: slice }, day, texts));
    }
  }
  flush();

  return parts.map((lines) => lines.join('\n'));
}

export function renderMyTasks(
  layout: MyTasksLayout,
  day: DayContext,
  texts: TextProfile,
): MyTasksView {
  if (layout.total === 0) {
    return { kind: 'empty', messages: [texts.backlog.allEmpty], buttons: [] };
  }

  const count = texts.backlog.tasksCount(layout.total);

  if (layout.total <= SINGLE_LIMIT) {
    const lines = [texts.backlog.myTasksHeader(count)];
    for (const block of blocksOf(layout, texts)) lines.push('', ...renderBlock(block, day, texts));
    lines.push('', texts.backlog.myTasksFooter);
    return { kind: 'single', messages: [lines.join('\n')], buttons: mainButtons(texts) };
  }

  if (layout.total <= PARTS_LIMIT) {
    const parts = partsOf(layout, day, texts);
    const intro = texts.backlog.myTasksParts(
      texts.backlog.openCount(layout.total),
      partsWord(parts.length),
    );
    return { kind: 'parts', messages: [intro, ...parts], buttons: mainButtons(texts) };
  }

  const summary = [
    texts.backlog.myTasksMany(texts.backlog.openCount(layout.total)),
    ...blocksOf(layout, texts).map((block) => block.header),
    '',
    texts.backlog.myTasksPaged,
  ].join('\n');
  const first = pageOf(layout, 0, day, texts);

  return {
    kind: 'paged',
    messages: first === undefined ? [summary] : [summary, first.text],
    buttons: first?.buttons ?? [],
  };
}

export interface MyTasksPage {
  readonly index: number;
  readonly text: string;
  readonly buttons: readonly StatusButton[];
}

/** Действие страницы: номер — в самой кнопке, состояния у бота нет. */
export const MY_TASKS_ACTION = {
  pagePrefix: 'mt:p:',
} as const;

/**
 * Страница большого списка: PAGE_SIZE дел подряд по блокам; продолжение
 * сферы на новой странице идёт под её же шапкой.
 */
export function pageOf(
  layout: MyTasksLayout,
  index: number,
  day: DayContext,
  texts: TextProfile,
): MyTasksPage | undefined {
  const flat: { readonly header: string; readonly item: Item }[] = [];
  for (const block of blocksOf(layout, texts)) {
    for (const item of block.items) flat.push({ header: block.header, item });
  }

  const from = index * PAGE_SIZE;
  if (index < 0 || from >= flat.length) return undefined;
  const slice = flat.slice(from, from + PAGE_SIZE);

  const lines: string[] = [];
  let header: string | undefined;
  for (const entry of slice) {
    if (entry.header !== header) {
      if (lines.length > 0) lines.push('');
      lines.push(entry.header);
      header = entry.header;
    }
    lines.push(lineOf(entry.item, day, texts));
  }

  const hasMore = from + PAGE_SIZE < flat.length;
  const buttons: StatusButton[] = [
    ...(hasMore
      ? [
          {
            label: texts.backlog.buttonShowMore,
            action: `${MY_TASKS_ACTION.pagePrefix}${String(index + 1)}`,
          },
        ]
      : []),
    ...(index > 0
      ? [
          {
            label: texts.backlog.buttonBack,
            action: `${MY_TASKS_ACTION.pagePrefix}${String(index - 1)}`,
          },
        ]
      : []),
    { ...PICK, label: texts.answer.buttonPick },
  ];

  return { index, text: lines.join('\n'), buttons };
}
