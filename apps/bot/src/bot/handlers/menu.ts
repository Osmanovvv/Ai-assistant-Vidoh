import { InlineKeyboard, type Bot, type CallbackQueryContext, type Context } from 'grammy';
import type { Logger } from 'pino';

import { and, eq, not } from 'drizzle-orm';

import { items, userSettings, type Item } from '../../db/schema.js';
import { RETURNING_ACTION } from '../../modules/returning/returning-actions.js';
import { dropPending } from '../../modules/scheduler/reminders.repo.js';
import type { Database } from '../../infra/db.js';
import { openItemsFor } from '../../modules/items/items.repo.js';
import { describeProject } from '../../modules/projects/project-text.js';
import { stepButtons } from '../../modules/projects/project-actions.js';
import { contextOf, projectsOf } from '../../modules/projects/projects.service.js';
import { titleUnderDayHeader } from '../../modules/items/item-text.js';
import { selectForToday } from '../../modules/output/filter.js';
import { itemsOfTopic } from '../../modules/topics/summary.service.js';
import { appendTopics, listTopics } from '../../modules/topics/topics.repo.js';
import { retireTopics } from '../../modules/topics/retire.service.js';
import type { TopicGateway } from '../../modules/topics/gateway.js';
import {
  cityOfZone,
  EVENING_TIMES,
  MORNING_TIMES,
  setEvening,
  setMorning,
  setTimezone,
  TIMEZONES,
  topicRows,
  TOPIC_CHOICES,
} from '../../modules/onboarding/onboarding.service.js';
import { AWAITING, setAwaiting } from '../../modules/onboarding/awaiting.js';
import type { SettingsRegistry } from '../../modules/settings/settings.repo.js';
import { outputContextOf } from '../../modules/users/state.repo.js';
import { findByTgId } from '../../modules/users/users.repo.js';
import { textsFor, type TextProfile } from '../../texts/index.js';
import { BILLING_ACTION } from './billing.js';
import { DELETE_STEP_ONE } from './privacy.js';
import { cardKeyboard, cardText, CARD_PREFIX } from './card.js';
import { ANSWER_ACTION } from '../../modules/presenter/presenter.service.js';
import { pageOf } from '../../modules/backlog/backlog.service.js';
import { fromShortId, toShortId } from '../../modules/shared/short-id.js';
import { fitKeyboard } from '../../modules/presenter/keyboard.js';

/**
 * Меню и списки (§12.1 ТЗ, задача 2.18).
 *
 * **Пунктов меньше, чем в §12.1, и это осознанно.** «Проекты» появились с
 * задачей 3.12, «Подписка» — с 4.2. Кнопка, за которой ничего
 * нет, хуже отсутствующей: она обещает и не выполняет, и человек перестаёт
 * верить остальным.
 *
 * **«Настройки» закрывают свою строку §12.1 целиком** — темы, время
 * напоминаний, часовой пояс и выключатель напоминаний. Открылись они
 * раньше своего этапа с двумя выключателями §11, а остальное было
 * отложено «четвёртому этапу» — и осталось там без задачи-владельца.
 * Ревизия второго этапа это и нашла: человек, выбравший на опросе 08:00,
 * не мог изменить время ничем — ни кнопкой, ни словами; пояс, который
 * ломает все сроки разом, правился только через разработчика.
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
  /**
   * Подсказки «как со мной говорить» (§12.1: «Наговорить» — основная
   * кнопка, «Написать» — рядом).
   *
   * Реплики для них лежали в словаре меню с самого начала и не
   * читались никем: намерение было, связки не было. Сам текст
   * подсказки берётся у приветствия — он там один и тот же, и вторая
   * копия однажды разошлась бы с первой.
   */
  hintVoice: 'menu:hv',
  hintText: 'menu:ht',
  all: 'menu:all',
  today: 'menu:today',
  help: 'menu:help',
  /** `menu:t:<код>` — тема коротким кодом, как и запись. */
  topicPrefix: 'menu:t:',
  /** `menu:p:<код>:<страница>` — страница списка темы. */
  pagePrefix: 'menu:p:',
  /** `menu:d:<страница>` — страница списка «Сегодня». */
  todayPage: 'menu:d:',
  /**
   * Проекты (§12.1). Пункт меню, а не только вопрос словами.
   *
   * Разложение на шаги, ближайший шаг и его закрытие работали с
   * третьего этапа, но попасть к ним человек мог лишь речью — если
   * догадается спросить. Экрана «какие у меня большие цели и какой
   * ближайший шаг» не было, хотя §12.1 просит его прямо.
   */
  projects: 'menu:pr',
  /** `menu:pr:<код>` — цель коротким кодом, как запись и тема. */
  projectPrefix: 'menu:pr:',
  settings: 'menu:set',
  toggleReminders: 'menu:set:r',
  toggleQuiet: 'menu:set:q',

  /**
   * Остальные четыре величины §12.1: времена, пояс, сферы и имя.
   *
   * Действия свои, а не опросные: обработчики опроса сверяют шаг, и после
   * его прохождения молча ничего не делают. Служебные функции при этом те
   * же — `setMorning`, `setEvening`, `setTimezone`, `setPreferredName`,
   * `appendTopics`/`retireTopics`: нового поведения здесь нет,
   * появилась связка, которой не было.
   */
  askMorning: 'menu:set:m',
  askEvening: 'menu:set:e',
  askCity: 'menu:set:c',
  askName: 'menu:set:n',
  askTopics: 'menu:set:t',
  /** `menu:set:m:08:00` — выбранное время из готовых. */
  morningPrefix: 'menu:set:m:',
  eveningPrefix: 'menu:set:e:',
  eveningOff: 'menu:set:e:off',
  /** `menu:set:c:Asia/Omsk` — 24 байта, предел callback_data 64. */
  cityPrefix: 'menu:set:c:',
  /** `menu:set:t:работа` — переключить сферу. */
  topicSetPrefix: 'menu:set:t:',
  topicsSetDone: 'menu:set:t!',
  /** Ввод словами: своё время, свой город, имя. */
  ownMorning: 'menu:set:m!',
  ownEvening: 'menu:set:e!',
  ownCity: 'menu:set:c!',
} as const;

/** Наружу — чтобы страж ширины в `keyboards.test.ts` её проверял. */
export function rootKeyboard(texts: TextProfile): InlineKeyboard {
  return fitKeyboard([
    /**
     * «Наговорить» первой: §12.1 называет её основной кнопкой, и это
     * не украшение — голос и есть главный вход в продукт.
     */
    [
      { label: texts.menu.buttonVoice, action: MENU_ACTION.hintVoice },
      { label: texts.menu.buttonText, action: MENU_ACTION.hintText },
    ],
    [
      { label: texts.menu.buttonAll, action: MENU_ACTION.all },
      { label: texts.menu.buttonToday, action: MENU_ACTION.today },
    ],
    [{ label: texts.menu.buttonProjects, action: MENU_ACTION.projects }],
    [{ label: texts.menu.buttonHelp, action: MENU_ACTION.help }],
    [{ label: texts.menu.buttonSettings, action: MENU_ACTION.settings }],
    /**
     * «Подписка» стоит здесь всегда, а не по наличию оплаты.
     *
     * Соблазн показывать её только продающему боту понятен, но экран за
     * ней осмыслен и без товара: он говорит, до какого числа оплачено, и
     * даёт отключить продление. Человеку, который уже платит, эта кнопка
     * нужна ровно тогда, когда цены с рельса сняли.
     */
    [{ label: texts.menu.buttonSubscription, action: BILLING_ACTION.open }],
    [{ label: texts.menu.buttonDeleteData, action: DELETE_STEP_ONE }],
  ]);
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

export function registerMenuHandlers(
  bot: Bot,
  db: Database,
  logger: Logger,
  /**
   * Реестр настроек — ради предела числа тем (§6.4).
   *
   * Необязателен, как и у остальных обработчиков: без него работает
   * умолчание из кода, и стенд проверок поднимается без реестра. Но
   * передать его обязательно, иначе заказчица поставит в панели своё
   * число, а человек получит другое — на эту связку стоит страж.
   */
  settings?: SettingsRegistry,
  /** Шлюз веток — чтобы снятая в настройках сфера ушла из чата (E1). */
  gateway?: TopicGateway,
): void {
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
  async function showSettings(
    ctx: CallbackQueryContext<Context>,
    /** Что только что изменилось. Человек должен увидеть новое значение. */
    note?: string,
  ): Promise<void> {
    const active = await acting(ctx.from.id);
    if (!active) return;

    const [current] = await db
      .select({
        notificationsOn: userSettings.notificationsOn,
        quietHoursOn: userSettings.quietHoursOn,
        quietFrom: userSettings.quietFrom,
        quietTo: userSettings.quietTo,
        morningTime: userSettings.morningTime,
        eveningTime: userSettings.eveningTime,
        eveningOn: userSettings.eveningOn,
        preferredName: userSettings.preferredName,
      })
      .from(userSettings)
      .where(eq(userSettings.userId, active.userId))
      .limit(1);

    if (!current) return;

    const texts = active.texts;
    const mine = await listTopics(db, active.userId);

    const lines = [
      ...(note === undefined ? [] : [note, '']),
      texts.settings.title,
      '',
      current.notificationsOn ? texts.settings.remindersOn : texts.settings.remindersOff,
      current.quietHoursOn
        ? texts.settings.quietOn(shortTime(current.quietFrom), shortTime(current.quietTo))
        : texts.settings.quietOff,
      texts.settings.morningAt(shortTime(current.morningTime)),
      current.eveningOn
        ? texts.settings.eveningAt(shortTime(current.eveningTime))
        : texts.settings.eveningNever,
      texts.settings.cityIs(cityOfZone(active.timeZone) ?? active.timeZone),
      current.preferredName === null
        ? texts.settings.nameNone
        : texts.settings.nameIs(current.preferredName),
      texts.settings.topicsAre(mine.map((one) => one.name).join(', ')),
    ];

    const keyboard = fitKeyboard([
      [
        {
          label: current.notificationsOn
            ? texts.settings.buttonRemindersOff
            : texts.settings.buttonRemindersOn,
          action: MENU_ACTION.toggleReminders,
        },
      ],
      [
        {
          label: current.quietHoursOn
            ? texts.settings.buttonQuietOff
            : texts.settings.buttonQuietOn,
          action: MENU_ACTION.toggleQuiet,
        },
      ],
      [
        { label: texts.settings.buttonMorning, action: MENU_ACTION.askMorning },
        { label: texts.settings.buttonEvening, action: MENU_ACTION.askEvening },
      ],
      [
        { label: texts.settings.buttonCity, action: MENU_ACTION.askCity },
        { label: texts.settings.buttonName, action: MENU_ACTION.askName },
      ],
      [{ label: texts.settings.buttonTopics, action: MENU_ACTION.askTopics }],
      [{ label: texts.menu.buttonBack, action: MENU_ACTION.root }],
    ]);

    await show(ctx, lines.join(NEWLINE), keyboard);
  }

  /** Подэкран настройки: вопрос, свои кнопки и возврат в настройки. */
  async function askOnSettings(
    ctx: CallbackQueryContext<Context>,
    text: string,
    rows: readonly (readonly { readonly label: string; readonly action: string }[])[],
  ): Promise<void> {
    const active = await acting(ctx.from.id);
    if (!active) return;

    await show(
      ctx,
      text,
      fitKeyboard([
        ...rows,
        [{ label: active.texts.menu.buttonBack, action: MENU_ACTION.settings }],
      ]),
    );
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

    /**
     * Уже поставленные задания снимаем, планировщик разложит заново.
     *
     * Иначе настройка вступает в силу не сразу, а по мере устаревания
     * заданий — до полутора суток вперёд смотрит раскладка.
     */
    await dropPending(db, active.userId);

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

    await dropPending(db, active.userId);

    await showSettings(ctx);
  });

  // ── Настройки §12.1: времена, пояс, сферы, имя ────────────────────────
  /**
   * **Порядок объявления здесь значим.** grammY примеряет обработчики по
   * порядку, и «не надо вечером» подходит приставке вечернего времени
   * тоже. Точные объявлены раньше приставочных.
   */
  bot.callbackQuery(MENU_ACTION.askMorning, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    await askOnSettings(ctx, active.texts.settings.askMorning, [
      MORNING_TIMES.map((time) => ({
        label: time,
        action: `${MENU_ACTION.morningPrefix}${time}`,
      })),
      [{ label: active.texts.onboarding.buttonTimeOwn, action: MENU_ACTION.ownMorning }],
    ]);
  });

  bot.callbackQuery(MENU_ACTION.askEvening, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    await askOnSettings(ctx, active.texts.settings.askEvening, [
      EVENING_TIMES.map((time) => ({
        label: time,
        action: `${MENU_ACTION.eveningPrefix}${time}`,
      })),
      [
        { label: active.texts.onboarding.buttonTimeOwn, action: MENU_ACTION.ownEvening },
        { label: active.texts.onboarding.buttonEveningOff, action: MENU_ACTION.eveningOff },
      ],
    ]);
  });

  bot.callbackQuery(MENU_ACTION.askCity, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    await askOnSettings(ctx, active.texts.settings.askCity, [
      ...[0, 3, 6].map((from) =>
        TIMEZONES.slice(from, from + 3).map((one) => ({
          label: one.city,
          action: `${MENU_ACTION.cityPrefix}${one.zone}`,
        })),
      ),
      [{ label: active.texts.onboarding.buttonCityOwn, action: MENU_ACTION.ownCity }],
    ]);
  });

  /**
   * Имя и «своё время»/«свой город» — ввод словами.
   *
   * Ожидание своего вида, а не опросного: ответ на опросе двигает опрос
   * дальше, а правка настройки не должна двигать ничего.
   */
  bot.callbackQuery(MENU_ACTION.askName, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    await setAwaiting(db, active.userId, AWAITING.setName);
    await askOnSettings(ctx, active.texts.settings.askName, []);
  });

  bot.callbackQuery(MENU_ACTION.ownMorning, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    await setAwaiting(db, active.userId, AWAITING.setMorning);
    await askOnSettings(ctx, active.texts.onboarding.timeAsk, []);
  });

  bot.callbackQuery(MENU_ACTION.ownEvening, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    await setAwaiting(db, active.userId, AWAITING.setEvening);
    await askOnSettings(ctx, active.texts.onboarding.timeAsk, []);
  });

  bot.callbackQuery(MENU_ACTION.ownCity, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    await setAwaiting(db, active.userId, AWAITING.setCity);
    await askOnSettings(ctx, active.texts.onboarding.cityAsk, []);
  });

  bot.callbackQuery(MENU_ACTION.eveningOff, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    await setEvening(db, active.userId, null);
    logger.info({ userId: active.userId }, 'Вечерние напоминания выключены из настроек');

    await showSettings(ctx, active.texts.settings.savedEveningOff);
  });

  bot.callbackQuery(new RegExp(`^${MENU_ACTION.morningPrefix}`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    const time = ctx.callbackQuery.data.slice(MENU_ACTION.morningPrefix.length);

    // Значение из чужой кнопки в дело не идёт: список закрытый.
    if (!MORNING_TIMES.includes(time as (typeof MORNING_TIMES)[number])) return;

    await setMorning(db, active.userId, time);
    logger.info({ userId: active.userId, time }, 'Утреннее время изменено из настроек');

    await showSettings(ctx, active.texts.settings.savedMorning(time));
  });

  bot.callbackQuery(new RegExp(`^${MENU_ACTION.eveningPrefix}`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    const time = ctx.callbackQuery.data.slice(MENU_ACTION.eveningPrefix.length);

    if (!EVENING_TIMES.includes(time as (typeof EVENING_TIMES)[number])) return;

    await setEvening(db, active.userId, time);
    logger.info({ userId: active.userId, time }, 'Вечернее время изменено из настроек');

    await showSettings(ctx, active.texts.settings.savedEvening(time));
  });

  bot.callbackQuery(new RegExp(`^${MENU_ACTION.cityPrefix}`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    const zone = ctx.callbackQuery.data.slice(MENU_ACTION.cityPrefix.length);

    if (!TIMEZONES.some((one) => one.zone === zone)) return;

    /**
     * Сроки не пересчитываются, и это решение, а не упущение.
     *
     * Пересчёт положен только первому подтверждению: тогда пояс угадали
     * неверно, и сроки надо поправить. А человек, сменивший город здесь,
     * переехал — сроки, которые он называл раньше, были верны в тот
     * момент. Признак firstConfirmation у прошедшего опрос уже ложь, и
     * заведён он ровно для этой разницы.
     */
    await setTimezone(db, active.userId, zone);
    logger.info({ userId: active.userId, zone }, 'Пояс изменён из настроек');

    await showSettings(ctx, active.texts.settings.savedCity(cityOfZone(zone) ?? zone));
  });

  // ── Сферы: те же кнопки, что на опросе, но своим действием ────────────
  /** Что человек ведёт сейчас — из базы, а не из подписей клавиатуры. */
  async function myTopicNames(userId: string): Promise<readonly string[]> {
    return (await listTopics(db, userId)).map((one) => one.name);
  }

  async function showTopicsScreen(
    ctx: CallbackQueryContext<Context>,
    note?: string,
  ): Promise<void> {
    const active = await acting(ctx.from.id);
    if (!active) return;

    const mine = await myTopicNames(active.userId);

    await askOnSettings(ctx, note ?? active.texts.settings.askTopics, [
      ...topicRows(active.texts, mine, MENU_ACTION.topicSetPrefix),
      [{ label: active.texts.settings.buttonTopicsDone, action: MENU_ACTION.topicsSetDone }],
    ]);
  }

  bot.callbackQuery(MENU_ACTION.askTopics, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showTopicsScreen(ctx);
  });

  bot.callbackQuery(MENU_ACTION.topicsSetDone, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    const mine = await myTopicNames(active.userId);

    await showSettings(ctx, active.texts.settings.savedTopics(mine.join(', ')));
  });

  bot.callbackQuery(new RegExp(`^${MENU_ACTION.topicSetPrefix}`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    const name = ctx.callbackQuery.data.slice(MENU_ACTION.topicSetPrefix.length);

    if (!TOPIC_CHOICES.includes(name as (typeof TOPIC_CHOICES)[number])) return;

    const mine = await myTopicNames(active.userId);
    const has = mine.includes(name);

    /**
     * Убрать последнюю сферу нельзя.
     *
     * Классификация без списка не работает: записи ушли бы в никуда, а
     * человек узнал бы об этом по пустому разбору. Отказ называет причину.
     */
    if (has && mine.length === 1) {
      await showTopicsScreen(ctx, active.texts.settings.lastTopicKept);
      return;
    }

    if (has) {
      /**
       * Сферы вне предложенного списка не трогаем.
       *
       * Снятие убирает всё, чего нет в списке «оставить», поэтому свои
       * темы человека — заведённые не из этих девяти — обязаны в него
       * попасть. Иначе снятие одной галочки увозило бы в архив всё
       * остальное, что он вёл.
       *
       * Сфера уходит целиком — архив, перенос дел, ветка, сводки
       * (ревизия этапа 3, E1): раньше здесь был только архив, и дела
       * снятой сферы пропадали из «Все задачи», а ветка висела в чате.
       */
      await retireTopics(
        { db, logger, gateway },
        {
          userId: active.userId,
          keep: mine.filter((one) => one !== name),
          chatId: ctx.chat?.id,
        },
      );
    } else {
      await appendTopics(db, active.userId, [name], await settings?.number('maxTopics'));
    }

    logger.info({ userId: active.userId, topic: name, was: has }, 'Сфера переключена из настроек');

    await showTopicsScreen(ctx);
  });
  // ── Подсказки «как со мной говорить» §12.1 ───────────────────────────
  /**
   * Текст берётся у приветствия, а не пишется свой: подсказка одна и та
   * же, и две её копии однажды разошлись бы. Экран правится тот же —
   * меню это один экран, а не лента сообщений.
   */
  for (const [action, hint] of [
    [MENU_ACTION.hintVoice, (texts: TextProfile) => texts.start.hintVoice],
    [MENU_ACTION.hintText, (texts: TextProfile) => texts.start.hintText],
  ] as const) {
    bot.callbackQuery(action, async (ctx) => {
      await ctx.answerCallbackQuery();
      const active = await acting(ctx.from.id);
      if (!active) return;

      await show(ctx, hint(active.texts), backKeyboard(active.texts));
    });
  }

  // ── Проекты §12.1: список целей, внутри контекст и ближайший шаг ─────
  /**
   * Текст цели собирает `describeProject` — тот же, которым бот отвечает
   * на вопрос словами. Второй сборки здесь быть не должно: экран и ответ
   * обязаны говорить одно, иначе человек получит две разные правды об
   * одной цели.
   */
  bot.callbackQuery(MENU_ACTION.projects, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    const mine = await projectsOf(db, active.userId);
    const texts = active.texts;

    if (mine.length === 0) {
      await show(ctx, texts.menu.noProjects, backKeyboard(texts));
      return;
    }

    await show(
      ctx,
      texts.menu.projectsTitle,
      fitKeyboard([
        ...mine.map((item) => [
          {
            label: item.text,
            action: `${MENU_ACTION.projectPrefix}${toShortId(item.id)}`,
          },
        ]),
        [{ label: texts.menu.buttonBack, action: MENU_ACTION.root }],
      ]),
    );
  });

  /** Экран большой цели с ближайшими шагами — из «Больших целей» и с «Сделать сейчас». */
  const showProject = async (
    ctx: CallbackQueryContext<Context>,
    item: Item,
    texts: TextProfile,
  ): Promise<void> => {
    const context = await contextOf(db, item.id);

    await show(
      ctx,
      describeProject(item, context, texts),
      fitKeyboard([
        ...stepButtons(context.next, texts).map((button) => [button]),
        [{ label: texts.menu.buttonBack, action: MENU_ACTION.projects }],
      ]),
    );
  };

  bot.callbackQuery(new RegExp(`^${MENU_ACTION.projectPrefix}`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);
    if (!active) return;

    const code = ctx.callbackQuery.data.slice(MENU_ACTION.projectPrefix.length);
    const id = fromShortId(code);

    if (id === undefined) return;

    /**
     * Владелец проверяется запросом, а не кодом.
     *
     * Короткий код в `callback_data` не секретный: его можно подобрать.
     * Условие по человеку стоит здесь по той же причине, по которой оно
     * стоит у карточки записи — чужая цель открываться не должна.
     */
    const [item] = await db
      .select()
      .from(items)
      .where(and(eq(items.id, id), eq(items.userId, active.userId)))
      .limit(1);

    if (!item) return;

    await showProject(ctx, item, active.texts);
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

    /**
     * Один момент «сейчас» на весь заход.
     *
     * Прежде `new Date()` вызывался дважды: раз для силы, раз для
     * раскладки. Разойтись они могут на границе суток — и тогда список
     * собран за два разных дня. Стоит это ноль, а ловится годами.
     */
    const now = new Date();
    const day = { now, timeZone: context.timeZone };

    const today = selectForToday(await openItemsFor(db, active.userId), day);

    if (today.length === 0) {
      await show(ctx, active.texts.menu.todayEmpty, backKeyboard(active.texts));
      return;
    }

    /**
     * Шапка называет день, значит вчерашнее «завтра» на кнопке лишнее
     * (задача 3.78). Срезается только у дела, чей срок и есть сегодня.
     */
    await show(
      ctx,
      active.texts.menu.todayTitle,
      itemsKeyboard(
        active.texts,
        today.map((item) => ({ id: item.id, text: titleUnderDayHeader(item, day) })),
        MENU_ACTION.root,
        {
          index: page,
          action: (next) => `${MENU_ACTION.todayPage}${String(next)}`,
        },
      ),
    );
  };

  bot.callbackQuery(MENU_ACTION.today, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showToday(ctx, 0);
  });

  /**
   * «Продолжить старое» с экрана возвращения (§13.6) ведёт сюда же.
   *
   * §13.6 просит показать «актуальные записи и ближайшие шаги по
   * проектам» — это и есть список «Сегодня». Свой второй экран разъехался
   * бы с настоящим списком при первой же правке выдачи.
   */
  bot.callbackQuery(RETURNING_ACTION.keep, async (ctx) => {
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
   * Открывает карточку — не список, а именно карточку: у кнопки написано
   * «сделать», и человек должен оказаться там, где дело закрывается одним
   * нажатием.
   *
   * **Какую именно — говорит кнопка** (ревизия этапа 3, E2). Под ответом
   * на выгрузку она несёт код первого показанного дела: ответ строится
   * очередью выдачи с упомянутым в выгрузке, а «Сегодня» — другой, и
   * «первое на сегодня» под только что показанным списком оказывалось
   * не тем или пустым. Большая цель открывается своим экраном с шагами,
   * как из «Больших целей». Без кода («Продолжаем» и кнопки прежней
   * формы) — первое на сегодня, как раньше.
   */
  bot.callbackQuery(
    new RegExp(`^${ANSWER_ACTION.now}(?::([A-Za-z0-9_-]{22}))?$`, 'u'),
    async (ctx) => {
      await ctx.answerCallbackQuery();
      const active = await acting(ctx.from.id);
      if (!active) return;

      const code = ctx.match[1];
      if (code !== undefined) {
        const id = fromShortId(code);
        const [named] =
          id === undefined
            ? []
            : await db
                .select()
                .from(items)
                .where(and(eq(items.id, id), eq(items.userId, active.userId)))
                .limit(1);

        if (!named) {
          await show(ctx, active.texts.card.gone, backKeyboard(active.texts));
          return;
        }

        if (named.isProject) {
          await showProject(ctx, named, active.texts);
          return;
        }

        await show(
          ctx,
          cardText(named, active.texts, active.timeZone),
          cardKeyboard(named, active.texts, MENU_ACTION.root),
        );
        return;
      }

      const context = await outputContextOf(db, active.userId);
      const now = new Date();
      const today = selectForToday(await openItemsFor(db, active.userId), {
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
    },
  );

  /**
   * «Оставить на потом» (§13.2: закрывает сессию без упреков).
   *
   * Клавиатура снимается вместе с ответом: разговор закончен, и кнопки,
   * которые ведут обратно в него, тут не к месту.
   *
   * **А сводка остаётся.** Боевое 04.09.2026: человек прислал голосовое на
   * полторы минуты, бот разобрал семнадцать записей и показал три дела,
   * человек нажал «Оставить на потом» — и сводка **исчезла**, под
   * голосовым осталась одна строка «Всё на месте». Выглядело так, будто
   * бот не сделал ничего, и заказчик именно так это и прочёл.
   *
   * «Без упреков» значит без счёта накопившегося и без нового вопроса.
   * Стирать то, что человек только что увидел, §13.2 не просит: строка
   * прощания дописывается под сводку, а не вместо неё.
   */
  bot.callbackQuery(ANSWER_ACTION.later, async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = await acting(ctx.from.id);

    // Профиль текстов берётся человека, а если его нет — стандартный:
    // реплика короткая, и молчать вместо неё было бы хуже.
    const texts = active?.texts ?? textsFor(null);

    // Сообщение могло стать недоступным (слишком старое, удалено) — тогда
    // текста у него нет, и остаётся только прощание.
    const shown = ctx.msg?.text?.trim() ?? '';
    const farewell = texts.answer.laterAccepted;

    await ctx.editMessageText(shown === '' ? farewell : `${shown}\n\n${farewell}`);
  });
}

const NEWLINE = '\n';

/** «22:00:00» из базы человеку показывается как «22:00». */
function shortTime(value: string): string {
  return value.slice(0, 5);
}
