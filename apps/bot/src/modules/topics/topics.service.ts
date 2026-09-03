import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import { items, topics, type Topic } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import {
  isThreadGone,
  isTopicsUnavailable,
  retryAfterSeconds,
  type TopicGateway,
} from './gateway.js';
import { listTopics, normalizeTopicName } from './topics.repo.js';

/**
 * Ветки личного чата (задача 2.15).
 *
 * §8 ТЗ: на каждую сферу жизни своя ветка. Проба 0.3 подтвердила, что в
 * личном чате это работает — включая создание, переименование, отправку
 * в ветку и закрепление.
 *
 * **Идентификатор ветки наружу не показывается** (§8.2). Он живёт в
 * `topics.tg_thread_id` и нигде больше: ни в тексте реплик, ни в
 * `callback_data`, ни в выгрузке данных.
 *
 * **Ветка создаётся по надобности, а не отдельным обходом.** Единственное
 * место, где ветка нужна, — обновление сводки темы (2.16), и создание
 * встроено туда. Отдельная функция «создать все ветки» была бы вторым
 * путём к тому же результату, а два пути к одному результату однажды
 * расходятся. Пересоздание после удаления человеком идёт тем же путём.
 *
 * **Пропавшая ветка не считается ошибкой.** Человек вправе удалить ветку
 * руками (§17), и продукт обязан это пережить: тема остаётся, записи
 * остаются, ветка пересоздаётся, когда в неё снова понадобится написать.
 */

/**
 * Соответствие «сфера жизни → эмодзи».
 *
 * Эмодзи, а не идентификатор иконки: набор Telegram задан платформой и
 * может смениться, а символ останется символом. Идентификатор ищется по
 * нему в наборе, который отдаёт API (проба 0.3: 112 допустимых иконок).
 *
 * §12.4 ТЗ: эмодзи как маркер, не как украшение.
 */
const TOPIC_ICONS: Readonly<Record<string, string>> = {
  семья: '👨‍👩‍👧',
  здоровье: '💊',
  работа: '💼',
  покупки: '🛒',
  дом: '🏠',
  дети: '🧸',
  деньги: '💰',
  учёба: '📚',
  личное: '🌱',
};

export interface TopicServiceDeps {
  readonly db: Executor;
  readonly gateway: TopicGateway;
  readonly logger?: Logger | undefined;
}

/** «ё» и регистр не делают тему другой темой. */
const normalize = normalizeTopicName;

async function iconFor(deps: TopicServiceDeps, name: string): Promise<string | undefined> {
  const emoji = TOPIC_ICONS[normalize(name)];
  if (emoji === undefined) return undefined;

  try {
    const allowed = await deps.gateway.allowedIcons();
    // Символа может не оказаться в наборе Telegram — тогда ветка
    // создаётся без иконки. Отказываться от ветки из-за картинки глупо.
    return allowed.get(emoji);
  } catch (error) {
    deps.logger?.warn({ err: error }, 'Не удалось получить набор иконок, ветка будет без иконки');
    return undefined;
  }
}

export interface EnsureThreadResult {
  readonly threadId: number | undefined;
  /** Ветка создана сейчас, а не найдена готовой. */
  readonly created: boolean;
  /** Режим тем недоступен: работаем плоско (§8.2). */
  readonly flat: boolean;
}

/**
 * Возвращает ветку темы, создавая её при необходимости.
 *
 * Пересоздание после удаления человеком идёт тем же путём: у темы нет
 * ветки — значит надо создать. Отдельной ветки кода для этого не нужно, и
 * это хорошо: путь один, и он проверен.
 */
export async function ensureThread(
  deps: TopicServiceDeps,
  params: { readonly topicId: string; readonly chatId: number },
): Promise<EnsureThreadResult> {
  const [topic] = await deps.db.select().from(topics).where(eq(topics.id, params.topicId)).limit(1);

  if (!topic) return { threadId: undefined, created: false, flat: false };
  if (topic.tgThreadId !== null) {
    return { threadId: topic.tgThreadId, created: false, flat: false };
  }

  try {
    const threadId = await deps.gateway.createThread({
      chatId: params.chatId,
      name: topic.name,
      iconEmojiId: await iconFor(deps, topic.name),
    });

    await deps.db.update(topics).set({ tgThreadId: threadId }).where(eq(topics.id, topic.id));

    deps.logger?.info({ topic: topic.name }, 'Ветка темы создана');
    return { threadId, created: true, flat: false };
  } catch (error) {
    if (isTopicsUnavailable(error)) {
      // §8.2: режим тем выключен. Это не поломка, а другой режим работы.
      deps.logger?.warn({ topic: topic.name }, 'Режим тем недоступен, работаю плоско');
      return { threadId: undefined, created: false, flat: true };
    }

    throw error;
  }
}

/**
 * Забывает пропавшую ветку.
 *
 * Тема **не архивируется**, хотя план задачи 2.17 предполагал именно это.
 * Причина: архивная тема выпадает из списка для классификации, то есть
 * записи человека начали бы раскладываться иначе — а он всего лишь
 * удалил ветку в чате, о сфере жизни речи не было. §6.4 запрещает менять
 * состав тем без спроса, и удаление ветки спросом не является. Ветка
 * пересоздастся, когда в неё снова будет что написать.
 */
export async function forgetThread(deps: TopicServiceDeps, threadId: number): Promise<void> {
  await deps.db
    .update(topics)
    .set({ tgThreadId: null, summaryMessageId: null })
    .where(eq(topics.tgThreadId, threadId));

  deps.logger?.info({ threadId }, 'Ветка пропала, забыл её — пересоздам при надобности');
}

/**
 * Тема, в ветке которой пришло сообщение (§8.1).
 *
 * Если женщина пишет внутри ветки, эта тема — контекст по умолчанию: и
 * для классификации сейчас, и для поиска кандидатов на третьем этапе.
 */
export async function topicByThread(
  db: Executor,
  userId: string,
  threadId: number,
): Promise<Topic | undefined> {
  const [topic] = await db
    .select()
    .from(topics)
    .where(and(eq(topics.userId, userId), eq(topics.tgThreadId, threadId)))
    .limit(1);

  return topic;
}

export interface MoveResult {
  readonly moved: boolean;
  readonly from: string | null;
  readonly to: string;
}

/**
 * Переносит запись в другую тему.
 *
 * Проверка «тема есть у человека» обязательна: §6.4 запрещает создавать
 * темы без спроса, а перенос в несуществующую тему создал бы её именем в
 * поле записи — тихо и мимо всех правил.
 */
export async function moveItemToTopic(
  db: Executor,
  params: { readonly itemId: string; readonly userId: string; readonly topicName: string },
): Promise<MoveResult> {
  const own = await listTopics(db, params.userId);
  const target = own.find((topic) => normalize(topic.name) === normalize(params.topicName));

  if (!target) {
    throw new Error(`Темы «${params.topicName}» у человека нет — перенос отменён`);
  }

  const [before] = await db
    .select({ topic: items.topic })
    .from(items)
    .where(and(eq(items.id, params.itemId), eq(items.userId, params.userId)))
    .limit(1);

  if (!before) throw new Error('Записи для переноса нет');
  if (before.topic !== null && normalize(before.topic) === normalize(target.name)) {
    return { moved: false, from: before.topic, to: target.name };
  }

  await db
    .update(items)
    // Оба поля в одной правке: ссылка — истина, название — кэш показа.
    .set({ topicId: target.id, topic: target.name, updatedAt: new Date() })
    .where(eq(items.id, params.itemId));

  return { moved: true, from: before.topic, to: target.name };
}

export type RemoveThreadOutcome = 'deleted' | 'gone';

/**
 * Удаляет ветку так, чтобы она не осталась сиротой (задача 3.46).
 *
 * Ветка снимается в двух местах — при удалении данных (§16) и при
 * архиве невыбранной сферы (3.43) — и в обоих база меняется раньше, чем
 * Telegram отвечает. Если он ответил «подождите», а мы не повторили,
 * ветка остаётся в чате навсегда: в базе её уже нет, перечислить темы
 * чата Bot API не умеет, и снять её можно только рукой. Ровно так
 * выглядела сирота от 29 августа (3.45).
 *
 * Поэтому одна пауза и один повтор, как у сводок. «Ветки уже нет» —
 * не отказ, а сделанное. Прочие отказы — наверх: решать, страшно ли
 * это, должен вызывающий (при удалении данных — нет, §16 важнее).
 */
export async function removeThread(
  deps: TopicServiceDeps & { readonly sleep?: ((ms: number) => Promise<void>) | undefined },
  params: { readonly chatId: number; readonly threadId: number },
): Promise<RemoveThreadOutcome> {
  const attempt = async (): Promise<RemoveThreadOutcome> => {
    try {
      await deps.gateway.deleteThread(params);
      return 'deleted';
    } catch (error) {
      if (isThreadGone(error)) return 'gone';
      throw error;
    }
  };

  try {
    return await attempt();
  } catch (error) {
    const wait = retryAfterSeconds(error);
    if (wait === undefined) throw error;

    deps.logger?.warn({ threadId: params.threadId, секунд: wait }, 'Telegram просит подождать');
    const sleep =
      deps.sleep ??
      ((ms: number): Promise<void> =>
        new Promise((resolve) => {
          setTimeout(resolve, ms).unref();
        }));
    await sleep(wait * 1000);

    return await attempt();
  }
}

export { isThreadGone };
