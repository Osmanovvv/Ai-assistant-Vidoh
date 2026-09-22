import { localDateParts, startOfDayInZone, type DateParts } from '../classifier/dates.js';
import type { DeadlineAccuracyValue, ReminderKindValue } from '../../db/schema.js';
import { morningDue } from './frequency.js';
import { effectiveQuiet, inQuietHours, quietWindow } from './quiet.js';
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
 *
 * Было `13:00` при этом же комментарии и при плане 3.14, где сказано
 * «в полдень» (ревизия этапа 3, D10): код приведён к написанному.
 */
export const PROJECT_NUDGE_TIME = '12:00';

export interface PlanSettings {
  readonly morningTime: string;
  readonly eveningTime: string;
  readonly notificationsOn: boolean;
  readonly eveningOn: boolean;
  readonly quietHoursOn: boolean;
  readonly quietFrom: string;
  readonly quietTo: string;
  /**
   * За сколько минут до названного часа напоминать (ТЗ проджекта
   * 17.09.2026, шаг 5). Не задано — `DEFAULT_HOUR_LEAD_MINUTES`; ноль —
   * ровно в час. Настройка панели `reminders.hour_lead_minutes`.
   */
  readonly hourLeadMinutes?: number | undefined;
}

/** Упреждение по умолчанию: полчаса — успеть собраться, а не вспомнить задним числом. */
export const DEFAULT_HOUR_LEAD_MINUTES = 30;

export interface PlanDeadline {
  readonly itemId: string;
  readonly deadlineAt: Date;
  readonly accuracy: DeadlineAccuracyValue;
  /** Час внутри дня, минуты от местной полуночи; пусто — не назван. */
  readonly time?: number | null | undefined;
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

/**
 * Сколько длится неточный период: неделя — семь дней от понедельника,
 * месяц — тридцать один от первого числа (та же мера, что у выдачи:
 * точность «месяц» не про число, а про «где-то в этом месяце»).
 */
const PERIOD_MS: Readonly<Record<'week' | 'month', number>> = {
  week: 7 * 24 * 60 * 60_000,
  month: 31 * 24 * 60 * 60_000,
};

/**
 * Ключ мягкого возврата: запись и **день начала периода**. Дата отправки
 * в ключ не входит нарочно — так возврат один на период, даже если он
 * ушёл «следующим утром», а не утром первого дня.
 */
export function periodKey(itemId: string, deadlineAt: Date, timeZone: string): string {
  return `period:${itemId}:${localDateKey(deadlineAt, timeZone)}`;
}

/**
 * Ключ задания по сроку: вид, запись и **день срока**.
 *
 * Тот же ключ считает и отправка (ревизия этапа 3, D1): если срок записи
 * с тех пор изменился, ключ не сойдётся, и задание про день, которого
 * больше нет, не уйдёт. Одна функция на раскладку и проверку — иначе
 * они однажды разошлись бы форматом, и проверка пропускала бы всё.
 */
export function deadlineKey(
  kind: 'deadline_eve' | 'deadline_day',
  itemId: string,
  deadlineAt: Date,
  timeZone: string,
): string {
  return `${kind}:${itemId}:${localDateKey(deadlineAt, timeZone)}`;
}

/** «13:00» из минут от полуночи. */
export function clockOf(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * Ключ напоминания в указанный час: с датой и часом. Перенесла на другой
 * час — ключ не сойдётся, и старое напоминание не уйдёт (сверяется на
 * отправке, как у срока).
 */
export function hourKey(itemId: string, deadlineAt: Date, time: number, timeZone: string): string {
  return `deadline_hour:${itemId}:${localDateKey(deadlineAt, timeZone)}:${clockOf(time)}`;
}

export function planFor(input: PlanInput): PlannedReminder[] {
  // Выключатель напоминаний — первый и безусловный (§11).
  if (!input.settings.notificationsOn) return [];

  const { timeZone, settings, now } = input;
  const horizon = now.getTime() + HORIZON_HOURS * 60 * 60_000;
  const planned: PlannedReminder[] = [];

  /**
   * Тишина ужимается под времена, которые человек выбрал сам.
   *
   * Иначе умолчание 22:00–08:00 молча отменяет выбранное им утро в 07:00 —
   * и он не получает утреннее напоминание никогда. Явный выбор сильнее
   * умолчания; подробности в `quiet.ts`.
   */
  const silence = settings.quietHoursOn
    ? effectiveQuiet(quietWindow(settings.quietFrom, settings.quietTo), {
        morning: minutesOf(settings.morningTime),
        evening: minutesOf(settings.eveningTime),
      })
    : undefined;

  const add = (
    kind: ReminderKindValue,
    dueAt: Date,
    key: string,
    itemId?: string,
    /**
     * Час, названный человеком, тишина не закрывает — как выбранное им
     * утро (ТЗ проджекта 17.09.2026, шаг 5): «в 23:00» он сказал сам.
     */
    chosenByPerson = false,
  ): void => {
    if (dueAt.getTime() > horizon) return;

    /**
     * Тишина отсекает на этапе планирования, а не отправки.
     *
     * Отложить было бы хуже, чем пропустить: в восемь утра человека ждала
     * бы пачка ночных напоминаний — тот самый раздражитель, от которого
     * §11 велит уходить. Вечерний итог, отправленный назавтра, уже не итог.
     */
    if (
      !chosenByPerson &&
      silence !== undefined &&
      inQuietHours(localMinutesAt(dueAt, timeZone), silence)
    ) {
      return;
    }

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

  /**
   * --- Неточные сроки: один мягкий возврат (решение заказчицы 15.09.2026) ---
   *
   * 3.16 таким записям напоминаний не давал вовсе; 14.09 заказчица
   * назвала это противоречием «помнить за меня», 15.09 выбрала форму:
   * «не ставить искусственный дедлайн на последний день периода; один
   * раз мягко вернуть дело в начале периода; если не отреагировала —
   * ежедневно не повторять». Неделя хранится понедельником, месяц —
   * первым числом (`filter.ts`), значит «начало периода» — утро этого
   * дня, в её утреннее время. Период уже идёт («на этой неделе» сказано
   * в среду) — начало для такого дела сейчас: следующим утром. Период
   * прошёл целиком — ничего: дело остаётся в списке, и это не просрочка.
   */
  for (const deadline of input.deadlines) {
    if (deadline.accuracy !== 'week' && deadline.accuracy !== 'month') continue;
    if (deadline.deadlineAt.getTime() + PERIOD_MS[deadline.accuracy] <= now.getTime()) continue;

    const start = localTimeToUtc(
      localDateParts(deadline.deadlineAt, timeZone),
      settings.morningTime,
      timeZone,
    );
    const at =
      start.getTime() > now.getTime() ? start : nextLocalTime(now, settings.morningTime, timeZone);

    add('period', at, periodKey(deadline.itemId, deadline.deadlineAt, timeZone), deadline.itemId);
  }

  // --- По срокам (3.16): накануне вечером и утром в день срока ---
  for (const deadline of input.deadlines) {
    if (!remindable(deadline)) continue;

    const day = localDateParts(deadline.deadlineAt, timeZone);
    const keyOf = (kind: 'deadline_eve' | 'deadline_day'): string =>
      deadlineKey(kind, deadline.itemId, deadline.deadlineAt, timeZone);

    const eve = localTimeToUtc(previousDay(day, timeZone), settings.eveningTime, timeZone);
    if (eve.getTime() > now.getTime()) {
      add('deadline_eve', eve, keyOf('deadline_eve'), deadline.itemId);
    }

    const morningOf = localTimeToUtc(day, settings.morningTime, timeZone);
    if (morningOf.getTime() > now.getTime()) {
      add('deadline_day', morningOf, keyOf('deadline_day'), deadline.itemId);
    }

    // --- В указанный час (ТЗ проджекта 17.09.2026, шаг 5) ---
    if (deadline.time !== undefined && deadline.time !== null) {
      const lead = settings.hourLeadMinutes ?? DEFAULT_HOUR_LEAD_MINUTES;
      const moment = localTimeToUtc(day, clockOf(deadline.time), timeZone);
      const early = new Date(moment.getTime() - lead * 60_000);
      /**
       * Момент упреждения уже позади, а час ещё впереди — напоминание
       * ровно в час (бой 22.09.2026: «сегодня в 3:10», сказано в 2:39 —
       * 2:40 прошло, и напоминания не было вовсе). Ключ тот же: это то
       * же напоминание, просто без запаса.
       */
      const at = early.getTime() > now.getTime() ? early : moment;
      if (at.getTime() > now.getTime()) {
        add(
          'deadline_hour',
          at,
          hourKey(deadline.itemId, deadline.deadlineAt, deadline.time, timeZone),
          deadline.itemId,
          true,
        );
      }
    }
  }

  // --- Возврат к проекту (3.13) ---
  for (const itemId of input.staleProjects) {
    const at = nextLocalTime(now, PROJECT_NUDGE_TIME, timeZone);
    add('project', at, `project:${itemId}:${localDateKey(at, timeZone)}`, itemId);
  }

  return planned;
}

/** Минуты от местной полуночи по строке времени из настроек. */
function minutesOf(localTime: string): number {
  const { hours, minutes } = parseLocalTime(localTime);

  return hours * 60 + minutes;
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
