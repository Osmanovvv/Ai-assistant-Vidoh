import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Executor } from '../../infra/db.js';
import { userSettings, users, type User } from '../../db/schema.js';

export interface UpsertUserInput {
  readonly tgId: number;
  readonly username?: string | null;
  readonly firstName?: string | null;
  readonly languageCode?: string | null;
  /** §14 ТЗ: пишется только при первом запуске и дальше не перетирается. */
  readonly referralSource?: string | null;
}

/**
 * Идемпотентная регистрация пользователя (задача 1.9).
 *
 * Повторный /start обновляет имя и активность, но не сбрасывает источник
 * перехода и согласие на обработку данных: эти два поля описывают то, что
 * уже произошло однажды.
 */
export async function upsertUser(db: Executor, input: UpsertUserInput): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({
      tgId: input.tgId,
      username: input.username ?? null,
      firstName: input.firstName ?? null,
      languageCode: input.languageCode ?? null,
      referralSource: input.referralSource ?? null,
    })
    .onConflictDoUpdate({
      target: users.tgId,
      set: {
        username: input.username ?? null,
        firstName: input.firstName ?? null,
        languageCode: input.languageCode ?? null,
        lastActiveAt: sql`now()`,
        // Пользователь снова пишет — значит бот разблокирован.
        isBlocked: false,
        blockedAt: null,
        // COALESCE: источник проставляется, только если его ещё не было.
        referralSource: sql`coalesce(${users.referralSource}, ${input.referralSource ?? null})`,
      },
    })
    .returning();

  if (!user) {
    throw new Error('upsertUser не вернул строку');
  }

  await db.insert(userSettings).values({ userId: user.id }).onConflictDoNothing();

  return user;
}

/** Пользователь заблокировал бота: планировщик обязан его пропускать. */
export async function markBlocked(db: Executor, tgId: number): Promise<void> {
  await db
    .update(users)
    .set({ isBlocked: true, blockedAt: sql`now()` })
    .where(eq(users.tgId, tgId));
}

/** §16 ТЗ: факт согласия на обработку данных. */
export async function recordConsent(db: Executor, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ consentAt: sql`now()` })
    .where(eq(users.id, userId));
}

/**
 * Фиксирует согласие, если его ещё не было (§16 ТЗ).
 *
 * Согласием считается первое сообщение после экрана первого запуска, где
 * показана ссылка на политику. Отметка ставится один раз: повторные
 * сообщения не должны сдвигать дату, иначе непонятно, когда человек
 * согласился на самом деле.
 */
export async function recordConsentIfAbsent(db: Executor, userId: string): Promise<boolean> {
  const updated = await db
    .update(users)
    .set({ consentAt: sql`now()` })
    .where(and(eq(users.id, userId), isNull(users.consentAt)))
    .returning({ id: users.id });

  return updated.length > 0;
}

/**
 * Пользователи, которым можно писать. Планировщик берёт адресатов только
 * отсюда: отправка заблокировавшему вернёт 403 и засорит журнал ошибок.
 */
export async function activeUserIds(db: Executor): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isBlocked, false))
    .orderBy(users.createdAt);

  return rows.map((row) => row.id);
}

export async function findByTgId(db: Executor, tgId: number): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.tgId, tgId)).limit(1);
  return user;
}
