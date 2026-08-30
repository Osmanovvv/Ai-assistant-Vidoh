import { localDateParts } from '../classifier/dates.js';
import type { StatusButton } from '../presenter/status.service.js';
import type { TextProfile } from '../../texts/index.js';
import { toShortId } from '../shared/short-id.js';
import type { Rhythm } from './detector.js';

/**
 * Как звучит предложение запомнить регулярность (задача 3.8в).
 *
 * **Предложение обязано показывать основание.** «Ты писала об этом 5, 12
 * и 19 августа — это каждую неделю?» Без перечисления дат оно читается
 * как гадание бота, и человек справедливо не доверяет.
 *
 * Кнопки и префиксы живут здесь, а не в обработчике: спрашивает конвейер,
 * отвечает обработчик, и разъехавшиеся префиксы сломали бы половину
 * нажатий — как это уже могло случиться с кнопкой отмены.
 */

export const SUGGEST_ACTION = {
  accept: 'r:y:',
  decline: 'r:n:',
} as const;

const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const;

/**
 * Даты словами: «5, 12 и 19 августа».
 *
 * Месяц называется один раз, если он общий: человек читает фразу, а не
 * таблицу, и три раза «августа» подряд её ломают.
 */
export function datesInWords(dates: readonly Date[], timeZone: string): string {
  const parts = dates.map((at) => localDateParts(at, timeZone));
  if (parts.length === 0) return '';

  const sameMonth = parts.every((part) => part.month === parts[0]?.month);

  const pieces = parts.map((part, index) => {
    const month = MONTHS[part.month - 1] ?? '';
    return sameMonth && index < parts.length - 1
      ? String(part.day)
      : `${String(part.day)} ${month}`;
  });

  if (pieces.length === 1) return pieces[0] ?? '';

  const last = pieces[pieces.length - 1] ?? '';
  return `${pieces.slice(0, -1).join(', ')} и ${last}`;
}

/** Как назвать ритм по-человечески. */
export function rhythmInWords(rhythm: Rhythm): string {
  if (rhythm.kind === 'weekly') return rhythm.interval === 1 ? 'каждую неделю' : 'раз в две недели';
  if (rhythm.kind === 'monthly') {
    return rhythm.interval === 1 ? 'каждый месяц' : 'раз в два месяца';
  }
  return 'каждый год';
}

export function suggestButtons(suggestionId: string, texts: TextProfile): readonly StatusButton[] {
  const code = toShortId(suggestionId);

  return [
    { label: texts.resolver.buttonRemember, action: `${SUGGEST_ACTION.accept}${code}` },
    { label: texts.resolver.buttonNoNeed, action: `${SUGGEST_ACTION.decline}${code}` },
  ];
}
