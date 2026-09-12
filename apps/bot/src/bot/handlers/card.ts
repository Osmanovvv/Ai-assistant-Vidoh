import { CARD_ACTION } from '../../modules/items/card-actions.js';
import { and, eq } from 'drizzle-orm';
import type { InlineKeyboard, Bot } from 'grammy';
import type { Logger } from 'pino';

import { items, type Item } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { localDateParts } from '../../modules/classifier/dates.js';
import type { TopicGateway } from '../../modules/topics/gateway.js';
import { describeChange } from '../../modules/resolver/change-text.js';
import { applyDecision, emptyChanges, type ApplyAction } from '../../modules/resolver/patch.js';
import { AWAITING, setAwaiting } from '../../modules/onboarding/awaiting.js';
import { listTopics, normalizeTopicName } from '../../modules/topics/topics.repo.js';
import { moveItemToTopic } from '../../modules/topics/topics.service.js';
import { refreshSummaries } from '../../modules/topics/summary.service.js';
import { outputContextOf } from '../../modules/users/state.repo.js';
import { findByTgId } from '../../modules/users/users.repo.js';
import { textsFor, type TextProfile } from '../../texts/index.js';
import { fromShortId, toShortId } from '../../modules/shared/short-id.js';
import { fitKeyboard } from '../../modules/presenter/keyboard.js';
import { buttonRefusal, nothingChangedReply } from './item-refusal.js';
import { undoKeyboard } from './undo.js';

/**
 * Карточка записи (§12.2 ТЗ, задача 2.18).
 *
 * Заголовок, тема, срок, статус и пять кнопок: сделано, отложить,
 * изменить, убрать, в другую сферу.
 *
 * **Пятая — сверх перечисленных в §12.2, и это осознанно** (запрос на
 * изменение №3). §8.2 обещает: «если запись меняет тему, бот переносит
 * её и обновляет сводки обеих веток». Перенос был написан и покрыт
 * тестами с задачи 2.15, а вызвать его было нечем — тему записи в
 * продукте не менял никто. Человек, у которого дело легло не в ту сферу,
 * не мог поправить это ни кнопкой, ни словами.
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

  return fitKeyboard([
    [
      { label: texts.card.buttonDone, action: `${CARD_ACTION.done}${code}` },
      { label: texts.card.buttonSnooze, action: `${CARD_ACTION.snooze}${code}` },
    ],
    [
      { label: texts.card.buttonEdit, action: `${CARD_ACTION.edit}${code}` },
      { label: texts.card.buttonDelete, action: `${CARD_ACTION.remove}${code}` },
    ],
    // Своей строкой: рядом с «Убрать» подпись длиннее всех остальных, и
    // пара читалась бы как одна кнопка с хвостом.
    [{ label: texts.card.buttonMove, action: `${CARD_ACTION.move}${code}` }],
    [{ label: texts.menu.buttonBack, action: back }],
  ]);
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
    /**
     * Уже отрезанный код, а не всё нажатие с префиксом.
     *
     * У переноса `callback_data` несёт два кода через двоеточие, и
     * «отрежь префикс» из этой пары запись не достаёт. Резать снаружи —
     * значит оставить проверку владельца одной на все кнопки; вторая её
     * копия однажды разошлась бы с первой.
     */
    code: string,
  ): Promise<{ item: Item; texts: TextProfile; timeZone: string; userId: string } | undefined> {
    const uuid = fromShortId(code);
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

  /**
   * Сводки тем после правки: запись из темы ушла или в неё пришла.
   *
   * Тем может быть две — §8.2 требует при переносе обновить «сводки
   * обеих веток». Повторы снимает сама `refreshSummaries`; снимать их и
   * здесь значило бы считать одно и то же двумя способами.
   */
  async function refresh(
    userId: string,
    chatId: number,
    ...topics: readonly (string | null)[]
  ): Promise<void> {
    const names = topics.filter((one): one is string => one !== null && one.length > 0);
    if (!deps.topics || names.length === 0) return;

    const context = await outputContextOf(db, userId);
    await refreshSummaries(
      { db, gateway: deps.topics, logger },
      {
        userId,
        chatId,
        topicNames: names,
        timeZone: context.timeZone,
        profile: context.textProfile,
      },
    );
  }

  // ── Открыть карточку ──────────────────────────────────────────────────
  bot.callbackQuery(new RegExp(`^${CARD_PREFIX}[A-Za-z0-9_-]{22}$`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();

    const active = await ownItem(ctx.from.id, ctx.callbackQuery.data.slice(CARD_PREFIX.length));
    if (!active) {
      await ctx.editMessageText(textsFor(null).card.gone);
      return;
    }

    await ctx.editMessageText(cardText(active.item, active.texts, active.timeZone), {
      reply_markup: cardKeyboard(active.item, active.texts, back),
    });
  });

  /**
   * Общая часть трёх кнопок, меняющих запись.
   *
   * Все три идут через `applyDecision` — тем же путём, что голос и кнопка
   * под напоминанием (ревизия этапа 3, C1 и C2). Раньше кнопка писала в
   * базу напрямую: ни ревизии, ни отката, свои слова вместо общих, а у
   * регулярного дела «Сделано» с карточки было не таким, как «сделала»
   * голосом. Реплика и кнопка отмены — те же, что у резолвера, поэтому
   * человеку не надо помнить, каким способом он отметил садик.
   *
   * Отсюда же и «Убрать» у регулярного дела: как «больше не надо» голосом
   * (задача 3.8а), оно снимает правило, а запись оставляет — и говорит
   * об этом. Второе «Убрать» уже уберёт запись, как обычную.
   */
  const decide = (prefix: string, action: ApplyAction, reason: string): void => {
    bot.callbackQuery(new RegExp(`^${prefix}`, 'u'), async (ctx) => {
      await ctx.answerCallbackQuery();

      const active = await ownItem(ctx.from.id, ctx.callbackQuery.data.slice(prefix.length));
      if (!active) {
        await ctx.editMessageText(textsFor(null).card.gone);
        return;
      }

      const now = new Date();
      // Закрытое дело кнопками не трогается (C3) — см. `buttonRefusal`.
      const refused = buttonRefusal(action, active.item, active.texts, active.timeZone, now);
      if (refused !== undefined) {
        await ctx.editMessageText(refused);
        return;
      }

      const applied = await applyDecision(db, {
        userId: active.userId,
        itemId: active.item.id,
        action,
        changes: emptyChanges(),
        timeZone: active.timeZone,
        now,
        reason,
        changedBy: 'user',
      });

      if (applied === undefined) {
        await ctx.editMessageText(
          nothingChangedReply(action, active.item, active.texts, active.timeZone, now),
        );
        return;
      }

      logger.info(
        { userId: active.userId, action, fields: applied.fields },
        'Запись изменена кнопкой карточки',
      );

      await ctx.editMessageText(describeChange(applied, active.texts, active.timeZone), {
        reply_markup: undoKeyboard(applied.revisionId, active.texts),
      });

      const chatId = ctx.chat?.id;
      if (chatId !== undefined) await refresh(active.userId, chatId, active.item.topic);
    });
  };

  decide(CARD_ACTION.done, 'complete', 'нажата кнопка «Сделано» на карточке');
  decide(CARD_ACTION.snooze, 'snooze', 'нажата кнопка «Отложить» на карточке');
  decide(CARD_ACTION.remove, 'cancel', 'нажата кнопка «Убрать» на карточке');

  /**
   * Изменить: бот ждёт новый текст дела словами (задача 3.61).
   *
   * **Была заглушкой.** Кнопка говорила «пока меняю только статус и срок
   * — кнопками рядом», то есть обещала правку и не делала её. Заказчик
   * назвал это заглушкой прямо, и он прав: кнопка, которая ничего не
   * меняет, хуже отсутствующей.
   *
   * Теперь она просит написать новый текст, и следующая реплика человека
   * его перепишет — с кнопкой отмены, как любая правка резолвера. Срок и
   * статус остаются на своих кнопках: у них правка одним тапом, и гонять
   * человека через текст ради того, что решается кнопкой, незачем.
   *
   * **Карточка остаётся на экране.** Просьба приходит отдельным
   * сообщением, а не правкой карточки: правка затирала бы кнопки, на
   * которые сама же и указывает. Найдено ручной проверкой 29.08.2026, и
   * это свойство сохранено.
   */
  bot.callbackQuery(new RegExp(`^${CARD_ACTION.edit}`, 'u'), async (ctx) => {
    const active = await ownItem(
      ctx.from.id,
      ctx.callbackQuery.data.slice(CARD_ACTION.edit.length),
    );

    if (!active) {
      // Записи нет — вот здесь карточку заменить как раз надо: она врёт.
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(textsFor(null).card.gone);
      return;
    }

    await ctx.answerCallbackQuery();
    await setAwaiting(db, active.userId, `${AWAITING.editPrefix}${active.item.id}`);
    await ctx.reply(active.texts.card.editHint);
  });
  /**
   * «В другую сферу»: экран выбора (§8.2, запрос на изменение №3).
   *
   * §8.2 обещает, что при смене темы бот «переносит её и обновляет сводки
   * обеих веток». Перенос был написан и покрыт тестами с задачи 2.15, но
   * звать его было неоткуда: обещание держалось на функции без
   * вызывающего. Тему записи в продукте не менял никто — резолвер её не
   * знает даже схемой ответа, — и человек, у которого дело легло не в ту
   * сферу, не мог поправить это ни кнопкой, ни словами.
   *
   * Нынешняя сфера в список не идёт: перенос в неё же — не перенос, а
   * лишняя кнопка на экране, где их и так по числу сфер.
   */
  bot.callbackQuery(new RegExp(`^${CARD_ACTION.move}`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();

    const active = await ownItem(
      ctx.from.id,
      ctx.callbackQuery.data.slice(CARD_ACTION.move.length),
    );
    if (!active) {
      await ctx.editMessageText(textsFor(null).card.gone);
      return;
    }

    const code = toShortId(active.item.id);
    const own = await listTopics(db, active.userId);
    const current = active.item.topic === null ? null : normalizeTopicName(active.item.topic);
    const others = own.filter((topic) => normalizeTopicName(topic.name) !== current);

    if (others.length === 0) {
      // Молчать нельзя: человек нажал и обязан узнать, почему ничего не
      // случилось. Кнопка назад остаётся, иначе экран — тупик.
      await ctx.editMessageText(active.texts.card.moveNoTopics, {
        reply_markup: fitKeyboard([
          [{ label: active.texts.menu.buttonBack, action: `${CARD_PREFIX}${code}` }],
        ]),
      });
      return;
    }

    await ctx.editMessageText(active.texts.card.moveWhere, {
      reply_markup: fitKeyboard([
        ...others.map((topic) => [
          { label: topic.name, action: `${CARD_ACTION.moveTo}${code}:${toShortId(topic.id)}` },
        ]),
        [{ label: active.texts.menu.buttonBack, action: `${CARD_PREFIX}${code}` }],
      ]),
    });
  });

  /**
   * Перенос в выбранную сферу.
   *
   * Оба кода приходят снаружи, поэтому проверяются оба: запись — как у
   * всех кнопок карточки, сфера — поиском среди тем этого человека.
   * `moveItemToTopic` сверяет тему ещё раз по названию, и это не второй
   * способ счёта, а её собственное условие: §6.4 запрещает создавать темы
   * без спроса, а перенос в отсутствующую создал бы её именем в поле
   * записи — тихо и мимо всех правил.
   */
  bot.callbackQuery(new RegExp(`^${CARD_ACTION.moveTo}`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();

    const [itemCode = '', topicCode = ''] = ctx.callbackQuery.data
      .slice(CARD_ACTION.moveTo.length)
      .split(':');

    const active = await ownItem(ctx.from.id, itemCode);
    if (!active) {
      await ctx.editMessageText(textsFor(null).card.gone);
      return;
    }

    const own = await listTopics(db, active.userId);
    const target = own.find((topic) => topic.id === fromShortId(topicCode));

    if (!target) {
      // Сферу могли убрать в архив, пока экран висел, а код мог быть и
      // подделан. Для человека оба случая одинаковы, но в журнале след
      // нужен: молчаливый отказ — худший отказ.
      logger.info({ userId: active.userId }, 'Перенос: такой сферы у человека нет');
      await ctx.editMessageText(active.texts.card.moveNoTopic);
      return;
    }

    const chatId = ctx.chat?.id;

    try {
      const result = await moveItemToTopic(db, {
        itemId: active.item.id,
        userId: active.userId,
        topicName: target.name,
      });

      if (!result.moved) {
        await ctx.editMessageText(active.texts.card.moveAlready(result.to));
        return;
      }

      logger.info(
        { userId: active.userId, from: result.from, to: result.to },
        'Запись перенесена в другую сферу кнопкой карточки',
      );

      await ctx.editMessageText(active.texts.card.moved(result.to));

      /**
       * Прежняя ветка — под именем из таблицы тем, а не из записи.
       *
       * В поле записи название лежит так, как его сказала модель, а
       * сводка находит тему точным равенством имени. «Здоровье» из
       * разбора не нашло бы тему «здоровье», и старая ветка осталась бы
       * с делом, которого там уже нет, — молча.
       */
      const from = result.from;
      const previous =
        from === null
          ? null
          : (own.find((topic) => normalizeTopicName(topic.name) === normalizeTopicName(from))
              ?.name ?? from);

      if (chatId !== undefined) await refresh(active.userId, chatId, previous, result.to);
    } catch (error) {
      /**
       * Запись могла исчезнуть по §16, пока экран висел, а база — отказать.
       * Для человека это одно: «не вышло», и карточка врать не должна.
       */
      logger.warn({ err: error, userId: active.userId }, 'Перенос записи не удался');
      await ctx.editMessageText(active.texts.card.moveFailed);
    }
  });
}
