/**
 * Даты в записи ответов модели — относительными, а не абсолютными
 * (задача 3.80).
 *
 * **Без этого запись живёт один день.** Разбор насквозь зависит от того,
 * какое сегодня число: во входе классификатора стоит «Сегодня
 * 06.09.2026, суббота», а в ответе — срок «2026-09-07». Запиши это как
 * есть, и завтра ключ записи не совпадёт; совпади он случайно —
 * воспроизведённый ответ вернёт срок вчерашнего «завтра». Прогон стал бы
 * либо бесполезным, либо, что хуже, зелёным по неверной причине.
 *
 * Поэтому дата в окне вокруг дня записи превращается в метку, а при
 * воспроизведении разворачивается обратно относительно **сегодня**. Тот
 * же приём, каким в этом проекте уже пишутся тесты: `question.int`
 * однажды покраснел от захардкоженной даты, и с тех пор дата в ожиданиях
 * считается от «сейчас».
 *
 * **Окно узкое намеренно.** Заменяется только то, что похоже на дату
 * **и** попадает в окно вокруг дня записи. Всё остальное — номер дома,
 * сумма, «10 000 шагов», год в чужом тексте — остаётся дословно. Широкое
 * правило калечило бы записанное, а испорченная запись хуже
 * отсутствующей: на ней прогон зелёный, а бот сломан.
 *
 * **Форма помнится вместе с датой, и первая версия на этом сломалась.**
 * Она писала одну и ту же метку для «2026-09-07» и для «07.09», а
 * развернуть их надо по-разному: ответ модели проверяется §2.7 по
 * образцу ГГГГ-ММ-ДД, а в переписке человека дата стоит как «08.09».
 * Поэтому вид записан в самой метке: `iso`, `дм`, `дмг`.
 */

/** Сколько дней вокруг дня записи считаются «относительными». */
export const WINDOW_BEFORE_DAYS = 14;
export const WINDOW_AFTER_DAYS = 400;

const DAY_MS = 24 * 60 * 60_000;

/** Дата в виде ГГГГ-ММ-ДД — так её пишут и модель, и наши схемы. */
const ISO_DATE = /\d{4}-\d{2}-\d{2}/gu;

/** Дата в виде ДД.ММ.ГГГГ и ДД.ММ — так её печатает бот человеку. */
const HUMAN_DATE = /\b(\d{2})\.(\d{2})(?:\.(\d{4}))?\b/gu;

/** Метка дня: смещение в днях и вид, которым дату записали. */
const MARK = /\{\{день([+-]\d+)\|(iso|дм|дмг)\}\}/gu;

type Shape = 'iso' | 'дм' | 'дмг';

/** Полночь UTC того же дня: дни считаются днями, а не часами. */
function dayOf(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function pad(one: number): string {
  return String(one).padStart(2, '0');
}

function printed(dayStart: number, shape: Shape): string {
  const at = new Date(dayStart);
  const year = String(at.getUTCFullYear());
  const month = pad(at.getUTCMonth() + 1);
  const day = pad(at.getUTCDate());

  if (shape === 'iso') return `${year}-${month}-${day}`;
  if (shape === 'дм') return `${day}.${month}`;

  return `${day}.${month}.${year}`;
}

/** Смещение в днях, если дата попала в окно. Иначе `undefined`. */
function offsetOf(dayStart: number, anchor: number): number | undefined {
  if (!Number.isFinite(dayStart)) return undefined;

  const offset = Math.round((dayStart - anchor) / DAY_MS);
  if (offset < -WINDOW_BEFORE_DAYS || offset > WINDOW_AFTER_DAYS) return undefined;

  return offset;
}

function mark(offset: number, shape: Shape): string {
  return `{{день${offset >= 0 ? '+' : ''}${String(offset)}|${shape}}}`;
}

/**
 * Заменяет даты в окне вокруг `recordedAt` на метки.
 *
 * Год у формы ДД.ММ берётся от дня записи: без года дата неоднозначна, а
 * в переписке бота она встречается именно так («Перенесла на 08.09»).
 */
export function relativise(text: string, recordedAt: Date): string {
  const anchor = dayOf(recordedAt);

  const withIso = text.replace(ISO_DATE, (found) => {
    const offset = offsetOf(Date.parse(`${found}T00:00:00.000Z`), anchor);

    return offset === undefined ? found : mark(offset, 'iso');
  });

  return withIso.replace(HUMAN_DATE, (found, day: string, month: string, year?: string) => {
    const inYear = year ?? String(new Date(anchor).getUTCFullYear());
    const offset = offsetOf(Date.parse(`${inYear}-${month}-${day}T00:00:00.000Z`), anchor);

    if (offset === undefined) return found;

    return mark(offset, year === undefined ? 'дм' : 'дмг');
  });
}

/**
 * Разворачивает метки обратно относительно `now`.
 *
 * Вид берётся из самой метки: ответ модели должен прийти в том же виде,
 * в каком его записали, иначе проверка §2.7 отбросит верный срок.
 */
export function expand(text: string, now: Date): string {
  const anchor = dayOf(now);

  return text.replace(MARK, (_found, shift: string, shape: string) =>
    printed(anchor + Number(shift) * DAY_MS, shape as Shape),
  );
}

/** Есть ли в тексте метки дней: нужно тестам и отчётам. */
export function hasMarks(text: string): boolean {
  MARK.lastIndex = 0;
  return MARK.test(text);
}
