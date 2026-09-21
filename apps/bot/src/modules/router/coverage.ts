import type { Segment } from './router.service.js';
import { looksLikeThought } from './thought-words.js';

/**
 * Обрезанный ответ маршрутизатора (бой 21.09.2026, выгрузка Никиты).
 *
 * Восемь дел одним голосовым на 447 знаков. Модель вернула три отрезка
 * `DUMP` и третий оборвала на «Её в клинику ветеринарную,» — хвоста
 * «потом надо будет позвонить маме… сделать в университете задания» в
 * её ответе не было вовсе (воспроизведено на стенде 21.09, след
 * `docs/eval-live-21-09/runs/…14-34-22`). Четыре дела пропали молча:
 * конвейер разбирает только то, что в отрезках, а маршрутизатор не
 * проверял, что отрезки покрывают сказанное.
 *
 * Промпт не трогаем — он теряет единицы от любого утяжеления. Страж в
 * коде: текст и отрезки приводятся к одному виду (регистр, «ё»,
 * пунктуация), каждый отрезок находится в тексте так же, как при
 * проверке порядка (`orderByText`), и всё, что не покрыто ни одним, —
 * пропуск. Пропуск возвращается в разбор мыслью **на своём месте**,
 * если в нём не меньше четырёх слов и есть слово долга или глагол дела
 * (`thought-words.ts`): приветствие или «вот в общем вроде всё», которые
 * модель законно опустила, мыслью не становятся. Отрезок, которого в
 * тексте не нашлось, — пересказ; тогда сравнивать нечем, и всё остаётся
 * как есть, как и при проверке порядка.
 */

/** Сколько знаков отрезка искать в тексте — как у `orderByText`. */
const NEEDLE_LENGTH = 24;

/** Меньше слов — не пропуск, а расхождение пересказа с речью. */
const MIN_GAP_WORDS = 4;

interface Normalized {
  readonly text: string;
  /** Позиция каждого знака нормализованного текста в исходном. */
  readonly map: readonly number[];
}

/**
 * Тот же вид, что у `normalize` маршрутизатора, но с картой позиций:
 * пропуск надо вернуть словами человека, а не нормализованными.
 */
function normalized(text: string): Normalized {
  const chars: string[] = [];
  const map: number[] = [];
  let separator = false;

  for (let index = 0; index < text.length; index++) {
    const raw = text[index] ?? '';
    const char = raw.toLowerCase().replace('ё', 'е');
    if (char.length === 1 && /[\p{L}\p{N}]/u.test(char)) {
      if (separator && chars.length > 0) {
        chars.push(' ');
        map.push(index);
      }
      separator = false;
      chars.push(char);
      map.push(index);
    } else {
      separator = true;
    }
  }

  return { text: chars.join(''), map };
}

interface Placed {
  readonly segment: Segment;
  readonly start: number;
  readonly end: number;
}

function place(haystack: string, segments: readonly Segment[]): readonly Placed[] | undefined {
  const placed: Placed[] = [];
  let cursor = 0;

  for (const segment of segments) {
    const needle = normalized(segment.text).text;
    if (needle.length === 0) return undefined;

    const head = needle.slice(0, NEEDLE_LENGTH);
    const fromCursor = haystack.indexOf(head, cursor);
    const start = fromCursor >= 0 ? fromCursor : haystack.indexOf(head);
    if (start < 0) return undefined;

    const end = Math.min(haystack.length, start + needle.length);
    placed.push({ segment, start, end });
    cursor = end;
  }

  return placed.sort((left, right) => left.start - right.start);
}

/** Слова человека на месте пропуска — с пунктуацией, что стоит сразу за ними. */
function original(input: string, form: Normalized, from: number, to: number): string {
  let first = from;
  while (first < to && form.text[first] === ' ') first++;
  let last = to - 1;
  while (last > first && form.text[last] === ' ') last--;
  if (last < first) return '';

  const startAt = form.map[first] ?? 0;
  let endAt = (form.map[last] ?? startAt) + 1;
  while (endAt < input.length && /[^\p{L}\p{N}\s]/u.test(input[endAt] ?? '')) endAt++;

  return input.slice(startAt, endAt).trim();
}

function isThoughtGap(text: string): boolean {
  const words = text.split(' ').filter((word) => word.length > 0);
  return words.length >= MIN_GAP_WORDS && looksLikeThought(text);
}

export function restoreUncovered(input: string, segments: readonly Segment[]): readonly Segment[] {
  if (segments.length === 0) return segments;

  const form = normalized(input);
  const placed = place(form.text, segments);
  if (placed === undefined) return segments;

  const restored: Segment[] = [];
  let covered = 0;

  const gapBefore = (position: number): void => {
    if (position <= covered) return;
    const gap = form.text.slice(covered, position);
    if (!isThoughtGap(gap)) return;
    const text = original(input, form, covered, position);
    if (text !== '') restored.push({ intent: 'DUMP', text });
  };

  for (const one of placed) {
    gapBefore(one.start);
    restored.push(one.segment);
    covered = Math.max(covered, one.end);
  }
  gapBefore(form.text.length);

  return restored;
}
