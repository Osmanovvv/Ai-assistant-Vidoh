import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import {
  items,
  projectSteps,
  reminders,
  userSettings,
  users,
  type Item,
  type Reminder,
} from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { textsFor } from '../../texts/index.js';
import type { TextProfile } from '../../texts/types.js';
import { localDateParts, startOfDayInZone } from '../classifier/dates.js';
import { openItemsFor } from '../items/items.repo.js';
import { effectiveEnergy, selectForToday } from '../output/filter.js';
import type { QuestionSender } from '../presenter/telegram-sender.js';
import type { StatusButton } from '../presenter/status.service.js';
import { nudgeDue } from '../projects/projects.service.js';
import { sweepHistory } from '../recurrence/history.service.js';
import { datesInWords, rhythmInWords, suggestButtons } from '../recurrence/suggest-text.js';
import { outputContextOf } from '../users/state.repo.js';
import { deadlineText, eveningText, morningText, projectText } from './digest.js';
import { HORIZON_HOURS, planFor, type PlanDeadline } from './plan.js';
import { deadlineButtons, projectButtons } from './reminder-actions.js';
import {
  countAttempt,
  duePending,
  ignoredStreak,
  itemsWithDeadlineReminder,
  lastMorningDay,
  markSent,
  markSkipped,
  storePlanned,
} from './reminders.repo.js';

/**
 * Планировщик (§11 ТЗ, задачи 3.13–3.17).
 *
 * Два прохода, и они намеренно раздельные.
 *
 * **Раскладка** смотрит вперёд и ставит задания с ключом, исключающим
 * дубли. Её можно запускать сколько угодно раз: повторный проход упрётся
 * в уникальный индекс и ничего не добавит.
 *
 * **Рассылка** берёт то, чему подошёл срок, порциями. §11 требует
 * распределять отправку во времени с учётом ограничений Telegram —
 * порция и есть это распределение: остаток уйдёт на следующем проходе,
 * а не сорока запросами в одну секунду.
 *
 * Разделение стоит одной лишней таблицы и снимает целый класс ошибок:
 * если рассылка упала посередине, отправленное помечено, и второй заход
 * не пришлёт его снова.
 */

export interface SchedulerDeps {
  readonly db: Database;
  readonly sender: QuestionSender;
  readonly logger: Logger;
  /**
   * Искать ли регулярность в накопленной истории (задача 3.17а).
   *
   * Тот же выключатель, что у предложений из 3.8в: обе функции опираются
   * на неизмеренный порог «это то же самое дело» и обе выключены до
   * калибровки на живых данных.
   */
  readonly suggestRecurrence?: boolean | undefined;
}

/**
 * Сколько напоминаний отправляем за один проход.
 *
 * Telegram разрешает около тридцати сообщений в секунду на бота. Двадцать
 * с паузой между ними — с большим запасом, а при тестовой группе в
 * несколько человек порция вообще не заполнится.
 */
export const DISPATCH_BATCH = 20;

/**
 * Сколько раз пробуем отправить, прежде чем сдаться.
 *
 * Три: проход планировщика раз в минуту, значит на сбой связи отводится
 * три минуты. Бесконечный повтор был бы хуже потери — он превратил бы
 * одно недоставленное сообщение в вечную нагрузку на Telegram.
 */
export const MAX_ATTEMPTS = 3;

/** Пауза между отправками внутри порции. */
export const SEND_SPACING_MS = 120;

/** Сколько пользователей раскладываем за проход. */
const PLAN_BATCH = 500;

const DAY_MS = 24 * 60 * 60_000;

/**
 * Что считается открытой записью.
 *
 * Тот же список, что у `openItemsFor`: «открыто» должно означать одно и
 * то же везде, иначе напоминание придёт о деле, которого человек в своих
 * списках уже не видит.
 */
const OPEN_STATUSES = ['new', 'active', 'in_progress', 'waiting'] as const;

interface Recipient {
  readonly userId: string;
  readonly tgId: number;
  readonly timeZone: string;
  readonly textProfile: string;
  readonly morningTime: string;
  readonly eveningTime: string;
  readonly notificationsOn: boolean;
  readonly eveningOn: boolean;
  readonly quietHoursOn: boolean;
  readonly quietFrom: string;
  readonly quietTo: string;
}

/** Кому вообще пишем: незаблокированные, с настройками. */
async function recipients(db: Database): Promise<Recipient[]> {
  return await db
    .select({
      userId: users.id,
      tgId: users.tgId,
      timeZone: users.timezone,
      textProfile: userSettings.textProfile,
      morningTime: userSettings.morningTime,
      eveningTime: userSettings.eveningTime,
      notificationsOn: userSettings.notificationsOn,
      eveningOn: userSettings.eveningOn,
      quietHoursOn: userSettings.quietHoursOn,
      quietFrom: userSettings.quietFrom,
      quietTo: userSettings.quietTo,
    })
    .from(users)
    .innerJoin(userSettings, eq(userSettings.userId, users.id))
    .where(eq(users.isBlocked, false))
    .limit(PLAN_BATCH);
}

/**
 * Раскладывает задания на ближайшие сутки с небольшим запасом.
 *
 * Возвращает, сколько заданий действительно записалось. Ноль на втором
 * проходе подряд — это не сбой, а доказательство, что ключ работает.
 */
export async function planReminders(
  deps: SchedulerDeps,
  params: { readonly now?: Date | undefined } = {},
): Promise<number> {
  const now = params.now ?? new Date();
  let created = 0;

  for (const person of await recipients(deps.db)) {
    if (!person.notificationsOn) continue;

    try {
      const planned = planFor({
        timeZone: person.timeZone,
        settings: person,
        ignoredStreak: await ignoredStreak(deps.db, {
          userId: person.userId,
          timeZone: person.timeZone,
        }),
        lastMorningDay: await lastMorningDay(deps.db, {
          userId: person.userId,
          timeZone: person.timeZone,
        }),
        deadlines: await deadlinesOf(deps.db, person.userId, now),
        staleProjects: await staleProjectsOf(deps.db, person.userId, now),
        now,
      });

      created += (await storePlanned(deps.db, person.userId, planned)).length;
    } catch (error) {
      // Один пользователь не должен ронять раскладку остальным.
      deps.logger.error({ err: error, userId: person.userId }, 'Не разложились напоминания');
    }
  }

  return created;
}

/** Сроки, до которых осталось меньше горизонта планирования. */
async function deadlinesOf(db: Database, userId: string, now: Date): Promise<PlanDeadline[]> {
  const until = new Date(now.getTime() + HORIZON_HOURS * 60 * 60_000);

  const rows = await db
    .select({
      itemId: items.id,
      deadlineAt: items.deadlineAt,
      accuracy: items.deadlineAccuracy,
    })
    .from(items)
    .where(
      and(
        eq(items.userId, userId),
        eq(items.isDraft, false),
        inArray(items.status, OPEN_STATUSES),
        isNotNull(items.deadlineAt),
        // Запас назад: срок сегодня утром ещё нужен вечернему накануне.
        gt(items.deadlineAt, new Date(now.getTime() - DAY_MS)),
        lte(items.deadlineAt, until),
      ),
    );

  return rows.flatMap((row) =>
    row.deadlineAt === null || row.accuracy === null
      ? []
      : [{ itemId: row.itemId, deadlineAt: row.deadlineAt, accuracy: row.accuracy }],
  );
}

/**
 * Проекты, о которых пора спросить (задача 3.13).
 *
 * Правило `nudgeDue` было готово с 3.13 и до сих пор некому было его
 * позвать. Зовём здесь.
 */
async function staleProjectsOf(db: Database, userId: string, now: Date): Promise<string[]> {
  const rows = await db
    .select({
      itemId: items.id,
      lastMovedAt: items.updatedAt,
      remaining: sql<number>`count(${projectSteps.id}) filter (where ${projectSteps.doneAt} is null)::int`,
      lastNudgeAt: sql<Date | null>`max(${reminders.sentAt})`,
    })
    .from(items)
    .leftJoin(projectSteps, eq(projectSteps.itemId, items.id))
    .leftJoin(
      reminders,
      and(
        eq(reminders.itemId, items.id),
        eq(reminders.kind, 'project'),
        isNotNull(reminders.sentAt),
      ),
    )
    .where(
      and(
        eq(items.userId, userId),
        eq(items.isDraft, false),
        inArray(items.status, OPEN_STATUSES),
        eq(items.isProject, true),
      ),
    )
    .groupBy(items.id, items.updatedAt);

  return rows
    .filter((row) =>
      nudgeDue({
        lastMovedAt: row.lastMovedAt,
        ...(row.lastNudgeAt === null ? {} : { lastNudgeAt: new Date(row.lastNudgeAt) }),
        hasNext: row.remaining > 0,
        now,
      }),
    )
    .map((row) => row.itemId);
}

/**
 * Отправляет то, чему подошёл срок.
 *
 * Возвращает число отправленных. Пропущенные не считаются отправленными:
 * иначе счётчик молчания (3.17) принял бы нашу собственную тишину за
 * молчание человека и начал бы снижать частоту ни за что.
 */
export async function dispatchReminders(
  deps: SchedulerDeps,
  params: { readonly now?: Date | undefined; readonly limit?: number | undefined } = {},
): Promise<number> {
  const now = params.now ?? new Date();
  const due = await duePending(deps.db, { now, limit: params.limit ?? DISPATCH_BATCH });

  let sent = 0;
  for (const reminder of due) {
    try {
      if (await sendOne(deps, reminder, now)) sent += 1;
    } catch (error) {
      deps.logger.error({ err: error, reminderId: reminder.id }, 'Напоминание не отправлено');
    }

    /**
     * Пауза между отправками — это и есть «распределение во времени» из
     * §11. Без неё порция в двадцать напоминаний уходит одним залпом и
     * упирается в ограничение Telegram, а упёршись, теряет хвост.
     */
    await pause(SEND_SPACING_MS);
  }

  return sent;
}

async function sendOne(deps: SchedulerDeps, reminder: Reminder, now: Date): Promise<boolean> {
  const [person] = await deps.db
    .select({
      tgId: users.tgId,
      isBlocked: users.isBlocked,
      notificationsOn: userSettings.notificationsOn,
      textProfile: userSettings.textProfile,
      timeZone: users.timezone,
    })
    .from(users)
    .innerJoin(userSettings, eq(userSettings.userId, users.id))
    .where(eq(users.id, reminder.userId))
    .limit(1);

  if (!person) {
    await markSkipped(deps.db, reminder.id, 'gone');
    return false;
  }

  /**
   * Настройки проверяются ещё раз, на отправке.
   *
   * Между раскладкой и отправкой проходит до полутора суток, и человек
   * успевает выключить напоминания. Отправить то, что было запланировано
   * при включённых, — значит не выполнить настройку.
   */
  if (person.isBlocked || !person.notificationsOn) {
    await markSkipped(deps.db, reminder.id, person.isBlocked ? 'blocked' : 'off');
    return false;
  }

  const texts = textsFor(person.textProfile);
  const message = await composeOne(deps, reminder, texts, now);

  if (message === undefined) {
    await markSkipped(deps.db, reminder.id, 'gone');
    return false;
  }

  /**
   * Отправитель возвращает номер сообщения, а при сбое — ноль.
   *
   * Раньше ответ не смотрели вовсе, и сорвавшаяся отправка помечалась
   * отправленной: сообщение терялось молча, а человек, ничего не
   * получивший, попадал в серию молчания (3.17) — продукт снижал ему
   * частоту за собственный сбой. §5 ТЗ держит для этого колонку
   * `attempts`, и держит не ради статистики: повтор должен быть конечным.
   */
  const messageId = await deps.sender.ask({
    chatId: person.tgId,
    text: message.text,
    rows: message.buttons.length === 0 ? [] : [message.buttons],
  });

  if (messageId === 0) {
    const attempts = await countAttempt(deps.db, reminder.id);

    if (attempts >= MAX_ATTEMPTS) {
      await markSkipped(deps.db, reminder.id, 'failed');
      deps.logger.error(
        { reminderId: reminder.id, attempts },
        'Напоминание не удалось отправить, больше не пробуем',
      );
    }

    return false;
  }

  await markSent(deps.db, reminder.id, now);
  return true;
}

interface ComposedReminder {
  readonly text: string;
  readonly buttons: readonly StatusButton[];
}

/**
 * Собирает реплику. `undefined` — отправлять больше нечего.
 *
 * Самый важный случай здесь — закрытое дело. Напоминание о сроке ставится
 * накануне вечером, а закрыть дело человек может ночью. Напомнить утром о
 * том, что он уже сделал, — это не безобидная мелочь: продукт показывает,
 * что не заметил сделанного.
 */
async function composeOne(
  deps: SchedulerDeps,
  reminder: Reminder,
  texts: TextProfile,
  now: Date,
): Promise<ComposedReminder | undefined> {
  switch (reminder.kind) {
    case 'morning': {
      const context = await outputContextOf(deps.db, reminder.userId);
      const today = selectForToday(await openItemsFor(deps.db, reminder.userId), {
        energy: effectiveEnergy(context.state, context.energyDefault, {
          now,
          timeZone: context.timeZone,
        }),
        now,
        timeZone: context.timeZone,
      });

      /**
       * Дела, у которых сегодня своё напоминание по сроку, из сводки
       * выпадают.
       *
       * Напоминание «сегодня срок» встаёт на то же местное утро, что и
       * сводка: человек получал два сообщения подряд про одну запись.
       * Остаётся то, что полезнее, — у отдельного есть кнопки «Сделано»
       * и «Перенести».
       */
      const dayStart = startOfDayInZone(localDateParts(now, context.timeZone), context.timeZone);
      const covered = await itemsWithDeadlineReminder(deps.db, {
        userId: reminder.userId,
        from: dayStart,
        to: new Date(dayStart.getTime() + DAY_MS),
      });

      return {
        text: morningText(
          texts,
          today.filter((item) => !covered.has(item.id)),
        ),
        buttons: [],
      };
    }

    case 'evening': {
      const context = await outputContextOf(deps.db, reminder.userId);
      const closed = await closedToday(deps.db, reminder.userId, now, context.timeZone);

      /**
       * Обход накопленной истории (задача 3.17а).
       *
       * Здесь и только здесь: отдельным сообщением такое предложение
       * было бы вторжением, а в утренней сводке — вопросом там, где
       * человек ещё не начал день. Правила 3.17 действуют полностью и
       * бесплатно: если вечернее напоминание не поставлено из-за тишины
       * или выключателя, обхода не будет вовсе — некому его звать.
       */
      const found =
        deps.suggestRecurrence === true
          ? await sweepHistory(
              { db: deps.db, logger: deps.logger },
              { userId: reminder.userId, now },
            )
          : undefined;

      if (found === undefined) return { text: eveningText(texts, closed), buttons: [] };

      return {
        text: eveningText(
          texts,
          closed,
          texts.resolver.noticed(
            found.title,
            datesInWords(found.dates, context.timeZone),
            rhythmInWords(found.rhythm),
          ),
        ),
        buttons: suggestButtons(found.suggestionId, texts),
      };
    }

    case 'deadline_eve':
    case 'deadline_day': {
      const item = await openItem(deps.db, reminder);
      if (!item) return undefined;

      return {
        text: deadlineText(texts, { item, onDay: reminder.kind === 'deadline_day' }),
        buttons: deadlineButtons(item.id, texts),
      };
    }

    case 'project': {
      const item = await openItem(deps.db, reminder);
      if (!item) return undefined;

      const [step] = await deps.db
        .select()
        .from(projectSteps)
        .where(and(eq(projectSteps.itemId, item.id), isNull(projectSteps.doneAt)))
        .orderBy(asc(projectSteps.position))
        .limit(1);

      if (!step) return undefined;

      return {
        text: projectText(texts, { title: item.text, step: step.text }),
        buttons: projectButtons(item.id, texts),
      };
    }
  }
}

/** Запись напоминания, если она ещё открыта. */
async function openItem(db: Database, reminder: Reminder): Promise<Item | undefined> {
  if (reminder.itemId === null) return undefined;

  const [item] = await db
    .select()
    .from(items)
    .where(and(eq(items.id, reminder.itemId), inArray(items.status, OPEN_STATUSES)))
    .limit(1);

  return item;
}

/** Сколько дел закрыто за сегодняшний местный день. */
async function closedToday(
  db: Database,
  userId: string,
  now: Date,
  timeZone: string,
): Promise<number> {
  const from = startOfDayInZone(localDateParts(now, timeZone), timeZone);

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(items)
    .where(
      and(
        eq(items.userId, userId),
        eq(items.status, 'done'),
        isNotNull(items.completedAt),
        sql`${items.completedAt} >= ${from}`,
      ),
    );

  return row?.count ?? 0;
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Один проход планировщика: разложить и разослать.
 *
 * Именно в таком порядке. Напоминание, чей срок наступил только что,
 * уходит в тот же проход, а не ждёт следующего: иначе утреннее в 08:30
 * приходило бы в 08:35, и человек, поставивший точное время, видел бы,
 * что оно не соблюдается.
 */
export async function runScheduler(
  deps: SchedulerDeps,
  params: { readonly now?: Date | undefined } = {},
): Promise<{ readonly planned: number; readonly sent: number }> {
  const now = params.now ?? new Date();

  return {
    planned: await planReminders(deps, { now }),
    sent: await dispatchReminders(deps, { now }),
  };
}

/** Последнее отправленное напоминание вида — для проверок и отладки. */
export async function lastReminderOf(
  db: Database,
  params: { readonly userId: string; readonly kind: Reminder['kind'] },
): Promise<Reminder | undefined> {
  const [row] = await db
    .select()
    .from(reminders)
    .where(and(eq(reminders.userId, params.userId), eq(reminders.kind, params.kind)))
    .orderBy(desc(reminders.dueAt))
    .limit(1);

  return row;
}

/**
 * Как часто просыпается планировщик.
 *
 * Минута. Человек, поставивший 08:30, получает напоминание между 08:30 и
 * 08:31 — расхождение, которого он не заметит. Пять минут заметил бы:
 * точное время в настройках, которое соблюдается «примерно», — это не
 * настройка, а обещание.
 */
export const TICK_MS = 60_000;

/**
 * Запускает планировщик и возвращает способ его остановить.
 *
 * Проходы не накладываются: следующий не начнётся, пока идёт текущий.
 * Иначе долгая рассылка встретила бы вторую такую же, и обе спорили бы
 * за одни и те же задания — от дублей спасал бы только ключ, а спасать
 * его должно от перезапуска, а не от нас самих.
 */
export function startScheduler(deps: SchedulerDeps, intervalMs: number = TICK_MS): () => void {
  let running = false;

  const timer = setInterval(() => {
    if (running) return;
    running = true;

    void runScheduler(deps)
      .then((outcome) => {
        if (outcome.planned > 0 || outcome.sent > 0) {
          deps.logger.info(outcome, 'Проход планировщика');
        }
      })
      .catch((error: unknown) => {
        deps.logger.error({ err: error }, 'Проход планировщика не удался');
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
