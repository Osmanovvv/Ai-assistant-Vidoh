import type { DeadlineAccuracyValue, ItemTypeValue } from '../../db/schema.js';
import { localMinutes } from '../classifier/clock-time.js';
import { relativeDayWord } from '../items/deadline-words.js';
import { titleWithoutDate } from '../resolver/title-date.js';
import type { TextProfile } from '../../texts/index.js';
import { clockOf, HORIZON_HOURS, planFor, type PlanSettings } from './plan.js';

/**
 * «Напомнишь?» сразу после разговора о деле (живая проверка Никиты
 * 24.09.2026, 17:03).
 *
 * Бот записал «Поехать за ребёнком», человек спросил «Напомнишь ?» — а
 * вопрос ушёл модели ответов, и та выдала обзор дня, назвав открытые дела
 * сделанными: «ты отвела сельди на автостанцию, забрала посылку». Спросили
 * про одно дело и про напоминание, а когда напомнить — знает планировщик.
 *
 * Узнаётся кодом, закрытым списком, и только **целой короткой фразой**:
 * «Напомни, что я хотела сделать с альбомом» — вопрос о делах (§13.4), а
 * «напомнишь, что за ребёнком в 4 часа» — правка часа; их разбирает
 * конвейер как обычно. Ответ — из `planFor`, той же раскладки, что ставит
 * напоминания: своя копия правил однажды разошлась бы с ней.
 */

const TAIL = String.raw`(?: мне)?(?: об этом| про это| о нем| о ней| про него| про нее)?(?: пожалуйста)?`;

const PATTERNS: readonly RegExp[] = [
  // «Напомнишь?», «Ты напомнишь?», «А ты мне напомнишь?», «Ты же напомнишь?»
  new RegExp(String.raw`^(?:а |ну )?(?:ты )?(?:же )?(?:мне )?напомнишь(?: же)?${TAIL}$`, 'u'),
  // «Не забудешь напомнить?»
  new RegExp(String.raw`^(?:а |ну )?(?:ты )?не забудешь(?: мне)? напомнить${TAIL}$`, 'u'),
  // «Напомни мне», «Напомни об этом»
  new RegExp(String.raw`^(?:а |ну )?напомни${TAIL}$`, 'u'),
];

function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[?!.,…:;—-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function asksToRemind(text: string): boolean {
  const said = normalized(text);
  return said !== '' && PATTERNS.some((pattern) => pattern.test(said));
}

/** Дело, о котором спросили: ровно то, что нужно раскладке. */
export interface RemindItem {
  readonly id: string;
  readonly text: string;
  readonly type: ItemTypeValue | null;
  readonly deadlineAt: Date | null;
  readonly deadlineAccuracy: DeadlineAccuracyValue | null;
  readonly deadlineTime: number | null;
}

export interface RemindAnswerParams {
  readonly item: RemindItem;
  readonly settings: PlanSettings;
  readonly now: Date;
  readonly timeZone: string;
  readonly texts: TextProfile;
}

const HOUR_MS = 60 * 60_000;
/** У «месяца» возврат в начале периода, а период — до тридцати одного дня. */
const PERIOD_HOURS = 32 * 24;

/** «сегодня в 21:00, завтра в 08:00 и в 15:30»: день второй раз не называется. */
function whenWords(moments: readonly Date[], now: Date, timeZone: string): string {
  const parts: string[] = [];
  let previousDay: string | undefined;
  for (const at of moments) {
    const day = relativeDayWord(at, now, timeZone);
    const clock = `в ${clockOf(localMinutes(at, timeZone))}`;
    parts.push(day === previousDay ? clock : `${day} ${clock}`);
    previousDay = day;
  }
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} и ${parts.at(-1) ?? ''}`;
}

export function remindAnswer(params: RemindAnswerParams): string {
  const { item, settings, now, timeZone, texts } = params;
  const title = titleWithoutDate(item.text);

  if (!settings.notificationsOn) return texts.reminders.remindOff;
  if (item.deadlineAt === null || item.deadlineAccuracy === null) {
    return texts.reminders.remindNoDeadline(title);
  }
  // Сведение с датой планировщик не напоминает (прогон 18.09.2026).
  if (item.type === 'INFO') return texts.reminders.remindNothingAhead(title);

  const untilDeadline = Math.ceil((item.deadlineAt.getTime() - now.getTime()) / HOUR_MS);
  const moments = planFor({
    timeZone,
    settings,
    ignoredStreak: 0,
    deadlines: [
      {
        itemId: item.id,
        deadlineAt: item.deadlineAt,
        accuracy: item.deadlineAccuracy,
        time: item.deadlineTime,
      },
    ],
    staleProjects: [],
    now,
    horizonHours: Math.max(HORIZON_HOURS, untilDeadline + PERIOD_HOURS),
  })
    .filter((planned) => planned.itemId === item.id)
    .map((planned) => planned.dueAt)
    .sort((left, right) => left.getTime() - right.getTime());

  if (moments.length === 0) return texts.reminders.remindNothingAhead(title);

  const will = texts.reminders.remindWill(title, whenWords(moments, now, timeZone));
  return item.deadlineAccuracy === 'day' && item.deadlineTime === null
    ? `${will} ${texts.reminders.remindAddHour}`
    : will;
}
