import { InlineKeyboard, type Bot, type CallbackQueryContext, type Context } from 'grammy';
import type { Logger } from 'pino';

import { eq, not } from 'drizzle-orm';

import { userSettings } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { openItemsFor } from '../../modules/items/items.repo.js';
import { effectiveEnergy, selectForToday } from '../../modules/output/filter.js';
import { itemsOfTopic } from '../../modules/topics/summary.service.js';
import { listTopics } from '../../modules/topics/topics.repo.js';
import { outputContextOf } from '../../modules/users/state.repo.js';
import { findByTgId } from '../../modules/users/users.repo.js';
import { textsFor, type TextProfile } from '../../texts/index.js';
import { DELETE_STEP_ONE } from './privacy.js';
import { cardKeyboard, cardText, CARD_PREFIX } from './card.js';
import { ANSWER_ACTION } from '../../modules/presenter/presenter.service.js';
import { pageOf } from '../../modules/backlog/backlog.service.js';
import { fromShortId, toShortId } from '../../modules/shared/short-id.js';

/**
 * Меню и списки (§12.1 ТЗ, задача 2.18).
 *
 * **Пунктов меньше, чем в §12.1, и это осознанно.** «Проекты» появятся с
 * задачей 3.12, «Подписка» — на четвёртом этапе. Кнопка, за которой ничего
 * нет, хуже отсутствующей: она обещает и не выполняет, и человек перестаёт
 * верить остальным.
 *
 * **«Настройки» открылись раньше своего этапа, но урезанными.** §11 требует
 * выключатель напоминаний и режим тишины, а с задачи 3.14 бот начал писать
 * сам — настройка, до которой нельзя дотянуться, настройкой не является.
 * Времена, пояс и темы остаются четвёртому этапу.
 *
 * **Списки простые, без постраничности.** Постраничность и реестр
 * инструментов — задача 3.11, там же «Проекты». Здесь ровно то, без чего
 * не работает плоский режим §8.2: пройти по сферам и увидеть, что на
 * сегодня. Дублирования не будет — 3.11 надстроит эти же списки.
 *
 * **Все переходы правят одну реплику.** Меню — это один экран, который
 * меняется, а не лента из десяти сообщений.
 */

export const MENU_ACTION = {
  root: 'menu:root',
  all: 'menu:all',
  today: 'menu:today',
  help: 'menu:help',
  /** `menu:t:<код>` — тема коротким кодом, как и запись. */
  topicPrefix: 'menu:t:',
  /** `menu:p:<код>:<страница>` — страница списка темы. */
  pagePrefix: 'menu:p:',
  /** `menu:d:<страница>` — страница списка «Сегодня». */
  todayPage: 'menu:d:',
  /** Настройки: пока только два выключателя из §11 (задача 3.17). */
  settings: 'menu:set',
  toggleReminders: 'menu:set:r',
  toggleQuiet: 'menu:set:q',
} as const;

function rootKeyboard(texts: TextProfile): InlineKeyboard {
  return new InlineKeyboard()
    .text(texts.menu.buttonAll, MENU_ACTION.all)
    .text(texts.menu.buttonToday, MENU_ACTION.today)
    .row()
    .text(texts.menu.buttonHelp, MENU_ACTION.help)
    .row()
    .text(texts.menu.buttonSettings, MENU_ACTION.settings)
    .row()
    .text(texts.menu.buttonDeleteData, DELETE_STEP_ONE);
}

function backKeyboard(texts: TextProfile): InlineKeyboard {
  return new InlineKeyboard().text(texts.menu.buttonBack, MENU_ACTION.root);
}

/**
 * Тема в `callback_data` — коротким кодом, а не названием.
 *
 * Название соблазнительно: оно уникально у человека и обычно короткое. Но
 * колонка `topics.name` длину не ограничивает, а на четвёртом этапе темы
 * можно будет переименовать — и кириллическое название в UTF-8 весит по
 * два байта на знак. Тридцать два знака, и предел пробит. Код же всегда
 * двадцать два знака, сколько бы тема ни называлась.
 */
function topicsKeyboard(
  texts: TextProfile,
  own: readonly { readonly id: string; readonly name: string }[],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const topic of own) {
    keyboard.text(topic.name, `${MENU_ACTION.topicPrefix}${toShortId(topic.id)}`).row();
  }

  return keyboard.text(texts.menu.buttonBack, MENU_ACTION.root);
}

/** Список записей: каждая — кнопка, ведущая в свою карточку. */
function itemsKeyboard(
  texts: TextProfile,
  items: readonly { readonly id: string; readonly text: string }[],
  back: string,
  paging?: { readonly index: number; readonly action: (page: number) => string },
): InlineKeyboard {
  /**
   * Двести дел в одно сообщение не помещаются (задача 3.11).
   *
   * Telegram отводит на текст 4096 знаков, а на клавиатуру — сотню
   * кнопок. Список накопившегося бэклога пробивает оба предела, и бот
   * молча ответит ошибкой. Проверять это на человеке с реальным списком
   * — поздно.
   */
  const page = pageOf(items, paging?.index ?? 0);
  const keyboard = new InlineKeyboard();

  for (const item of page.items) {
    keyboard.text(item.text, `${CARD_PREFIX}${toShortId(item.id)}`).row();
  }

  if (paging !== undefined && page.pages > 1) {
    if (page.hasPrevious) {
      keyboard.text(texts.menu.buttonPrevious, paging.action(page.index - 1));
    }

    // Номер страницы кнопкой, ведущей туда же: у Telegram нет надписи без
    // нажатия, а знать, где ты в списке из двадцати пяти страниц, надо.
    keyboard.text(texts.menu.pageOf(page.index + 1, page.pages), paging.action(page.index));

    if (page.hasNext) {
      keyboard.text(texts.menu.buttonNext, paging.action(page.index + 1));
    }

    keyboard.row();
  }

  return keyboard.text(texts.menu.buttonBack, back);
}

export function registerMenuHandlers(bot: Bot, db: Database, logger: Logger): void {
  /** Кто нажал и с какими текстами ему отвечать. */
  async function acting(
    tgId: number,
  ): Promise<{ userId: string; texts: TextProfile; timeZone: string } | undefined> {
    const user = await findByTgId(db, tgId);
    if (!user) return undefined;

    const context = await outputContextOf(db, user.id);
    return { userId: user.id, texts: textsFor(context.textProfile), timeZone: context.timeZone };
  }

  const show = async (
    ctx: CallbackQueryContext<Context>,
    text: string,
    keyboard: InlineKeyboard,
  ): Promise<void> => {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  };

  bot.command('menu', async (ctx) => {
    const active = await acting(ctx.from?.id ?? 0);
    if (!active) return;

    await ctx.reply(active.texts.menu.title, { reply_markup: rootKeyboard(active.texts) });
  });

  bot.callbackQuery(MENU_ACTION.root, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    await show(ctx, active.texts.menu.title, rootKeyboard(active.texts));
  });

  bot.callbackQuery(MENU_ACTION.help, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    await show(ctx, active.texts.menu.help, backKeyboard(active.texts));
  });

  // ── Настройки: два выключателя из §11 (задача 3.17) ───────────────────
  /**
   * Экран показывает состояние словами, а кнопки называют действие.
   *
   * «Напоминания: вкл» на кнопке двусмысленно: непонятно, это текущее
   * состояние или то, что случится по нажатию. Состояние — в тексте,
   * действие — на кнопке, и спутать нечего.
   */
  async function showSettings(ctx: CallbackQueryContext<Context>): Promise<void> {
    const active = await acting(ctx.from.id);
    if (!active) return;

    const [current] = await db
      .select({
        notificationsOn: userSettings.notificationsOn,
        quietHoursOn: userSettings.quietHoursOn,
        quietFrom: userSettings.quietFrom,
        quietTo: userSettings.quietTo,
      })
      .from(userSettings)
      .where(eq(userSettings.userId, active.userId))
      .limit(1);

    if (!current) return;

    const texts = active.texts;
    const lines = [
      texts.settings.title,
      '',
      current.notificationsOn ? texts.settings.remindersOn : texts.settings.remindersOff,
      current.quietHoursOn
        ? texts.settings.quietOn(shortTime(current.quietFrom), shortTime(current.quietTo))
        : texts.settings.quietOff,
    ];

    const keyboard = new InlineKeyboard()
      .text(
        current.notificationsOn
          ? texts.settings.buttonRemindersOff
          : texts.settings.buttonRemindersOn,
        MENU_ACTION.toggleReminders,
      )
      .row()
      .text(
        current.quietHoursOn ? texts.settings.buttonQuietOff : texts.settings.buttonQuietOn,
        MENU_ACTION.toggleQuiet,
      )
      .row()
      .text(texts.menu.buttonBack, MENU_ACTION.root);

    await show(ctx, lines.join(NEWLINE), keyboard);
  }

  bot.callbackQuery(MENU_ACTION.settings, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showSettings(ctx);
  });

  bot.callbackQuery(MENU_ACTION.toggleReminders, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    await db
      .update(userSettings)
      .set({ notificationsOn: not(userSettings.notificationsOn), updatedAt: new Date() })
      .where(eq(userSettings.userId, active.userId));

    await showSettings(ctx);
  });

  bot.callbackQuery(MENU_ACTION.toggleQuiet, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    await db
      .update(userSettings)
      .set({ quietHoursOn: not(userSettings.quietHoursOn), updatedAt: new Date() })
      .where(eq(userSettings.userId, active.userId));

    await showSettings(ctx);
  });

  // ── Все задачи: сначала сферы, потом записи внутри ────────────────────
  /**
   * Полный бэклог по темам. Два входа, одна реализация: пункт меню и
   * кнопка «Разобрать все» под разбором (§13.2). Разводить их значило бы
   * получить два экрана, которые разойдутся.
   */
  bot.callbackQuery([MENU_ACTION.all, ANSWER_ACTION.all], async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    const own = await listTopics(db, active.userId);

    if (own.length === 0) {
      await show(ctx, active.texts.menu.noTopics, backKeyboard(active.texts));
      return;
    }

    await show(ctx, active.texts.menu.topicsTitle, topicsKeyboard(active.texts, own));
  });

  const showTopic = async (ctx: CallbackQueryContext<Context>, code: string, page: number) => {
    const active = await acting(ctx.from.id);
    if (!active) return;

    const topicId = fromShortId(code);

    // Тема ищется среди тем этого человека: код приходит из нажатия, то
    // есть снаружи, и показывать по нему чужую тему нельзя.
    const own = await listTopics(db, active.userId);
    const topic = own.find((candidate) => candidate.id === topicId);

    if (!topic) {
      logger.debug({ code }, 'Нажатие по неизвестной теме');
      await show(ctx, active.texts.menu.topicsTitle, topicsKeyboard(active.texts, own));
      return;
    }

    const inTopic = await itemsOfTopic(db, active.userId, topic.name);

    await show(
      ctx,
      // Заголовок из словаря, тот же, что у закреплённой сводки: строить
      // видимый человеку текст в коде нельзя даже из одного двоеточия.
      inTopic.length === 0 ? active.texts.summary.empty : active.texts.summary.header(topic.name),
      itemsKeyboard(active.texts, inTopic, MENU_ACTION.all, {
        index: page,
        action: (next) => `${MENU_ACTION.pagePrefix}${code}:${String(next)}`,
      }),
    );
  };

  bot.callbackQuery(new RegExp(`^${MENU_ACTION.topicPrefix}`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();
    await showTopic(ctx, ctx.callbackQuery.data.slice(MENU_ACTION.topicPrefix.length), 0);
  });

  bot.callbackQuery(new RegExp(`^${MENU_ACTION.pagePrefix}`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();

    const rest = ctx.callbackQuery.data.slice(MENU_ACTION.pagePrefix.length);
    const [code = '', page = '0'] = rest.split(':');

    await showTopic(ctx, code, Number.parseInt(page, 10) || 0);
  });

  // ── Сегодня ───────────────────────────────────────────────────────────
  const showToday = async (ctx: CallbackQueryContext<Context>, page: number) => {
    const active = await acting(ctx.from.id);
    if (!active) return;

    const context = await outputContextOf(db, active.userId);
    const today = selectForToday(await openItemsFor(db, active.userId), {
      energy: effectiveEnergy(context.state, context.energyDefault, {
        now: new Date(),
        timeZone: context.timeZone,
      }),
      now: new Date(),
      timeZone: context.timeZone,
    });

    if (today.length === 0) {
      await show(ctx, active.texts.menu.todayEmpty, backKeyboard(active.texts));
      return;
    }

    await show(
      ctx,
      active.texts.menu.todayTitle,
      itemsKeyboard(active.texts, today, MENU_ACTION.root, {
        index: page,
        action: (next) => `${MENU_ACTION.todayPage}${String(next)}`,
      }),
    );
  };

  bot.callbackQuery(MENU_ACTION.today, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showToday(ctx, 0);
  });

  bot.callbackQuery(new RegExp(`^${MENU_ACTION.todayPage}`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();
    const page = Number.parseInt(ctx.callbackQuery.data.slice(MENU_ACTION.todayPage.length), 10);
    await showToday(ctx, page || 0);
  });
  /**
   * «Сделать сейчас» (§13.2: ведёт в режим выполнения).
   *
   * Открывает карточку первого дела на сегодня — не список, а именно
   * карточку: у кнопки написано «сделать», и человек должен оказаться там,
   * где дело закрывается одним нажатием.
   *
   * Дело выбирается заново в момент нажатия, а не запоминается в
   * обратном вызове: человек мог нажать через час, и за это время
   * появилось более срочное.
   */
  bot.callbackQuery(ANSWER_ACTION.now, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    const context = await outputContextOf(db, active.userId);
    const now = new Date();
    const today = selectForToday(await openItemsFor(db, active.userId), {
      energy: effectiveEnergy(context.state, context.energyDefault, {
        now,
        timeZone: context.timeZone,
      }),
      now,
      timeZone: context.timeZone,
    });

    const first = today[0];
    if (first === undefined) {
      await show(ctx, active.texts.menu.todayEmpty, backKeyboard(active.texts));
      return;
    }

    await show(
      ctx,
      cardText(first, active.texts, active.timeZone),
      cardKeyboard(first, active.texts, MENU_ACTION.root),
    );
  });

  /**
   * «Оставить на потом» (§13.2: закрывает сессию без упреков).
   *
   * Клавиатура снимается вместе с ответом: разговор закончен, и кнопки,
   * которые ведут обратно в него, тут не к месту.
   */
  bot.callbackQuery(ANSWER_ACTION.later, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);

    // Профиль текстов берётся человека, а если его нет — стандартный:
    // реплика короткая, и молчать вместо неё было бы хуже.
    const texts = active?.texts ?? textsFor(null);

    await ctx.editMessageText(texts.answer.laterAccepted);
  });
}

const NEWLINE = '\n';

/** «22:00:00» из базы человеку показывается как «22:00». */
function shortTime(value: string): string {
  return value.slice(0, 5);
}
