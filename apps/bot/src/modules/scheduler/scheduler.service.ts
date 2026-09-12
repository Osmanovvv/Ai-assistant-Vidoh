import { and, asc, eq, gt, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
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
import { accessOf } from '../billing/subscription.service.js';
import type { SettingsRegistry } from '../settings/settings.repo.js';
import { textsFor } from '../../texts/index.js';
import type { TextProfile } from '../../texts/types.js';
import { localDateParts, startOfDayInZone } from '../classifier/dates.js';
import { openItemsFor, openItemsWhere } from '../items/items.repo.js';
import { selectForToday } from '../output/filter.js';
import type { QuestionSender } from '../presenter/telegram-sender.js';
import type { StatusButton } from '../presenter/status.service.js';
import { nudgeDue } from '../projects/projects.service.js';
import { sweepHistory } from '../recurrence/history.service.js';
import { datesInWords, rhythmInWords, suggestButtons } from '../recurrence/suggest-text.js';
import { outputContextOf } from '../users/state.repo.js';
import { deadlineText, eveningText, morningText, projectText } from './digest.js';
import { deadlineKey, HORIZON_HOURS, planFor, type PlanDeadline } from './plan.js';
import { deadlineButtons, projectButtons } from './reminder-actions.js';
import {
  countAttempt,
  duePending,
  ignoredStreak,
  itemsWithDeadlineReminder,
  lastMorningDay,
  markSent,
  markSkipped,
  type SkipReason,
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
  /**
   * Реестр настроек — чтобы спросить доступ (ревизия четвёртого этапа).
   *
   * Утреннее и вечернее напоминания приглашали выгружать того, кому бот
   * в ответ откажет: «наговори, разложу» — а на наговорённое приходит
   * «пробные разборы закончились». Приглашение, которое бот сам не
   * исполнит, повторялось ежедневно.
   *
   * Необязателен: без него доступ считается открытым, как и раньше.
   */
  readonly settings?: SettingsRegistry | undefined;
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

/**
 * Сколько людей берём **одной страницей** (не «за проход»).
 *
 * Правка ревизии четвёртого этапа: прежде это был предел прохода, и
 * начиная с пятьсот первого человека напоминания не раскладывались
 * вовсе — молча. Теперь это размер страницы, а раскладка идёт до
 * исчерпания: держать в памяти всех сразу незачем, а пропустить
 * человека нельзя.
 */
const PLAN_BATCH = 500;

const DAY_MS = 24 * 60 * 60_000;

/**
 * Что считается открытой записью — условие берётся из `items.repo`.
 *
 * Своя копия списка статусов здесь была, и с появлением фона (§13.6) она
 * стала опасной: напоминание пришло бы о деле, которое человек убрал с
 * глаз. «Открыто» должно означать одно и то же везде.
 */

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

/**
 * Кому вообще пишем: незаблокированные, с настройками.
 *
 * **Страницами до исчерпания, а не первые пятьсот** — правка ревизии
 * четвёртого этапа. Прежде здесь стоял `limit(PLAN_BATCH)` без порядка и
 * без продолжения: начиная с пятьсот первого человека напоминания не
 * раскладывались **вовсе**, и узнать об этом было неоткуда — ни числа, ни
 * строки в журнале. Порядок строк при этом задавал Postgres, то есть
 * «первые пятьсот» каждый проход могли быть разными.
 *
 * Порядок по `users.id` устойчив, и курсор идёт по нему же: без порядка
 * страницы пересекались бы или пропускали людей, а пропущенный человек
 * — это человек без утреннего письма.
 */
async function recipients(db: Database): Promise<Recipient[]> {
  const all: Recipient[] = [];
  let after: string | undefined;

  for (;;) {
    const page = await db
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
      .where(
        after === undefined
          ? eq(users.isBlocked, false)
          : and(eq(users.isBlocked, false), gt(users.id, after)),
      )
      .orderBy(users.id)
      .limit(PLAN_BATCH);

    all.push(...page);

    if (page.length < PLAN_BATCH) return all;

    after = page[page.length - 1]?.userId;

    // Курсора нет — дальше идти некуда, и молча зациклиться нельзя.
    if (after === undefined) return all;
  }
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
        openItemsWhere(userId),
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
    /**
     * Окликаем только по **делам**, хотя большой целью с 05.09.2026 может
     * быть и желание.
     *
     * Разрешение признака желанию сделано ради вопроса человека — «где мы»
     * и «какой следующий шаг», — то есть ради ответа, когда спросили. А
     * напоминание «неделя без движения» — это окликание, и желанию оно не
     * годится: §6.3 держит желания списком «когда-нибудь», и давить ими
     * нельзя. Человек, сказавший «хочу когда-нибудь свой сайт», не просил
     * напоминать ему об этом каждую неделю.
     */
    .where(and(openItemsWhere(userId), eq(items.isProject, true), eq(items.type, 'TASK')))
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
      /**
       * Исключение — тоже попытка (ревизия этапа 3, D8).
       *
       * Раньше оно только писалось в журнал: попытка не считалась, и та
       * же строка пробовалась каждую минуту без предела — а при двадцати
       * таких порция была занята ими целиком, и здоровые за ними не
       * уходили. Счёт и предел те же, что у отказа Telegram.
       */
      deps.logger.error({ err: error, reminderId: reminder.id }, 'Напоминание не отправлено');
      await noteFailure(deps, reminder);
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
  const message = await composeOne(deps, reminder, texts, now, person.timeZone);

  if (typeof message === 'string') {
    await markSkipped(deps.db, reminder.id, message);
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
    await noteFailure(deps, reminder);
    return false;
  }

  await markSent(deps.db, reminder.id, now);
  return true;
}

/** Сорвавшаяся попытка засчитана; после `MAX_ATTEMPTS` — сдаёмся вслух. */
async function noteFailure(deps: SchedulerDeps, reminder: Reminder): Promise<void> {
  const attempts = await countAttempt(deps.db, reminder.id);

  if (attempts >= MAX_ATTEMPTS) {
    await markSkipped(deps.db, reminder.id, 'failed');
    deps.logger.error(
      { reminderId: reminder.id, attempts },
      'Напоминание не удалось отправить, больше не пробуем',
    );
  }
}

interface ComposedReminder {
  readonly text: string;
  readonly buttons: readonly StatusButton[];
}

/**
 * Собирает реплику или называет причину, почему отправлять нечего.
 *
 * Самый важный случай здесь — закрытое дело. Напоминание о сроке ставится
 * накануне вечером, а закрыть дело человек может ночью. Напомнить утром о
 * том, что он уже сделал, — это не безобидная мелочь: продукт показывает,
 * что не заметил сделанного.
 */
/**
 * Пустит ли бот новую выгрузку прямо сейчас (ревизия четвёртого этапа).
 *
 * Спрашивается **при сборке напоминания**, а не при раскладке: между
 * раскладкой и отправкой проходят часы, и человек за это время мог
 * заплатить. Реестр настроек необязателен — без него доступ считается
 * открытым, как и раньше: так собраны проверки, писавшиеся до ревизии.
 */
async function mayDumpNow(
  deps: { readonly db: Database; readonly settings?: SettingsRegistry | undefined },
  userId: string,
  now: Date,
): Promise<boolean> {
  if (deps.settings === undefined) return true;

  const access = await accessOf(deps.db, { userId, settings: deps.settings, now });

  return access.allowed;
}

/** Кнопка оплаты рядом с приглашением заплатить. */
function payButtons(texts: TextProfile): readonly { label: string; action: string }[] {
  return [{ label: texts.menu.buttonSubscription, action: 'pay:open' }];
}

async function composeOne(
  deps: SchedulerDeps,
  reminder: Reminder,
  texts: TextProfile,
  now: Date,
  timeZone: string,
): Promise<ComposedReminder | SkipReason> {
  switch (reminder.kind) {
    case 'morning': {
      const context = await outputContextOf(deps.db, reminder.userId);
      const today = selectForToday(await openItemsFor(deps.db, reminder.userId), {
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

      /**
       * Приглашение выгружать — только тому, кого бот пустит.
       *
       * Ревизия четвёртого этапа: «наговори, разложу» уходило каждое
       * утро и тому, кому бот в ответ откажет. Приглашение, которое бот
       * сам не исполнит, хуже молчания: оно повторяется ежедневно.
       *
       * Дела на сегодня остаются: §14 велит держать бэклог доступным на
       * чтение, и напоминание о делах — чтение.
       */
      const mayDump = await mayDumpNow(deps, reminder.userId, now);

      return {
        text: morningText(
          texts,
          today.filter((item) => !covered.has(item.id)),
          { now, timeZone: context.timeZone },
          mayDump,
        ),
        buttons: mayDump ? [] : payButtons(texts),
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

      const mayDump = await mayDumpNow(deps, reminder.userId, now);

      if (found === undefined) {
        return {
          text: eveningText(texts, closed, undefined, mayDump),
          buttons: mayDump ? [] : payButtons(texts),
        };
      }

      return {
        text: eveningText(
          texts,
          closed,
          texts.resolver.noticed(
            found.title,
            datesInWords(found.dates, context.timeZone),
            rhythmInWords(found.rhythm),
          ),
          mayDump,
        ),
        buttons: suggestButtons(found.suggestionId, texts),
      };
    }

    case 'deadline_eve':
    case 'deadline_day': {
      const item = await openItem(deps.db, reminder);
      if (!item) return 'gone';

      /**
       * Срок сверяется на отправке (ревизия этапа 3, D1).
       *
       * Между раскладкой и отправкой — до полутора суток, и срок за это
       * время меняется: «не завтра, а в пятницу», «Отложить», «Сделано»
       * у регулярного. Задание же было поставлено про прежний день, и
       * без проверки в 21:00 приходило «Завтра срок» о дне, которого у
       * записи больше нет. Ключ считается той же функцией, что при
       * раскладке; неточный срок напоминаний не даёт вовсе.
       */
      const current =
        item.deadlineAt !== null && item.deadlineAccuracy === 'day'
          ? deadlineKey(reminder.kind, item.id, item.deadlineAt, timeZone)
          : undefined;
      if (current !== reminder.dedupeKey) return 'stale';

      return {
        text: deadlineText(texts, { item, onDay: reminder.kind === 'deadline_day' }),
        buttons: deadlineButtons(item.id, texts),
      };
    }

    case 'project': {
      const item = await openItem(deps.db, reminder);
      if (!item) return 'gone';

      const [step] = await deps.db
        .select()
        .from(projectSteps)
        .where(and(eq(projectSteps.itemId, item.id), isNull(projectSteps.doneAt)))
        .orderBy(asc(projectSteps.position))
        .limit(1);

      if (!step) return 'gone';

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
    .where(and(eq(items.id, reminder.itemId), openItemsWhere(reminder.userId)))
    .limit(1);

  return item;
}

/**
 * Сколько дел сделано за сегодняшний местный день.
 *
 * По дате выполнения, а не по статусу (ревизия этапа 3, C9): у
 * регулярного дела «сделано» двигает срок и запись не закрывает, но
 * `completed_at` у него — когда его сделали в последний раз. Иначе
 * «оплатила садик» днём вечером оборачивалось «День закончился».
 * Убранное дату выполнения теряет (`patch.ts`), так что здесь не
 * считается.
 */
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
        isNotNull(items.completedAt),
        sql`${items.completedAt} >= ${from}`,
      ),
    );

  return row?.count ?? 0;
}

/**
 * Отложенное, чей день настал, снова в работе (ревизия этапа 3, C1).
 *
 * «Отложить» прячет дело до срока, к которому его отложили; с этого
 * дня оно возвращается — в выдачу его пускает фильтр сам, по сроку, а
 * статус поднимает этот шаг, чтобы карточка и списки не звали «отложено»
 * то, что уже просрочено. Бессрочное отложенное будить не до чего —
 * оно просыпается сразу. Ревизии здесь нет: это не решение человека, а
 * наступившее время.
 *
 * Возвращает число разбуженных — для журнала прохода.
 */
export async function wakeSnoozed(db: Database, now: Date): Promise<number> {
  const woken = await db
    .update(items)
    .set({ status: 'active', updatedAt: now })
    .where(
      and(
        eq(items.status, 'snoozed'),
        or(isNull(items.deadlineAt), sql`${items.deadlineAt} <= ${now}`),
      ),
    )
    .returning({ id: items.id });

  return woken.length;
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
): Promise<{ readonly planned: number; readonly sent: number; readonly woken: number }> {
  const now = params.now ?? new Date();

  // Сперва разбудить: разложенное в этом же проходе видит уже «в работе».
  const woken = await wakeSnoozed(deps.db, now);

  return {
    planned: await planReminders(deps, { now }),
    sent: await dispatchReminders(deps, { now }),
    woken,
  };
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
export function startScheduler(
  deps: SchedulerDeps,
  intervalMs: number = TICK_MS,
): () => Promise<void> {
  /**
   * Идущий проход — чтобы остановка его дождалась (ревизия этапа 3, D7).
   *
   * Выкладка в 08:30, когда уходят утренние: сообщение отправлено, а
   * пометить его в базе процесс не успел — базу закрыли. После
   * перезапуска «Доброе утро» уходило второй раз. §21 п.11 требует «без
   * дублей», поэтому стоп возвращается, когда проход завершён; проход
   * короткий — двадцать отправок с шагом в сто двадцать миллисекунд.
   */
  let inFlight: Promise<void> | null = null;

  const timer = setInterval(() => {
    if (inFlight !== null) return;

    inFlight = runScheduler(deps)
      .then((outcome) => {
        if (outcome.planned > 0 || outcome.sent > 0 || outcome.woken > 0) {
          deps.logger.info(outcome, 'Проход планировщика');
        }
      })
      .catch((error: unknown) => {
        deps.logger.error({ err: error }, 'Проход планировщика не удался');
      })
      .finally(() => {
        inFlight = null;
      });
  }, intervalMs);

  timer.unref();

  return async () => {
    clearInterval(timer);
    if (inFlight !== null) await inFlight;
  };
}
