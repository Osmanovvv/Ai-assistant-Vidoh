import { withoutClockPhrase } from '../classifier/clock-time.js';
import { deadlineWords, dueWords } from '../items/deadline-words.js';
import { withCapital } from '../items/item-text.js';
import { titleWithoutDate } from '../resolver/title-date.js';
import { clockOf } from '../scheduler/plan.js';
import type { TextProfile } from '../../texts/index.js';
import type { AskedPeriod } from './periods.js';

/**
 * Строки списков дня и отрезка голосом (проверка Никиты 25.09.2026,
 * 03:29).
 *
 * «Что у меня на завтра» → «На завтра у тебя вот это: — Встретить курьера
 * послезавтра». Срок у дела верный — 26.09, завтра; «послезавтра» осталось
 * в названии со дня записи. Шапка уже называет день, и слово дня в строке
 * ему противоречит. Часа у дел (21:00, 20:00) видно не было, хотя итог
 * выгрузки его пишет: «· 21:00».
 *
 * Так же, как итог выгрузки (`summarizeDump`): название без слов дня и с
 * заглавной; час — из срока, а старый час из названия срезан, чтобы час
 * был один. Под шапкой нескольких дней («на неделю») дела на разные дни —
 * там день не выбрасывается, а берётся настоящий из срока, словами
 * карточки: «завтра, 21:00», «27.09».
 */

interface ListedItem {
  readonly text: string;
  readonly deadlineAt: Date | null;
  readonly deadlineAccuracy: 'day' | 'week' | 'month' | null;
  readonly deadlineTime: number | null;
}

/** Название для списка: без слов дня, без старого часа при часе в сроке, с заглавной. */
function listTitle(item: ListedItem): string {
  const text = item.deadlineTime === null ? item.text : withoutClockPhrase(item.text);
  return withCapital(titleWithoutDate(text));
}

/** Строка под шапкой одного дня: «Встретить курьера · 21:00». */
export function underDayTitle(item: ListedItem): string {
  const title = listTitle(item);
  return item.deadlineTime === null ? title : `${title} · ${clockOf(item.deadlineTime)}`;
}

/** Строка под шапкой нескольких дней: название и свой день из срока. */
export function spanLine(
  item: ListedItem,
  context: { readonly now: Date; readonly timeZone: string },
  texts: TextProfile,
): { readonly title: string; readonly when: string } {
  const title = listTitle(item);
  if (item.deadlineAt === null) return { title, when: '' };
  const dated = {
    deadlineAt: item.deadlineAt,
    deadlineAccuracy: item.deadlineAccuracy,
    deadlineTime: item.deadlineTime,
  };
  const when =
    item.deadlineAccuracy === 'day'
      ? (dueWords(dated, context, texts) ?? texts.backlog.dueToday)
      : deadlineWords(dated, context.timeZone, texts);
  return { title, when };
}

/** Отрезок в один день — «завтра», «послезавтра», «в пятницу». */
export function isSingleDayPeriod(period: AskedPeriod): boolean {
  return period === 'tomorrow' || period === 'afterTomorrow' || period.startsWith('weekday:');
}
