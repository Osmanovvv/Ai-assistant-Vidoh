import { isoDateIn, startOfDayAfter } from '../classifier/dates.js';
import type { ItemType } from '../ai/schemas/index.js';
import { withCapital } from '../items/item-text.js';
import { titleWithoutDate } from '../resolver/title-date.js';
import { normalizeTopicName } from '../topics/topics.repo.js';
import { topicIcon } from '../topics/topics.service.js';

/**
 * Компактный итог разбора (заказчица, 16.09.2026, п. 3).
 *
 * Её образец: «Записала 6 дел. / 💼 Работа — 4 / 🛒 Покупки — 2 / На
 * завтра: съездить в офис и распечатать документы.» — одним сообщением
 * вместо серии служебных (открытие и вопрос — по её тексту о характере:
 * «Всё, забрала… Оставить как есть или выбрать главное?»). Здесь
 * считается сама раскладка: дела и желания по сферам (больше — выше;
 * желания — с 17.09.2026, решение Никиты: признание называет «6 дел и 3
 * желания», и у желаний должно быть своё место) и дела с дневным сроком
 * на сегодня и на завтра в поясе человека. Неточные сроки («на неделе»,
 * «в октябре») сюда не идут — они не «на завтра».
 */
export interface SummarizedUnit {
  readonly text: string;
  readonly type: ItemType;
  readonly topic: string;
  readonly deadline?: { readonly at: Date; readonly accuracy: string } | undefined;
}

export interface SphereCount {
  readonly name: string;
  readonly icon: string | undefined;
  readonly count: number;
}

export interface DumpSummary {
  readonly spheres: readonly SphereCount[];
  readonly today: readonly string[];
  readonly tomorrow: readonly string[];
}

export function summarizeDump(
  units: readonly SummarizedUnit[],
  context: { readonly now: Date; readonly timeZone: string },
): DumpSummary {
  const tasks = units.filter((unit) => unit.type === 'TASK');
  const placed = units.filter((unit) => unit.type === 'TASK' || unit.type === 'DESIRE');

  const counts = new Map<string, { name: string; count: number }>();
  for (const unit of placed) {
    const key = normalizeTopicName(unit.topic);
    const entry = counts.get(key) ?? { name: unit.topic.trim(), count: 0 };
    counts.set(key, { ...entry, count: entry.count + 1 });
  }

  const spheres = [...counts.values()]
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'ru'))
    .map(({ name, count }) => ({ name, icon: topicIcon(name), count }));

  const today = isoDateIn(context.now, context.timeZone);
  const tomorrow = isoDateIn(startOfDayAfter(context.now, 1, context.timeZone), context.timeZone);

  const dueOn = (day: string): string[] =>
    tasks
      .filter(
        (task) =>
          task.deadline?.accuracy === 'day' &&
          isoDateIn(task.deadline.at, context.timeZone) === day,
      )
      // Под заголовком дня свой день в заголовке — эхо (прогон 18.09.2026):
      // тот же срез, что в списке ветки, и с заглавной.
      .map((task) => withCapital(titleWithoutDate(task.text)));

  return { spheres, today: dueOn(today), tomorrow: dueOn(tomorrow) };
}
