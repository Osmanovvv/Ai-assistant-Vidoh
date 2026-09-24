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

export const DIALOG_HEADING =
  'Недавний разговор — только чтобы понять, о какой записи речь. Новых дел и сроков из него не бери:';

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

/** В одну строку и не длиннее предела; режется по символам, а не байтам. */
function clip(text: string): string {
  const flat = [...text.replace(/\s+/gu, ' ').trim()];
  return flat.length <= DIALOG_TURN_MAX_CHARS
    ? flat.join('')
    : `${flat.slice(0, DIALOG_TURN_MAX_CHARS - 1).join('')}…`;
}

export function describeDialog(turns: readonly DialogTurn[], now: Date): string {
  const recent = recentDialog(turns, now);
  if (recent.length === 0) return '';

  const lines = recent.map(
    (turn) =>
      `${turn.role === 'bot' ? 'Бот' : 'Человек'} (${agoWords(turn.at, now)}): ${clip(turn.text)}`,
  );
  return [DIALOG_HEADING, ...lines].join('\n');
}
