import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { SETTINGS } from '../settings/settings.repo.js';

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

  /**
   * Свои темы — и следом базовые имена, которых у человека ещё нет
   * (16.09.2026). Сферы заводятся только под записи, и после первой
   * выгрузки у человека может быть одна тема; без ориентира модель
   * клала бы «купить продукты» в «здоровье» или в общую. Названная
   * базовая сфера заведётся вместе с записью (`ensure.ts`).
   */
  const own = rows.map((row) => row.name);
  const taken = new Set(own.map((name) => normalizeTopicName(name)));
  const names = [...own, ...DEFAULT_TOPIC_NAMES.filter((name) => !taken.has(name))];
  const marked = rows.find((row) => row.isDefault)?.name;

  return {
    names,
    // Тему по умолчанию никто не отметил — «личное»: оно заводится под
    // запись и сверх предела, а запись без темы потерялась бы совсем.
    defaultName: marked ?? FALLBACK_TOPIC,
    own: true,
  };
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
 * Здесь только **умолчание**: действующее число приходит параметром из
 * реестра настроек, и оба пути создания тем его принимают. Константа
 * остаётся на случай, когда реестра нет вовсе, — так собран, например,
 * стенд проверок.
 *
 * Восемь — не круглое число ради красоты: столько ветвей человек ещё
 * различает в списке чата, а дальше структура сама становится тем
 * хаосом, который продукт должен убирать.
 */
export const MAX_TOPICS = SETTINGS.maxTopics.fallback;

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
  /**
   * Предел числа тем — из настроек (§15, ревизия четвёртого этапа).
   *
   * Настройка «Сколько тем» была объявлена в панели и **не читалась
   * никем**: предел оставался константой в коде. Человек менял число,
   * видел «Сохранено» и ждал, что что-то изменится, — а не менялось
   * ничего. Настройка, которую никто не читает, хуже отсутствующей.
   *
   * Параметром, а не чтением реестра внутри: это запись в базу, и
   * второй читатель настроек мимо реестра разошёлся бы с первым на
   * разборе мусора и на умолчании.
   */
  maxTopics?: number,
): Promise<AppendResult> {
  const existing = await listTopics(db, userId);
  const taken = new Set(existing.map((topic) => normalizeTopicName(topic.name)));

  const fresh = names.filter((name) => !taken.has(normalizeTopicName(name)));
  if (fresh.length === 0) return { added: [], limited: false };

  const room = Math.max(0, (maxTopics ?? MAX_TOPICS) - existing.length);
  const allowed = fresh.slice(0, room);

  if (allowed.length === 0) return { added: [], limited: true };

  const nextOrder = existing.reduce((max, topic) => Math.max(max, topic.sortOrder), -1) + 1;

  /**
   * Архивная тема с тем же именем **возвращается**, а не создаётся заново
   * (задача 3.43).
   *
   * Иначе круг не замыкался: сфера, не выбранная на онбординге, уходит в
   * архив, бот тут же предлагает её создать (§6.4), человек соглашается —
   * а вставка упирается в уникальность имени и молча ничего не делает.
   * Ветки у архивной темы уже нет, сводка создаст новую при надобности.
   */
  const archived = await db
    .select({ id: topics.id, name: topics.name })
    .from(topics)
    .where(and(eq(topics.userId, userId), eq(topics.isArchived, true)));

  const revivable = new Map(archived.map((topic) => [normalizeTopicName(topic.name), topic]));
  const added: string[] = [];
  let order = nextOrder;

  for (const name of allowed) {
    const dormant = revivable.get(normalizeTopicName(name));

    if (dormant) {
      await db
        .update(topics)
        .set({ isArchived: false, sortOrder: order })
        .where(eq(topics.id, dormant.id));
      added.push(dormant.name);
      order++;
      continue;
    }

    const rows = await db
      .insert(topics)
      .values({ userId, name, sortOrder: order })
      .onConflictDoNothing()
      .returning({ name: topics.name });

    for (const row of rows) added.push(row.name);
    order++;
  }

  return { added, limited: allowed.length < fresh.length };
}

export interface EnsureResult {
  /** Названия (нормализованные), у которых теперь есть тема. */
  readonly present: ReadonlySet<string>;
  readonly created: readonly string[];
}

/**
 * Сферы под записи (заказчица, 16.09.2026): заводит только названные
 * темы, которых ещё нет, — в порядке названия и под пределом из настроек.
 *
 * Тема по умолчанию (`FALLBACK_TOPIC`) заводится и сверх предела: на ней
 * §6.4 держит всё, что не попало ни в одну сферу, — без неё записи негде
 * лежать. Выключенная человеком (архивная) сфера не возвращается — как в
 * `adopt.ts`, запись такой сферы уходит в общую.
 *
 * Записи, сохранённые раньше своей темы (боевые данные до 29.08.2026),
 * подбираются тем же `linkOrphanItems`, что и прежде.
 */
export async function ensureTopics(
  db: Executor,
  userId: string,
  names: readonly string[],
  maxTopics?: number,
): Promise<EnsureResult> {
  const all = await db.select().from(topics).where(eq(topics.userId, userId));
  const present = new Set(
    all.filter((row) => !row.isArchived).map((row) => normalizeTopicName(row.name)),
  );
  const archived = new Set(
    all.filter((row) => row.isArchived).map((row) => normalizeTopicName(row.name)),
  );

  const missing = [
    ...new Map(names.map((name) => [normalizeTopicName(name), name.trim()])).values(),
  ].filter((name) => {
    const key = normalizeTopicName(name);
    return !present.has(key) && !archived.has(key);
  });

  if (missing.length === 0) return { present, created: [] };

  const fallback = missing.find((name) => normalizeTopicName(name) === FALLBACK_TOPIC);
  const ordinary = missing.filter((name) => name !== fallback);

  const created: string[] = [];
  if (ordinary.length > 0) {
    const { added } = await appendTopics(db, userId, ordinary, maxTopics);
    created.push(...added);
  }

  if (fallback !== undefined) {
    const others = await listTopics(db, userId);
    const order = others.reduce((max, topic) => Math.max(max, topic.sortOrder), -1) + 1;
    const rows = await db
      .insert(topics)
      .values({
        userId,
        name: FALLBACK_TOPIC,
        sortOrder: order,
        isDefault: !others.some((topic) => topic.isDefault),
      })
      .onConflictDoNothing()
      .returning({ name: topics.name });
    created.push(...rows.map((row) => row.name));
  }

  if (created.length > 0) {
    const rows = await db
      .select({ id: topics.id, name: topics.name })
      .from(topics)
      .where(and(eq(topics.userId, userId), inArray(topics.name, created)));
    await linkOrphanItems(db, userId, rows);
  }

  for (const name of created) present.add(normalizeTopicName(name));
  return { present, created };
}
