import { and, asc, desc, eq, gte, isNull, lt, lte, sql } from 'drizzle-orm';

import { messagesRaw, reminders, type Reminder } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { localDayNumber, type PlannedReminder } from './plan.js';
import { localTimeToUtc } from './time.js';
import { localDateParts } from '../classifier/dates.js';

/**
 * Хранение заданий планировщика (задача 3.14).
 *
 * Вся защита от дублей — в одном месте: уникальный индекс по паре
 * «пользователь и ключ» плюс `onConflictDoNothing`. Проверять существование
 * перед вставкой бесполезно: между проверкой и вставкой помещается второй
 * экземпляр процесса, а он у нас будет — планировщик поднимается вместе с
 * ботом, и во время выкладки их на минуту двое.
 */

/** Сколько последних утренних смотрим, считая серию молчания (3.17). */
const STREAK_WINDOW = 20;

/**
 * Ставит задания. Возвращает те, что действительно записались.
 *
 * Пустой ответ при непустом входе — это норма, а не сбой: значит, всё уже
 * было поставлено раньше. Именно так выглядит повторный запуск.
 */
export async function storePlanned(
  db: Executor,
  userId: string,
  planned: readonly PlannedReminder[],
): Promise<Reminder[]> {
  if (planned.length === 0) return [];

  return await db
    .insert(reminders)
    .values(
      planned.map((one) => ({
        userId,
        kind: one.kind,
        dueAt: one.dueAt,
        dedupeKey: one.dedupeKey,
        ...(one.itemId === undefined ? {} : { itemId: one.itemId }),
      })),
    )
    .onConflictDoNothing({ target: [reminders.userId, reminders.dedupeKey] })
    .returning();
}

/**
 * Что пора отправить.
 *
 * Порция ограничена: §11 требует распределять отправку во времени с
 * учётом ограничений Telegram. Планировщик просыпается часто, поэтому
 * остаток уйдёт на следующем проходе, а не потеряется.
 */
export async function duePending(
  db: Executor,
  params: { readonly now: Date; readonly limit: number },
): Promise<Reminder[]> {
  return await db
    .select()
    .from(reminders)
    .where(
      and(
        isNull(reminders.sentAt),
        isNull(reminders.skippedReason),
        lte(reminders.dueAt, params.now),
      ),
    )
    .orderBy(asc(reminders.dueAt))
    .limit(params.limit);
}

/**
 * Снимает ещё не отправленные задания человека.
 *
 * Зовётся при правке настроек напоминаний. Без этого настройка вступала
 * бы в силу не сразу, а по мере устаревания уже поставленных заданий —
 * до полутора суток: горизонт раскладки смотрит вперёд на 36 часов.
 *
 * Живой случай, найденный на приёмке: человек включает режим тишины, а
 * вечернее напоминание, поставленное час назад на 23:00, всё равно
 * приходит. Настройка, которая начинает действовать завтра, читается как
 * сломанная — и справедливо.
 *
 * Отправленные не трогаем: они уже история, и по ним считается серия
 * молчания (3.17). Планировщик восстановит нужные в ближайшую минуту.
 */
export async function dropPending(db: Executor, userId: string): Promise<number> {
  const removed = await db
    .delete(reminders)
    .where(
      and(eq(reminders.userId, userId), isNull(reminders.sentAt), isNull(reminders.skippedReason)),
    )
    .returning({ id: reminders.id });

  return removed.length;
}

/**
 * Записи, у которых сегодня своё напоминание по сроку.
 *
 * Нужны утренней сводке, чтобы не называть одно дело дважды. Напоминание
 * «сегодня срок» встаёт на то же местное утро, что и сводка, — человек
 * получал два сообщения подряд про одну запись: сначала списком, потом
 * отдельно. Отдельное полезнее: у него кнопки «Сделано» и «Перенести».
 */
export async function itemsWithDeadlineReminder(
  db: Executor,
  params: { readonly userId: string; readonly from: Date; readonly to: Date },
): Promise<Set<string>> {
  const rows = await db
    .select({ itemId: reminders.itemId })
    .from(reminders)
    .where(
      and(
        eq(reminders.userId, params.userId),
        eq(reminders.kind, 'deadline_day'),
        isNull(reminders.skippedReason),
        gte(reminders.dueAt, params.from),
        lt(reminders.dueAt, params.to),
      ),
    );

  return new Set(rows.flatMap((row) => (row.itemId === null ? [] : [row.itemId])));
}

export async function markSent(db: Executor, id: string, at: Date): Promise<void> {
  await db.update(reminders).set({ sentAt: at }).where(eq(reminders.id, id));
}

/**
 * Записывает сорвавшуюся попытку и возвращает их общее число.
 *
 * Задание остаётся неотправленным: следующий проход возьмёт его снова.
 * Так §5 ТЗ и задумывал колонку `attempts` — не ради статистики, а чтобы
 * повтор был конечным.
 */
export async function countAttempt(db: Executor, id: string): Promise<number> {
  const [row] = await db
    .update(reminders)
    .set({ attempts: sql`${reminders.attempts} + 1` })
    .where(eq(reminders.id, id))
    .returning({ attempts: reminders.attempts });

  return row?.attempts ?? 0;
}

export async function markSkipped(db: Executor, id: string, reason: string): Promise<void> {
  await db.update(reminders).set({ skippedReason: reason }).where(eq(reminders.id, id));
}

/**
 * Местная дата последнего отправленного утреннего, числом.
 *
 * Из неё считается «через день» и «раз в неделю» (3.17).
 */
export async function lastMorningDay(
  db: Executor,
  params: { readonly userId: string; readonly timeZone: string },
): Promise<number | undefined> {
  const [last] = await db
    .select({ sentAt: reminders.sentAt })
    .from(reminders)
    .where(
      and(
        eq(reminders.userId, params.userId),
        eq(reminders.kind, 'morning'),
        sql`${reminders.sentAt} is not null`,
      ),
    )
    .orderBy(desc(reminders.sentAt))
    .limit(1);

  return last?.sentAt === undefined || last.sentAt === null
    ? undefined
    : localDayNumber(last.sentAt, params.timeZone);
}

/**
 * Сколько утренних подряд осталось без реакции (§11, задача 3.17).
 *
 * «Реакция засчитывается при любом сообщении в тот день» — буквально в
 * тот местный день, а не «после напоминания». Человек, написавший утром
 * до восьми тридцати и замолчавший, всё равно в разговоре, и снижать ему
 * частоту не за что.
 *
 * Серия считается по истории, а не хранится счётчиком: считанное число
 * не может разъехаться с фактами, а обнулённое — может, если кто-то
 * забудет обнулить.
 */
export async function ignoredStreak(
  db: Executor,
  params: { readonly userId: string; readonly timeZone: string },
): Promise<number> {
  const sent = await db
    .select({ sentAt: reminders.sentAt })
    .from(reminders)
    .where(
      and(
        eq(reminders.userId, params.userId),
        eq(reminders.kind, 'morning'),
        sql`${reminders.sentAt} is not null`,
      ),
    )
    .orderBy(desc(reminders.sentAt))
    .limit(STREAK_WINDOW);

  let streak = 0;
  for (const one of sent) {
    if (one.sentAt === null) continue;
    if (await spokeOnDay(db, params.userId, one.sentAt, params.timeZone)) break;
    streak += 1;
  }

  return streak;
}

/** Писал ли человек хоть что-нибудь в этот местный день. */
async function spokeOnDay(
  db: Executor,
  userId: string,
  day: Date,
  timeZone: string,
): Promise<boolean> {
  const parts = localDateParts(day, timeZone);
  const from = localTimeToUtc(parts, '00:00', timeZone);
  const to = new Date(from.getTime() + 24 * 60 * 60_000);

  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(messagesRaw)
    .where(
      and(
        eq(messagesRaw.userId, userId),
        gte(messagesRaw.receivedAt, from),
        lt(messagesRaw.receivedAt, to),
      ),
    )
    .limit(1);

  return row !== undefined;
}
