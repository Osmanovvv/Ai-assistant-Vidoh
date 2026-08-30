import { localDateParts, startOfDayInZone, type DateParts } from '../classifier/dates.js';
import type { DeadlineAccuracyValue, ReminderKindValue } from '../../db/schema.js';
import { morningDue } from './frequency.js';
import { inQuietHours, quietWindow } from './quiet.js';
import { localDateKey, localTimeToUtc, nextLocalTime, parseLocalTime } from './time.js';

/**
 * Что и когда поставить одному человеку (§11 ТЗ, задачи 3.14–3.17).
 *
 * Чистая функция: на входе настройки, сроки и часы, на выходе список
 * заданий. Ни базы, ни отправки — иначе проверить расчёт времени в пяти
 * поясах можно было бы только поднятым планировщиком, а условие готовности
 * 3.14 требует именно этой проверки.
 */

/**
 * Насколько вперёд смотрим.
 *
 * Тридцать шесть часов, а не двадцать четыре: напоминание «накануне
 * вечером» о завтрашнем сроке должно быть поставлено раньше, чем этот
 * вечер наступит, а планировщик, запущенный утром, иначе его пропустит.
 */
export const HORIZON_HOURS = 36;

/**
 * Когда спрашивать про застрявший проект — середина дня по-местному.
 *
 * Не утром и не вечером: там уже стоят сводки, а инвариант «один вопрос
 * на реплику» (§13.9) не даёт добавить в них второй. Полдень — это
 * единственное время, которое ничем не занято.
 */
export const PROJECT_NUDGE_TIME = '13:00';

export interface PlanSettings {
  readonly morningTime: string;
  readonly eveningTime: string;
  readonly notificationsOn: boolean;
  readonly eveningOn: boolean;
  readonly quietHoursOn: boolean;
  readonly quietFrom: string;
  readonly quietTo: string;
}

export interface PlanDeadline {
  readonly itemId: string;
  readonly deadlineAt: Date;
  readonly accuracy: DeadlineAccuracyValue;
}

export interface PlanInput {
  readonly timeZone: string;
  readonly settings: PlanSettings;
  /** Сколько утренних подряд осталось без реакции (3.17). */
  readonly ignoredStreak: number;
  /** Местная дата последнего отправленного утреннего, в днях от эпохи. */
  readonly lastMorningDay?: number | undefined;
  readonly deadlines: readonly PlanDeadline[];
  /** Проекты, по которым `nudgeDue` уже сказал «пора» (3.13). */
  readonly staleProjects: readonly string[];
  readonly now: Date;
}

export interface PlannedReminder {
  readonly kind: ReminderKindValue;
  readonly itemId?: string | undefined;
  readonly dueAt: Date;
  readonly dedupeKey: string;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * Местный день числом: им считаются интервалы между напоминаниями.
 *
 * Считается по календарной дате, а не по моменту местной полуночи.
 * Второе выглядит естественнее и молча ломается на переводе стрелок:
 * в сутках, укоротившихся до двадцати трёх часов, две соседние полуночи
 * попадают в один и тот же отрезок в 86 400 000 миллисекунд, и «через
 * день» превращается в «сегодня».
 */
export function localDayNumber(at: Date, timeZone: string): number {
  const parts = localDateParts(at, timeZone);

  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS);
}

/** Предыдущий местный день. Полдень посередине — защита от перехода на час. */
function previousDay(parts: DateParts, timeZone: string): DateParts {
  const noon = startOfDayInZone(parts, timeZone).getTime() + 12 * 60 * 60_000;

  return localDateParts(new Date(noon - DAY_MS), timeZone);
}

/**
 * Сроки с точностью «неделя» и «месяц» напоминания не получают.
 *
 * §13 и задача 3.16: «на следующей неделе» — это не понедельник, и
 * напоминание в понедельник утром сработает не тогда. Флаг точности из
 * 2.7 существует ровно для этого.
 */
function remindable(deadline: PlanDeadline): boolean {
  return deadline.accuracy === 'day';
}

export function planFor(input: PlanInput): PlannedReminder[] {
  // Выключатель напоминаний — первый и безусловный (§11).
  if (!input.settings.notificationsOn) return [];

  const { timeZone, settings, now } = input;
  const horizon = now.getTime() + HORIZON_HOURS * 60 * 60_000;
  const planned: PlannedReminder[] = [];

  const silence = settings.quietHoursOn
    ? quietWindow(settings.quietFrom, settings.quietTo)
    : undefined;

  const add = (kind: ReminderKindValue, dueAt: Date, key: string, itemId?: string): void => {
    if (dueAt.getTime() > horizon) return;

    /**
     * Тишина отсекает на этапе планирования, а не отправки.
     *
     * Отложить было бы хуже, чем пропустить: в восемь утра человека ждала
     * бы пачка ночных напоминаний — тот самый раздражитель, от которого
     * §11 велит уходить. Вечерний итог, отправленный назавтра, уже не итог.
     */
    if (silence !== undefined && inQuietHours(localMinutesAt(dueAt, timeZone), silence)) return;

    planned.push({ kind, dueAt, dedupeKey: key, ...(itemId === undefined ? {} : { itemId }) });
  };

  // --- Утреннее (3.15), с учётом снижения частоты (3.17) ---
  const morning = nextLocalTime(now, settings.morningTime, timeZone);
  const due = morningDue({
    today: localDayNumber(morning, timeZone),
    ...(input.lastMorningDay === undefined ? {} : { lastMorningDay: input.lastMorningDay }),
    ignoredStreak: input.ignoredStreak,
  });
  if (due) add('morning', morning, `morning:${localDateKey(morning, timeZone)}`);

  // --- Вечернее (3.15), отдельным выключателем ---
  if (settings.eveningOn) {
    const evening = nextLocalTime(now, settings.eveningTime, timeZone);
    add('evening', evening, `evening:${localDateKey(evening, timeZone)}`);
  }

  // --- По срокам (3.16): накануне вечером и утром в день срока ---
  for (const deadline of input.deadlines) {
    if (!remindable(deadline)) continue;

    const day = localDateParts(deadline.deadlineAt, timeZone);
    const dayKey = localDateKey(deadline.deadlineAt, timeZone);

    const eve = localTimeToUtc(previousDay(day, timeZone), settings.eveningTime, timeZone);
    if (eve.getTime() > now.getTime()) {
      add('deadline_eve', eve, `deadline_eve:${deadline.itemId}:${dayKey}`, deadline.itemId);
    }

    const morningOf = localTimeToUtc(day, settings.morningTime, timeZone);
    if (morningOf.getTime() > now.getTime()) {
      add('deadline_day', morningOf, `deadline_day:${deadline.itemId}:${dayKey}`, deadline.itemId);
    }
  }

  // --- Возврат к проекту (3.13) ---
  for (const itemId of input.staleProjects) {
    const at = nextLocalTime(now, PROJECT_NUDGE_TIME, timeZone);
    add('project', at, `project:${itemId}:${localDateKey(at, timeZone)}`, itemId);
  }

  return planned;
}

/** Минуты от местной полуночи в этот момент. */
function localMinutesAt(at: Date, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);

  const { hours, minutes } = parseLocalTime(formatted);

  return hours * 60 + minutes;
}
