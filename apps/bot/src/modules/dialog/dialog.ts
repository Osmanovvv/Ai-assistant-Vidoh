/**
 * Хвост разговора для резолвера (решение Никиты 24.09.2026, план docs/26).
 *
 * Замер «как сейчас» показал, чего не хватает модели: в трёх случаях из
 * семи она молча поправила не то дело — «посылку на субботу» сразу после
 * напоминания про посылки с Вайлдберриз ушло в другую, более свежую
 * посылку. О чём бот говорил секунду назад, она не знала.
 *
 * Хвост — это последние реплики обеих сторон за четверть часа. Источником
 * дат и новых дел он не служит: это сказано в заголовке блока, а держат
 * стражи кода, которые остаются как были.
 */

export type DialogRole = 'person' | 'bot';

export interface DialogTurn {
  readonly role: DialogRole;
  readonly text: string;
  readonly at: Date;
  /**
   * Сообщение Telegram. Бот правит своё «Слушаю…» в итог — по номеру
   * правка заменяет реплику, а не добавляет вторую.
   */
  readonly messageId?: number | undefined;
}

/** Окно разговора — то же, что у свежести резолвера и переспроса. */
export const DIALOG_WINDOW_MS = 15 * 60_000;
export const DIALOG_MAX_TURNS = 4;
/** Длиннее — обрезается: список из сорока дел модели ни к чему. */
export const DIALOG_TURN_MAX_CHARS = 200;

/**
 * Заголовок блока.
 *
 * Первая редакция говорила только «чтобы понять, о какой записи речь», и
 * проба 24.09.2026 показала, что этого мало: промпт резолвера велит
 * смотреть на время изменения, и «посылку давай на субботу» сразу после
 * напоминания про посылки с Вайлдберриз ушло в другую посылку — ту, что
 * менялась шесть минут назад и совпала словом. Заголовок говорит прямо,
 * что сильнее, и тут же — что новое дело разговором не становится старым.
 */
export const DIALOG_HEADING =
  'Недавний разговор — подсказка, о какой записи речь. Если человек отвечает на последнюю реплику бота и не называет другое дело, он говорит о записи из этой реплики, даже если другая запись похожа по словам или менялась позже. Новое дело остаётся новым делом. Новых дел и сроков из него не бери:';

export function recentDialog(turns: readonly DialogTurn[], now: Date): DialogTurn[] {
  const fresh = turns.filter((turn) => {
    const age = now.getTime() - turn.at.getTime();
    return age >= 0 && age <= DIALOG_WINDOW_MS;
  });

  // Последняя правка сообщения побеждает и встаёт на место по своему времени.
  const latest = new Map<string, DialogTurn>();
  fresh.forEach((turn, index) => {
    const key = turn.messageId === undefined ? `#${String(index)}` : `m${String(turn.messageId)}`;
    const seen = latest.get(key);
    if (seen === undefined || seen.at.getTime() <= turn.at.getTime()) latest.set(key, turn);
  });

  return [...latest.values()]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(-DIALOG_MAX_TURNS);
}

function agoWords(at: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  return minutes < 1 ? 'только что' : `${String(minutes)} мин назад`;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * В одну строку и не длиннее предела.
 *
 * Режется по видимым знакам, как `picturesIn` в `texts/rules.ts`: в ответах
 * бота бывает 😮‍💨, и резка по кодовым точкам оставила бы обломок «😮».
 */
function clip(text: string): string {
  const flat = Array.from(
    GRAPHEMES.segment(text.replace(/\s+/gu, ' ').trim()),
    (piece) => piece.segment,
  );
  return flat.length <= DIALOG_TURN_MAX_CHARS
    ? flat.join('')
    : `${flat.slice(0, DIALOG_TURN_MAX_CHARS - 1).join('')}…`;
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
}

/** Стоит ли `name` в `said` целыми словами: «купить хлеб» — не в «купить хлебцы». */
function containsWhole(said: string, name: string): boolean {
  for (let from = said.indexOf(name); from !== -1; from = said.indexOf(name, from + 1)) {
    const before = said[from - 1] ?? ' ';
    const after = said[from + name.length] ?? ' ';
    if (!/\p{L}|\p{N}/u.test(before) && !/\p{L}|\p{N}/u.test(after)) return true;
  }
  return false;
}

/**
 * Номер записи (с единицы), названной в реплике бота, — если названа ровно одна.
 *
 * Код это знает наверняка: бот печатает название дела целиком. Модели же
 * пришлось бы догадываться, что «посылки с Вайлдберриз» в реплике — это
 * вторая запись, а не первая «Забрать посылку». Две и больше — список или
 * название внутри названия: на одно дело реплика не указывает, номера нет.
 */
function recordIn(text: string, titles: readonly string[]): number | undefined {
  const said = normalized(text);
  const found = titles.flatMap((title, index) => {
    const name = normalized(title);
    return name !== '' && containsWhole(said, name) ? [index + 1] : [];
  });
  return found.length === 1 ? found[0] : undefined;
}

/**
 * Блок разговора для модели.
 *
 * `titles` — записи в том порядке, в каком их видит модель: по ним реплика
 * бота получает «о записи N». Без них блок такой же, только без номеров.
 */
export function describeDialog(
  turns: readonly DialogTurn[],
  now: Date,
  titles: readonly string[] = [],
): string {
  const recent = recentDialog(turns, now);
  if (recent.length === 0) return '';

  const lines = recent.map((turn) => {
    const record = turn.role === 'bot' ? recordIn(turn.text, titles) : undefined;
    const about = record === undefined ? '' : `, о записи ${String(record)}`;
    return `${turn.role === 'bot' ? 'Бот' : 'Человек'} (${agoWords(turn.at, now)}${about}): ${clip(turn.text)}`;
  });
  return [DIALOG_HEADING, ...lines].join('\n');
}
