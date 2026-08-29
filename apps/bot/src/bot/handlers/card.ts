import { and, eq } from 'drizzle-orm';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Logger } from 'pino';

import { items, type Item } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { localDateParts } from '../../modules/classifier/dates.js';
import type { TopicGateway } from '../../modules/topics/gateway.js';
import { refreshSummaries } from '../../modules/topics/summary.service.js';
import { outputContextOf } from '../../modules/users/state.repo.js';
import { findByTgId } from '../../modules/users/users.repo.js';
import { textsFor, type TextProfile } from '../../texts/index.js';
import { fromShortId, toShortId } from '../../modules/shared/short-id.js';

/**
 * Карточка записи (§12.2 ТЗ, задача 2.18).
 *
 * Заголовок, тема, срок, статус и четыре кнопки: сделано, отложить,
 * изменить, убрать.
 *
 * **Каждое нажатие сверяет, чья это запись.** Короткий идентификатор в
 * `callback_data` — не секрет, а сокращение: он приходит снаружи, и его
 * можно подделать. Без проверки владельца чужая запись правилась бы по
 * подобранному коду.
 *
 * **«Изменить» не открывает форму, а подсказывает сказать словами.** §7 ТЗ
 * строит правку на речи: «не в четверг, а в пятницу». Учить человека
 * формам вместо разговора значило бы идти против продукта. Сама правка
 * речью — резолвер третьего этапа.
 *
 * **«Убрать» не удаляет физически.** §13.5: запись переводится в
 * отменённые, чтобы решение можно было откатить. Физическое удаление — по
 * отдельному пункту меню, с подтверждением в два шага.
 */

export const CARD_PREFIX = 'i:';

const CARD_ACTION = {
  done: 'i:done:',
  snooze: 'i:snz:',
  edit: 'i:edt:',
  remove: 'i:rm:',
} as const;

/** Сколько ждать отложенное дело. §11 подробностей не задаёт. */
const SNOOZE_DAYS = 3;

function shortDate(at: Date, timeZone: string): string {
  const parts = localDateParts(at, timeZone);
  return `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}`;
}

/** Текст карточки: заголовок, тема, срок, статус. */
export function cardText(item: Item, texts: TextProfile, timeZone: string): string {
  const card = texts.card;
  const lines: string[] = [item.text, ''];

  // §7.4: подробности, дописанные позже. Без них дополнение к делу
  // некуда посмотреть, и обещание «ничего не потеряно» пустое.
  if (item.body !== null && item.body.length > 0) lines.push(item.body, '');

  if (item.topic !== null) lines.push(`${card.topicLabel}: ${item.topic}`);

  if (item.deadlineAt === null) {
    lines.push(`${card.deadlineLabel}: ${card.noDeadline}`);
  } else {
    const date = shortDate(item.deadlineAt, timeZone);
    // Неточный срок числом называть нельзя: «на следующей неделе» — это
    // не четвёртое сентября, и напоминание по нему сработает не тогда.
    lines.push(
      `${card.deadlineLabel}: ${
        item.deadlineAccuracy === 'day' ? date : card.deadlineApprox(date)
      }`,
    );
  }

  // Регулярность показывается словами человека, а не нашим пересказом
  // правила: «каждый вторник» он узнает, «weekly, интервал 1» — нет.
  if (item.recurrenceText !== null) {
    lines.push(`${card.recurrenceLabel}: ${item.recurrenceText}`);
  }

  lines.push(`${card.statusLabel}: ${card.statusName(item.status)}`);

  return lines.join('\n');
}

export function cardKeyboard(item: Item, texts: TextProfile, back: string): InlineKeyboard {
  const code = toShortId(item.id);

  return new InlineKeyboard()
    .text(texts.card.buttonDone, `${CARD_ACTION.done}${code}`)
    .text(texts.card.buttonSnooze, `${CARD_ACTION.snooze}${code}`)
    .row()
    .text(texts.card.buttonEdit, `${CARD_ACTION.edit}${code}`)
    .text(texts.card.buttonDelete, `${CARD_ACTION.remove}${code}`)
    .row()
    .text(texts.menu.buttonBack, back);
}

export interface CardDeps {
  readonly db: Database;
  readonly logger: Logger;
  /** Нужен, чтобы после смены статуса поправить сводку темы (§8.2). */
  readonly topics?: TopicGateway | undefined;
}

export function registerCardHandlers(bot: Bot, deps: CardDeps, back: string): void {
  const { db, logger } = deps;

  /**
   * Запись по нажатию — только своя.
   *
   * `undefined` означает «не показывать»: либо человека нет, либо код
   * мусорный, либо запись чужая. Все три случая для нас одинаковы, и
   * различать их в ответе не надо — это подсказало бы, что чужой код
   * подобран верно.
   */
  async function ownItem(
    tgId: number,
    data: string,
    prefix: string,
  ): Promise<{ item: Item; texts: TextProfile; timeZone: string; userId: string } | undefined> {
    const uuid = fromShortId(data.slice(prefix.length));
    if (uuid === undefined) return undefined;

    const user = await findByTgId(db, tgId);
    if (!user) return undefined;

    const [item] = await db
      .select()
      .from(items)
      .where(and(eq(items.id, uuid), eq(items.userId, user.id)))
      .limit(1);

    if (!item) return undefined;

    const context = await outputContextOf(db, user.id);
    return {
      item,
      texts: textsFor(context.textProfile),
      timeZone: context.timeZone,
      userId: user.id,
    };
  }

  /** Сводка темы после смены статуса: запись из неё ушла или вернулась. */
  async function refresh(userId: string, chatId: number, topic: string | null): Promise<void> {
    if (!deps.topics || topic === null) return;

    const context = await outputContextOf(db, userId);
    await refreshSummaries(
      { db, gateway: deps.topics, logger },
      {
        userId,
        chatId,
        topicNames: [topic],
        timeZone: context.timeZone,
        profile: context.textProfile,
      },
    );
  }

  // ── Открыть карточку ──────────────────────────────────────────────────
  bot.callbackQuery(new RegExp(`^${CARD_PREFIX}[A-Za-z0-9_-]{22}$`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();

    const active = await ownItem(ctx.from.id, ctx.callbackQuery.data, CARD_PREFIX);
    if (!active) {
      await ctx.editMessageText(textsFor(null).card.gone);
      return;
    }

    await ctx.editMessageText(cardText(active.item, active.texts, active.timeZone), {
      reply_markup: cardKeyboard(active.item, active.texts, back),
    });
  });

  /** Общая часть трёх кнопок, меняющих статус. */
  const changeStatus = (
    prefix: string,
    next: 'done' | 'snoozed' | 'cancelled',
    reply: (texts: TextProfile) => string,
  ): void => {
    bot.callbackQuery(new RegExp(`^${prefix}`, 'u'), async (ctx) => {
      await ctx.answerCallbackQuery();

      const active = await ownItem(ctx.from.id, ctx.callbackQuery.data, prefix);
      if (!active) {
        await ctx.editMessageText(textsFor(null).card.gone);
        return;
      }

      // Отложенному делу срок сдвигается вперёд: иначе оно останется
      // просроченным и полезет в выдачу тем же вечером.
      const deadlineAt =
        next === 'snoozed'
          ? new Date(Date.now() + SNOOZE_DAYS * 24 * 60 * 60_000)
          : active.item.deadlineAt;

      await db
        .update(items)
        .set({
          status: next,
          // §5: когда закрыли, а не только что закрыто.
          completedAt: next === 'done' ? new Date() : null,
          deadlineAt,
          ...(next === 'snoozed' && active.item.deadlineAccuracy === null
            ? { deadlineAccuracy: 'day' as const }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(items.id, active.item.id));

      logger.info(
        { userId: active.userId, status: next },
        'Статус записи изменён кнопкой карточки',
      );

      await ctx.editMessageText(reply(active.texts));

      const chatId = ctx.chat?.id;
      if (chatId !== undefined) await refresh(active.userId, chatId, active.item.topic);
    });
  };

  changeStatus(CARD_ACTION.done, 'done', (texts) => texts.card.done);
  changeStatus(CARD_ACTION.snooze, 'snoozed', (texts) => texts.card.snoozed);
  changeStatus(CARD_ACTION.remove, 'cancelled', (texts) => texts.card.deleted);

  /**
   * Изменить: подсказка сказать словами.
   *
   * **Подсказка приходит всплывающим окном, а не правкой сообщения.**
   * Раньше она затирала карточку и не возвращала клавиатуру — и текст
   * «кнопками рядом» указывал на кнопки, которые сам же и стёр. У трёх
   * остальных кнопок замена карточки уместна: действие совершено, и
   * держать её незачем. Здесь действия нет, а человек терял экран за
   * нажатие, которое ничего не меняет.
   *
   * Найдено ручной проверкой на боевом боте 29.08.2026.
   */
  bot.callbackQuery(new RegExp(`^${CARD_ACTION.edit}`, 'u'), async (ctx) => {
    const active = await ownItem(ctx.from.id, ctx.callbackQuery.data, CARD_ACTION.edit);

    if (!active) {
      // Записи нет — вот здесь карточку заменить как раз надо: она врёт.
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(textsFor(null).card.gone);
      return;
    }

    await ctx.answerCallbackQuery({ text: active.texts.card.editHint, show_alert: true });
  });
}
