import { and, asc, eq } from 'drizzle-orm';

import { topics, type Topic } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';

/**
 * Темы человека (§6.4 ТЗ).
 *
 * Базовый набор задан §6.4 прямо: семья, здоровье, работа, покупки,
 * личное. До онбординга (2.13) действует он — иначе классификация не
 * работает вовсе, а первая выгрузка §12.2 приходит раньше любых вопросов.
 *
 * Тема по умолчанию нужна той же §6.4: запись, не попавшая ни в одну
 * тему, уходит туда, а бот при удобном случае предложит создать новую.
 * Автоматически создавать темы запрещено — это плодит хаос, который
 * продукт должен убирать.
 */

export const DEFAULT_TOPIC_NAMES = ['семья', 'здоровье', 'работа', 'покупки', 'личное'] as const;

/** §6.4: куда уходит запись, не попавшая ни в одну тему. */
export const FALLBACK_TOPIC = 'личное';

export interface TopicList {
  readonly names: readonly string[];
  readonly defaultName: string;
  /** Темы человека уже созданы онбордингом, а не взяты из базового набора. */
  readonly own: boolean;
}

export async function listTopics(db: Executor, userId: string): Promise<Topic[]> {
  return await db
    .select()
    .from(topics)
    .where(and(eq(topics.userId, userId), eq(topics.isArchived, false)))
    .orderBy(asc(topics.sortOrder), asc(topics.name));
}

/**
 * Список названий для классификации.
 *
 * Пока онбординг не прошёл, возвращается базовый набор §6.4. Это не
 * заглушка: §12.2 требует, чтобы первая выгрузка случилась до любых
 * вопросов, значит первый разбор обязан работать без ответов человека.
 */
export async function topicsFor(db: Executor, userId: string): Promise<TopicList> {
  const rows = await listTopics(db, userId);

  if (rows.length === 0) {
    return { names: [...DEFAULT_TOPIC_NAMES], defaultName: FALLBACK_TOPIC, own: false };
  }

  const names = rows.map((row) => row.name);
  const marked = rows.find((row) => row.isDefault)?.name;

  return {
    names,
    // Если тему по умолчанию никто не отметил, берём первую: запись без
    // темы не проходит проверку целостности и потерялась бы совсем.
    defaultName: marked ?? names[0] ?? FALLBACK_TOPIC,
    own: true,
  };
}

export interface TopicToCreate {
  readonly name: string;
  readonly emoji?: string | undefined;
  readonly isDefault?: boolean | undefined;
}

/**
 * Создаёт темы человека. Идемпотентно: повторный онбординг не задваивает
 * список, а уникальный индекс по паре пользователь–название страхует от
 * гонки двух обработчиков.
 */
export async function createTopics(
  db: Executor,
  userId: string,
  wanted: readonly TopicToCreate[],
): Promise<number> {
  if (wanted.length === 0) return 0;

  const rows = await db
    .insert(topics)
    .values(
      wanted.map((topic, index) => ({
        userId,
        name: topic.name,
        emoji: topic.emoji ?? null,
        sortOrder: index,
        isDefault: topic.isDefault ?? false,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: topics.id });

  return rows.length;
}
