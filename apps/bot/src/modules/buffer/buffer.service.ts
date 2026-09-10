import { and, asc, eq, gte, sql } from 'drizzle-orm';
import { SETTINGS } from '../settings/settings.repo.js';

import type { Database, Executor } from '../../infra/db.js';
import { batches, messagesRaw, type Batch } from '../../db/schema.js';

/**
 * Буфер выгрузки и окно тишины (задачи 1.12 и 1.13).
 *
 * §9.1 правило 2 ТЗ: серия сообщений — это одна мысль. Сообщения копятся
 * в открытую выгрузку, каждое новое перезапускает ожидание тишины.
 * Несколько голосовых подряд дают один разбор и один ответ.
 */

export interface BufferLimits {
  /** Сколько молчать, прежде чем считать выгрузку законченной. */
  readonly silenceWindowMs: number;
  /** Жёсткий потолок: выгрузка не может быть открыта вечно. */
  readonly maxBatchAgeMs: number;
  /**
   * Сколько обработка вправе идти, прежде чем считать её умершей.
   *
   * Живой разбор занимает около минуты: маршрутизатор, извлечение,
   * классификация, ответ. Досмотр, который возвращает в очередь **любую**
   * выгрузку в обработке, ловил и живую (боевое 04.09.2026, 18:25:31 —
   * ровно посреди разбора). Потолок отделяет застрявшую от идущей.
   */
  readonly maxProcessingMs: number;
  readonly maxMessagesPerBatch: number;
  /** §10.5 ТЗ: ограничение частоты выгрузок на пользователя. */
  readonly maxDumpsPerDay: number;
}

/**
 * Умолчания буфера.
 *
 * **Два значения берутся из таблицы настроек, а не набраны здесь заново**
 * (ревизия четвёртого этапа). Прежде одно и то же число было записано
 * дважды — в `SETTINGS.fallback` и здесь — и ничем не связано: столбец
 * «По умолчанию» в панели разошёлся бы с поведением от любой правки
 * одного из двух мест, и заметить это было бы нечем.
 *
 * Остальные три настройкой не объявлены (§15 их не просит) и живут
 * здесь: у них нет второго экземпляра, значит и расходиться нечему.
 */
export const DEFAULT_LIMITS: BufferLimits = {
  silenceWindowMs: SETTINGS.silenceWindowMs.fallback,
  maxBatchAgeMs: 5 * 60_000,
  // Втрое дольше обычного разбора и короче потолка открытой выгрузки.
  maxProcessingMs: 3 * 60_000,
  maxMessagesPerBatch: 15,
  maxDumpsPerDay: SETTINGS.dumpsPerDay.fallback,
};

export type CloseReason = 'silence' | 'message_limit' | 'age_limit';

export interface AttachResult {
  readonly batchId: string;
  /** Выгрузка закрыта прямо сейчас и готова к обработке. */
  readonly closed: boolean;
  readonly closeReason?: CloseReason;
  readonly messageCount: number;
}

/** Открытая выгрузка пользователя или новая, если открытой нет. */
async function openBatchFor(tx: Executor, userId: string, now: Date): Promise<Batch> {
  // Частичный уникальный индекс не даёт создать вторую открытую выгрузку,
  // поэтому гонка двух воркеров разрешается базой: проигравший увидит
  // конфликт и прочитает уже созданную выгрузку.
  const [created] = await tx
    .insert(batches)
    .values({ userId, openedAt: now, lastMessageAt: now })
    .onConflictDoNothing({
      target: batches.userId,
      // Предикат частичного индекса: без него Postgres не поймёт,
      // с каким именно уникальным ограничением сверять конфликт.
      where: sql`${batches.status} = 'open'`,
    })
    .returning();

  if (created) return created;

  const [existing] = await tx
    .select()
    .from(batches)
    .where(and(eq(batches.userId, userId), eq(batches.status, 'open')))
    .limit(1);

  if (!existing) {
    throw new Error('Открытая выгрузка не найдена после конфликта вставки');
  }

  return existing;
}

/**
 * Присоединяет сообщение к открытой выгрузке. Закрывает её, если достигнут
 * потолок по числу сообщений или по возрасту.
 */
export async function attachMessageToBatch(
  db: Database,
  params: {
    readonly userId: string;
    readonly messageId: string;
    readonly now?: Date;
    readonly limits?: BufferLimits;
  },
): Promise<AttachResult> {
  const limits = params.limits ?? DEFAULT_LIMITS;
  const now = params.now ?? new Date();

  return await db.transaction(async (tx): Promise<AttachResult> => {
    const batch = await openBatchFor(tx, params.userId, now);

    await tx
      .update(messagesRaw)
      .set({ batchId: batch.id })
      .where(eq(messagesRaw.id, params.messageId));

    const messageCount = batch.messageCount + 1;
    const ageMs = now.getTime() - batch.openedAt.getTime();

    const closeReason: CloseReason | undefined =
      messageCount >= limits.maxMessagesPerBatch
        ? 'message_limit'
        : ageMs >= limits.maxBatchAgeMs
          ? 'age_limit'
          : undefined;

    await tx
      .update(batches)
      .set({
        messageCount,
        lastMessageAt: now,
        ...(closeReason ? { status: 'queued' as const, closedAt: now } : {}),
      })
      .where(eq(batches.id, batch.id));

    return {
      batchId: batch.id,
      closed: closeReason !== undefined,
      ...(closeReason ? { closeReason } : {}),
      messageCount,
    };
  });
}

/**
 * Граница тишины: раньше неё сказанное считается давним.
 *
 * Одной функцией на всех, потому что порог считают двое — закрытие по
 * тишине и восстановление после перезапуска, — и разъехались бы они
 * молча. Правило проекта: одно число не считается двумя способами.
 */
export function silenceThreshold(now: Date, windowMs: number): Date {
  return new Date(now.getTime() - windowMs);
}

/**
 * Чем кончился заход закрытия по тишине.
 *
 * **Три случая, а не два.** Прежде функция отдавала `false` и когда
 * человек ещё говорит, и когда выгрузку закрыли без нас — потолком
 * сообщений или возраста в `attachMessageToBatch`, досмотром, соседним
 * заходом. Задание закрытия переставляло себя на любой `false`; почини
 * одну переставку, не разведя эти два случая — и на каждой выгрузке,
 * закрытой потолком, останется задание, которое ставит себя заново
 * каждое окно тишины и не кончается никогда.
 */
export type SilenceCloseResult =
  /** Закрыли: тишина выдержана. */
  | { readonly closed: true }
  /** Выгрузка уже не открыта. Ставить закрытие заново нечему и незачем. */
  | { readonly closed: false; readonly reason: 'not_open' }
  /** Человек ещё говорит: до конца окна осталось `retryInMs`. */
  | { readonly closed: false; readonly reason: 'still_talking'; readonly retryInMs: number };

/**
 * Закрывает выгрузку по тишине. Вызывается отложенным заданием.
 *
 * Проверка «последнее сообщение было давно» обязательна: задание могло
 * быть поставлено до того, как пришло очередное сообщение. Без неё
 * выгрузка закрылась бы посреди речи.
 *
 * Порог считается один раз и живёт в одной переменной: условие UPDATE
 * (`lastMessageAt <= threshold`) и остаток (`lastMessageAt - threshold`)
 * — одно и то же неравенство с двух сторон, и разойтись им негде.
 */
export async function closeBatchOnSilence(
  db: Executor,
  batchId: string,
  params: { readonly now?: Date; readonly silenceWindowMs?: number } = {},
): Promise<SilenceCloseResult> {
  const now = params.now ?? new Date();
  const windowMs = params.silenceWindowMs ?? DEFAULT_LIMITS.silenceWindowMs;
  const threshold = silenceThreshold(now, windowMs);

  const closed = await db
    .update(batches)
    .set({ status: 'queued', closedAt: now })
    .where(
      and(
        eq(batches.id, batchId),
        eq(batches.status, 'open'),
        sql`${batches.lastMessageAt} <= ${threshold}`,
      ),
    )
    .returning({ id: batches.id });

  if (closed.length > 0) return { closed: true };

  /**
   * Не закрыли — надо сказать почему, и отдельным запросом: UPDATE
   * возвращает только подошедшие строки, а нам нужна причина
   * неподошедшей. Молчание здесь стоило выгрузке лишней минуты у
   * досмотра, а журналу — ложного обвинения очереди.
   */
  const [state] = await db
    .select({ status: batches.status, lastMessageAt: batches.lastMessageAt })
    .from(batches)
    .where(eq(batches.id, batchId))
    .limit(1);

  // Строки может не быть вовсе: данные человека удалены по §16 между
  // постановкой задания и заходом.
  if (state?.status !== 'open') return { closed: false, reason: 'not_open' };

  return {
    closed: false,
    reason: 'still_talking',
    /**
     * Остаток окна, а не окно целиком (ревизия этапа 4, пункт 2.2).
     * Ждать заново полминуты после слова, сказанного секунду назад, —
     * это лишние полминуты молчания бота.
     *
     * Ноль возможен только в гонке: выгрузку тронули между UPDATE и этим
     * запросом. Задание на нулевой задержке просто зайдёт снова, и
     * закроет — `now` идёт вперёд, а `lastMessageAt` назад не ходит.
     */
    retryInMs: Math.max(0, state.lastMessageAt.getTime() - threshold.getTime()),
  };
}

/**
 * Склейка выгрузки (задача 1.13): расшифровки и тексты в порядке получения.
 *
 * Сообщения без содержимого пропускаются: стикер или неразобранное
 * вложение не должны вставлять пустую строку в середину мысли.
 */
export async function combineBatch(db: Executor, batchId: string): Promise<string> {
  const rows = await db
    .select({
      text: messagesRaw.text,
      transcript: messagesRaw.transcript,
    })
    .from(messagesRaw)
    .where(eq(messagesRaw.batchId, batchId))
    .orderBy(asc(messagesRaw.receivedAt), asc(messagesRaw.tgMessageId));

  const parts = rows
    .map((row) => (row.transcript ?? row.text ?? '').trim())
    .filter((part) => part !== '');

  const combined = parts.join('\n');

  await db.update(batches).set({ combinedText: combined }).where(eq(batches.id, batchId));

  return combined;
}

/** §10.5 ТЗ: сколько выгрузок пользователь сделал за последние сутки. */
export async function countRecentDumps(db: Executor, userId: string, since: Date): Promise<number> {
  const rows = await db
    .select({ id: batches.id })
    .from(batches)
    .where(and(eq(batches.userId, userId), gte(batches.openedAt, since)));

  return rows.length;
}

export async function isOverDumpLimit(
  db: Executor,
  userId: string,
  params: { readonly now?: Date; readonly limits?: BufferLimits } = {},
): Promise<boolean> {
  const limits = params.limits ?? DEFAULT_LIMITS;
  const now = params.now ?? new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60_000);

  return (await countRecentDumps(db, userId, since)) >= limits.maxDumpsPerDay;
}
