import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { items, topics, type Topic } from '../../db/schema.js';
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

/**
 * Сравнение названий тем: регистр не важен, «ё» равна «е».
 *
 * Правило одно на весь проект. Копий было три — в классификации, в
 * службе тем и в сохранении записей, — и разойтись им ничто не мешало:
 * тема «Здоровье» и тема «здоровье» стали бы разными.
 */
export function normalizeTopicName(name: string): string {
  return name.trim().toLowerCase().replace(/ё/gu, 'е');
}

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
    .returning({ id: topics.id, name: topics.name });

  await linkOrphanItems(db, userId, rows);

  return rows.length;
}

/**
 * Записи, сохранённые до того, как у человека появились темы.
 *
 * §12.2 ТЗ ставит онбординг **после** первой выгрузки, а темы создаёт его
 * ответами. Значит первая выгрузка любого человека сохраняется, когда тем
 * ещё нет: искать название не в чем, и ссылка остаётся пустой. Без этого
 * шага — навсегда, а ТЗ держит тему записи именно ссылкой; название рядом
 * стоит кэшем и в составе `items` у ТЗ его нет вовсе.
 *
 * Найдено 29.08.2026 на боевых данных: 37 записей из 38 без ссылки, все из
 * первой выгрузки. Случай не краевой, а гарантированный самим порядком —
 * и приходится он на самую большую выгрузку, ту, ради которой человек
 * пришёл.
 *
 * **Сравнение считается здесь, а не запросом.** В базе локаль `C`, и
 * `lower()` кириллицу не трогает: `lower('Здоровье')` возвращает
 * «Здоровье». Правило нормализации в проекте одно — normalizeTopicName, —
 * и держать его вторую, молча иначе работающую копию на стороне базы
 * значило бы вернуть ту самую беду, ради которой правило и собрали в одном
 * месте.
 *
 * Название приводится к тому, как тему назвал человек: два поля обязаны
 * совпадать, иначе запись окажется в одной теме по ссылке и в другой по
 * названию.
 */
async function linkOrphanItems(
  db: Executor,
  userId: string,
  created: readonly { readonly id: string; readonly name: string }[],
): Promise<void> {
  if (created.length === 0) return;

  const byName = new Map(created.map((topic) => [normalizeTopicName(topic.name), topic]));

  const orphans = await db
    .select({ id: items.id, topic: items.topic })
    .from(items)
    .where(and(eq(items.userId, userId), isNull(items.topicId)));

  /** Записи одной темы правятся одним запросом: тем немного, записей много. */
  const byTopic = new Map<string, string[]>();

  for (const orphan of orphans) {
    // У черновика темы нет вовсе (§17): приписать её по пустому названию
    // значило бы выдать догадку за разбор.
    if (orphan.topic === null) continue;

    const target = byName.get(normalizeTopicName(orphan.topic));
    // Названия, которого человек не выбрал, среди тем нет. Выдумывать тему
    // запрещает §6.4, а название записи при этом остаётся на месте.
    if (target === undefined) continue;

    byTopic.set(target.id, [...(byTopic.get(target.id) ?? []), orphan.id]);
  }

  for (const [topicId, ids] of byTopic) {
    const name = created.find((topic) => topic.id === topicId)?.name;
    if (name === undefined) continue;

    await db.update(items).set({ topicId, topic: name }).where(inArray(items.id, ids));
  }
}
/**
 * Предел числа тем (§6.4: «количество тем ограничено, значение задаётся
 * в настройках»).
 *
 * Пока константой: настройки продукта появятся в админке на четвёртом
 * этапе, и тогда значение переедет туда. Восемь — не круглое число ради
 * красоты: столько ветвей человек ещё различает в списке чата, а дальше
 * структура сама становится тем хаосом, который продукт должен убирать.
 */
export const MAX_TOPICS = 8;

export interface AppendResult {
  readonly added: readonly string[];
  /** Часть сфер не добавлена: упёрлись в предел. */
  readonly limited: boolean;
}

/**
 * Добавляет сферы к уже существующим (§6.4).
 *
 * Отдельно от `createTopics` из-за порядка: тот раскладывает список с
 * нуля и годится только для онбординга. Здесь темы **дописываются** в
 * конец, иначе новая сфера встала бы первой и перетасовала бы человеку
 * весь список без его просьбы.
 *
 * Уже существующие имена молча пропускаются: повторное «добавить
 * покупки» не должно ни падать, ни плодить двойников.
 */
export async function appendTopics(
  db: Executor,
  userId: string,
  names: readonly string[],
): Promise<AppendResult> {
  const existing = await listTopics(db, userId);
  const taken = new Set(existing.map((topic) => topic.name.toLowerCase()));

  const fresh = names.filter((name) => !taken.has(name.toLowerCase()));
  if (fresh.length === 0) return { added: [], limited: false };

  const room = Math.max(0, MAX_TOPICS - existing.length);
  const allowed = fresh.slice(0, room);

  if (allowed.length === 0) return { added: [], limited: true };

  const nextOrder = existing.reduce((max, topic) => Math.max(max, topic.sortOrder), -1) + 1;

  const rows = await db
    .insert(topics)
    .values(
      allowed.map((name, index) => ({
        userId,
        name,
        sortOrder: nextOrder + index,
      })),
    )
    .onConflictDoNothing()
    .returning({ name: topics.name });

  return { added: rows.map((row) => row.name), limited: allowed.length < fresh.length };
}
