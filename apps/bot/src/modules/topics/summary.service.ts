import { and, asc, eq, inArray } from 'drizzle-orm';
import { GrammyError } from 'grammy';
import type { Logger } from 'pino';

import { items, topics, type Item } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { localDateParts } from '../classifier/dates.js';
import { textsFor, type TextProfile } from '../../texts/index.js';
import { isThreadGone, isTopicsUnavailable, type TopicGateway } from './gateway.js';
import { ensureThread, forgetThread } from './topics.service.js';

/**
 * Закреплённая сводка темы (задача 2.16).
 *
 * §8.2 ТЗ: одно закреплённое сообщение на тему, обновляется
 * **редактированием**, а не новым сообщением. Лента темы не должна
 * превращаться в свалку — а именно это и выйдет, если на каждое изменение
 * отправлять новое сообщение: за неделю в ветке «покупки» будет тридцать
 * почти одинаковых списков.
 *
 * Отсюда же следует, что отдельных сообщений на каждую запись нет вовсе.
 * Ветка темы — это одна сводка, и всё.
 */

/** Сколько записей показывать. Сводка — это обзор, а не полный бэклог. */
const MAX_LINES = 15;

/** Статусы, при которых дело ещё ждёт действия. */
const OPEN_STATUSES = ['new', 'active', 'in_progress', 'waiting'] as const;

export interface SummaryDeps {
  readonly db: Executor;
  readonly gateway: TopicGateway;
  readonly logger?: Logger | undefined;
}

/** Дата для строки сводки: день и месяц в поясе человека. */
function shortDate(at: Date, timeZone: string): string {
  const parts = localDateParts(at, timeZone);
  return `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}`;
}

/**
 * Текст сводки. Чистая функция: её можно проверить таблицей случаев, а
 * §8.2 говорит про содержимое, а не про способ отправки.
 */
export function buildSummary(params: {
  readonly topicName: string;
  readonly items: readonly Item[];
  readonly texts: TextProfile;
  readonly timeZone: string;
}): string {
  const { texts } = params;
  const lines: string[] = [texts.summary.header(params.topicName)];

  if (params.items.length === 0) {
    lines.push('', texts.summary.empty);
    return lines.join('\n');
  }

  const shown = params.items.slice(0, MAX_LINES);
  lines.push('');

  for (const item of shown) {
    lines.push(
      item.deadlineAt === null
        ? texts.summary.line(item.text)
        : texts.summary.lineWithDate(item.text, shortDate(item.deadlineAt, params.timeZone)),
    );
  }

  const hidden = params.items.length - shown.length;
  if (hidden > 0) lines.push('', texts.summary.more(hidden));

  return lines.join('\n');
}

/** Открытые записи темы в порядке срока, затем в порядке сказанного. */
export async function itemsOfTopic(
  db: Executor,
  userId: string,
  topicName: string,
): Promise<Item[]> {
  return await db
    .select()
    .from(items)
    .where(
      and(
        eq(items.userId, userId),
        eq(items.topic, topicName),
        eq(items.isDraft, false),
        inArray(items.status, [...OPEN_STATUSES]),
      ),
    )
    .orderBy(asc(items.deadlineAt), asc(items.createdAt), asc(items.sourceOrder), asc(items.id));
}

/**
 * Правка сообщения тем же текстом.
 *
 * Telegram отвечает на это отказом 400 «message is not modified». Это не
 * ошибка, а сообщение о том, что менять нечего: сводка уже такая. Считать
 * это сбоем значило бы засыпать журнал на каждой выгрузке, ничего не
 * изменившей в теме.
 */
function isUnchanged(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    error.error_code === 400 &&
    error.description.toLowerCase().includes('not modified')
  );
}

/** Сообщение исчезло: человек удалил его руками. Тогда шлём новое. */
function isMessageGone(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  if (error.error_code !== 400) return false;

  const description = error.description.toLowerCase();
  return (
    description.includes('message to edit not found') || description.includes('message_id_invalid')
  );
}

export interface RefreshResult {
  /** Сводка отправлена впервые (или заново после потери). */
  readonly sent: boolean;
  /** Сводка изменена правкой. */
  readonly edited: boolean;
  /** Менять было нечего либо режим тем недоступен. */
  readonly skipped: boolean;
}

const NOTHING: RefreshResult = { sent: false, edited: false, skipped: true };

/**
 * Обновляет сводку темы.
 *
 * Порядок такой: найти тему, при надобности создать ветку, собрать текст,
 * и дальше либо править существующее сообщение, либо отправить и
 * закрепить первое.
 *
 * Все три отказа Telegram, которые здесь возможны, — ожидаемые:
 * пропавшая ветка, пропавшее сообщение и «менять нечего». Первые два
 * лечатся пересозданием, третий не лечится, потому что и не болезнь.
 */
export async function refreshSummary(
  deps: SummaryDeps,
  params: {
    readonly userId: string;
    readonly chatId: number;
    readonly topicName: string;
    readonly timeZone: string;
    readonly profile?: string | null | undefined;
  },
): Promise<RefreshResult> {
  const [topic] = await deps.db
    .select()
    .from(topics)
    .where(and(eq(topics.userId, params.userId), eq(topics.name, params.topicName)))
    .limit(1);

  if (!topic || topic.isArchived) return NOTHING;

  const thread = await ensureThread(
    { db: deps.db, gateway: deps.gateway, logger: deps.logger },
    { topicId: topic.id, chatId: params.chatId },
  );

  // §8.2: без режима тем сводок нет — их некуда закреплять. Данные при
  // этом на месте, и плоский режим показывает их через меню (2.18).
  if (thread.flat || thread.threadId === undefined) return NOTHING;

  const text = buildSummary({
    topicName: topic.name,
    items: await itemsOfTopic(deps.db, params.userId, topic.name),
    texts: textsFor(params.profile),
    timeZone: params.timeZone,
  });

  const publish = async (): Promise<RefreshResult> => {
    const messageId = await deps.gateway.send({
      chatId: params.chatId,
      threadId: thread.threadId,
      text,
    });

    await deps.db
      .update(topics)
      .set({ summaryMessageId: messageId })
      .where(eq(topics.id, topic.id));

    // Закрепление отдельным шагом: если оно не удалось, сводка всё равно
    // на месте, просто не закреплена. Терять её из-за булавки незачем.
    try {
      await deps.gateway.pin({ chatId: params.chatId, messageId });
    } catch (error) {
      deps.logger?.warn({ err: error, topic: topic.name }, 'Сводка отправлена, но не закреплена');
    }

    return { sent: true, edited: false, skipped: false };
  };

  /**
   * Правка или первая отправка.
   *
   * Пропавшее сообщение лечится отправкой новой сводки, и эта отправка
   * может встретить пропавшую ветку — поэтому её отказ уходит наружу, во
   * внешний перехват. Так потеря ветки обрабатывается одинаково на обоих
   * путях: и когда мы правили, и когда отправляли впервые.
   */
  const attempt = async (): Promise<RefreshResult> => {
    if (topic.summaryMessageId === null) return await publish();

    try {
      await deps.gateway.edit({
        chatId: params.chatId,
        messageId: topic.summaryMessageId,
        text,
      });
      return { sent: false, edited: true, skipped: false };
    } catch (error) {
      if (isUnchanged(error)) return NOTHING;

      if (isMessageGone(error)) {
        deps.logger?.info({ topic: topic.name }, 'Сводка пропала, отправляю заново');
        return await publish();
      }

      throw error;
    }
  };

  try {
    return await attempt();
  } catch (error) {
    // Ветка пропала — самый частый способ это узнать как раз отправка в
    // неё. Тема остаётся, ветка пересоздастся при следующей надобности.
    if (isThreadGone(error)) {
      await forgetThread(
        { db: deps.db, gateway: deps.gateway, logger: deps.logger },
        thread.threadId,
      );
      return NOTHING;
    }

    if (isTopicsUnavailable(error)) return NOTHING;

    throw error;
  }
}

/**
 * Обновляет сводки перечисленных тем.
 *
 * Отказ на одной теме не отменяет остальные: сводка — это удобство, а не
 * данные, и терять из-за неё разбор нельзя.
 */
export async function refreshSummaries(
  deps: SummaryDeps,
  params: {
    readonly userId: string;
    readonly chatId: number;
    readonly topicNames: readonly string[];
    readonly timeZone: string;
    readonly profile?: string | null | undefined;
  },
): Promise<number> {
  let touched = 0;

  for (const topicName of new Set(params.topicNames)) {
    try {
      const result = await refreshSummary(deps, { ...params, topicName });
      if (result.sent || result.edited) touched++;
    } catch (error) {
      deps.logger?.error({ err: error, topic: topicName }, 'Не удалось обновить сводку темы');
    }
  }

  return touched;
}
