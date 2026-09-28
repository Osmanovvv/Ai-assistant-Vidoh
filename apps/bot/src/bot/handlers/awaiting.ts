import { InlineKeyboard, type Context } from 'grammy';
import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import { eq } from 'drizzle-orm';

import { items } from '../../db/schema.js';
import {
  AWAITING,
  awaitingOf,
  setAwaiting,
  setPreferredName,
} from '../../modules/onboarding/awaiting.js';
import { settingTime, spokenName } from '../../modules/onboarding/spoken-setting.js';
import { clockTimesIn, timeShiftIn } from '../../modules/classifier/clock-time.js';
import { saveDraft } from '../../modules/items/items.repo.js';
import { CLARIFY_REASON, hourClarifyCommand } from '../../modules/resolver/clarify.js';
import { clockOf } from '../../modules/scheduler/plan.js';
import { zoneOfCity } from '../../modules/onboarding/cities.js';
import { recalcDeadlines } from '../../modules/onboarding/backfill.js';
import {
  cityOfZone,
  finish,
  onboardingStateOf,
  questionFor,
  setTimezone,
  timezoneQuestion,
  setEvening,
  setMorning,
  setStep,
  STEP,
  type Question,
} from '../../modules/onboarding/onboarding.service.js';
import { fitKeyboard } from '../../modules/presenter/keyboard.js';
import { applyDecision, emptyChanges } from '../../modules/resolver/patch.js';
import { describeChange } from '../../modules/resolver/change-text.js';
import { changeKeyboard } from './undo.js';
import { outputContextOf } from '../../modules/users/state.repo.js';
import { reembedIfRetitled } from '../../modules/embedder/reembed.js';
import type { EmbeddingProvider } from '../../modules/embedder/providers/types.js';
import type { ModelPricing } from '../../modules/metering/pricing.js';
import type { SpendGuard } from '../../modules/metering/spend-guard.js';
import { textsFor } from '../../texts/index.js';
import type { CardSender } from '../../modules/cards/cards.js';

/**
 * Приём ответа словами (задача 3.61).
 *
 * Зовётся из `incomingMiddleware` **до** того, как сообщение попадёт в
 * буфер выгрузки. Возвращает `true`, если сообщение было ответом и
 * дальше идти ему не надо.
 *
 * **Пока бот ничего не ждёт, эта функция стоит один запрос в базу и
 * возвращает `false`.** Ни одна проверка, ни одна догадка о содержимом
 * не делается: путь сообщения остаётся прежним. Это главное требование к
 * ней — она стоит на горячем пути каждого входящего.
 *
 * **Не съедает молча.** Присланное не похоже на ответ — ожидание
 * снимается, человеку говорится, что бот не понял, и сообщение уходит в
 * разбор обычным путём. Мысль не теряется ни в одном случае.
 */

export interface AwaitingDeps {
  readonly db: Database;
  readonly logger: Logger;
  /** Бренд-карточки (ТЗ по визуалам 18.09.2026): карточка старта после опроса. */
  readonly cards?: CardSender | undefined;
  /** Вектор заголовка после правки словами (A5). */
  readonly embedder?: EmbeddingProvider | undefined;
  readonly spendGuard?: SpendGuard | undefined;
  readonly pricing?: Readonly<Record<string, ModelPricing>> | undefined;
  /**
   * Приём промокода словами (§14, задача 4.4).
   *
   * Обратным вызовом, а не зависимостями: чтобы проверить код, нужны
   * реестр цен и провайдеры оплаты, а приёму ответа про них знать нечего.
   * Собирается там же, где сам биллинг.
   *
   * Возвращает `true`, если код разобран (подошёл или честно отвергнут) —
   * тогда сообщение дальше не идёт. Не задан — ожидание снимается, и
   * сообщение идёт в разбор обычным путём, как до задачи.
   */
  readonly promo?: ((ctx: Context, userId: string, code: string) => Promise<boolean>) | undefined;
}

/**
 * Клавиатура вопроса опроса — общей раскладкой по ширине.
 *
 * Путь ответа словами показывает те же вопросы, что и путь кнопок, и
 * собственная сборка здесь была вторым таким же промахом: раскладка по
 * ширине телефона мимо, лишняя пустая строка в хвосте. Подробности — в
 * `onboarding.ts` над одноимённой функцией.
 *
 * Наружу — чтобы страж мерил ту же сборку, которой пользуется бот.
 */
export function keyboardOf(question: Question): InlineKeyboard {
  return fitKeyboard(question.rows);
}

/**
 * «Не понял» — вежливость на дороге к буферу, а не решение.
 *
 * Решение уже принято: ожидание снято, присланное — мысль, и дальше
 * оно идёт обычным путём (страховка 3 задачи 3.61). Но сама реплика —
 * отправка в Telegram, а сообщение к этому моменту уже сохранено и
 * ещё не привязано к выгрузке. Упади отправка — 429, 5xx, обрыв
 * посреди ответа; `retryOnConnectFailure` повторяет только отказ
 * соединения, — исключение уходило из приёма **до** привязки, и мысль
 * оставалась сиротой навсегда: повтор того же апдейта от Telegram
 * отбрасывается как дубль, потому что сообщение уже в базе (ревизия
 * этапов 1–2). Человек не получал ни «не понял», ни разбора, а в
 * журнале была одна общая строка «Сбой обработки апдейта».
 *
 * Поэтому отказ отправки здесь — строка в журнале с причиной, а не
 * исключение: мысль уходит в разбор, и «Слушаю» под выгрузкой скажет
 * человеку, что его услышали. Ловится только эта реплика, а не весь
 * приём ответа: сбой **после** того, как ответ принят, — имя сохранено,
 * а сказать об этом не вышло, — в буфер вести нельзя, иначе имя
 * станет выгрузкой и уйдёт модели за деньги.
 *
 * Таких отправок на дороге к буферу пять, и все обязаны идти через эту
 * функцию: «не понял» имя и время — четыре места ниже, «не похоже на
 * код» — приём промокода в `billing.ts`, подключённый сюда обратным
 * вызовом. Наружу она отдана ради него: вторая копия обёртки
 * разошлась бы с первой в том, что пишется в журнал.
 */
export async function sayNotUnderstood(
  ctx: Context,
  logger: Logger,
  userId: string,
  text: string,
): Promise<void> {
  try {
    await ctx.reply(text);
  } catch (error) {
    logger.warn({ err: error, userId }, 'Не удалось сказать «не понял», мысль идёт в разбор');
  }
}

export function consumeAwaited(deps: AwaitingDeps) {
  const { db, logger } = deps;

  /**
   * Следующий вопрос опроса — **новым сообщением**, а не правкой прежнего.
   *
   * Кнопки правят свою же реплику, и это верно: обмен один. Здесь человек
   * ответил сообщением, то есть в чате уже появилась его строка, и
   * править что-то выше неё значило бы ответить не туда, куда он смотрит.
   */
  async function askNext(ctx: Context, userId: string, step: number): Promise<void> {
    await setStep(db, userId, step);

    const state = await onboardingStateOf(db, userId);
    const question = questionFor(step, { texts: state.texts, name: state.name });
    if (!question) return;

    await ctx.reply(question.text, { reply_markup: keyboardOf(question) });
  }

  return async (ctx: Context, userId: string): Promise<boolean> => {
    const text = ctx.message?.text?.trim();
    if (text === undefined || text === '') return false;

    const state = await awaitingOf(db, userId);

    if (state.expired) {
      // Нажал и вернулся через сутки: это уже новая мысль, а не ответ.
      await setAwaiting(db, userId, null);
      return false;
    }

    const awaiting = state.awaiting;
    if (awaiting === undefined) return false;

    const texts = textsFor((await outputContextOf(db, userId)).textProfile);

    // ── Имя ──────────────────────────────────────────────────────────────
    if (awaiting.kind === 'name') {
      const name = spokenName(text);

      if (name === undefined) {
        await setAwaiting(db, userId, null);
        await sayNotUnderstood(ctx, logger, userId, texts.onboarding.nameNotUnderstood);
        return false;
      }

      await setPreferredName(db, userId, name);
      // Видно сразу, как теперь зовут: разбор имени строгий, но не
      // безошибочный, и промах человек должен заметить в ту же секунду.
      await ctx.reply(texts.onboarding.nameSaved(name));

      logger.info({ userId }, 'Имя задано словами');
      await askNext(ctx, userId, STEP.timezone);
      return true;
    }

    // ── Промокод словами (§14, задача 4.4) ───────────────────────────────
    if (awaiting.kind === 'promo') {
      /**
       * Ожидание снимается **до** разбора кода, а не после.
       *
       * Каждая попытка требует нового нажатия кнопки — это и есть всё
       * трение против перебора: приз перебора здесь скидка, а не деньги,
       * и ставить счётчик на код было бы хуже, чем не ставить ничего.
       * Счётчик на код позволил бы одному человеку сжечь код блогера для
       * всей его аудитории — тот же дефект уже был во входе в панель.
       */
      await setAwaiting(db, userId, null);

      if (deps.promo === undefined) return false;

      return await deps.promo(ctx, userId, text);
    }

    // ── Город словами ────────────────────────────────────────────────────
    if (awaiting.kind === 'city') {
      const zone = zoneOfCity(text);

      if (zone === undefined) {
        /**
         * Города нет в справочнике — говорим честно и возвращаем список.
         *
         * Догадка по созвучию здесь запрещена: неверный пояс ломает
         * человеку **все** сроки сразу. Подробности в `cities.ts`.
         */
        await setAwaiting(db, userId, null);
        await ctx.reply(texts.onboarding.cityNotFound);

        const again = timezoneQuestion(texts);
        await ctx.reply(again.text, { reply_markup: keyboardOf(again) });
        return true;
      }

      await setAwaiting(db, userId, null);
      const change = await setTimezone(db, userId, zone);

      /**
       * Пересчёт сроков первой выгрузки — как у кнопки (задача 2.14).
       *
       * Отказ пересчёта не должен ронять опрос: пояс сохранён, и следующий
       * вопрос человек получить обязан.
       */
      if (change.firstConfirmation && change.from !== change.to) {
        try {
          await recalcDeadlines(db, userId, change);
        } catch (error) {
          logger.error({ err: error, userId }, 'Не удалось пересчитать сроки под названный город');
        }
      }

      // Какое время выбрано — человеку видно: справочник неполон намеренно.
      await ctx.reply(texts.onboarding.citySaved(text.trim(), cityOfZone(zone) ?? zone));

      logger.info({ userId, zone }, 'Пояс задан названием города');
      await askNext(ctx, userId, STEP.morning);
      return true;
    }

    // ── Время напоминаний ────────────────────────────────────────────────
    if (awaiting.kind === 'morning' || awaiting.kind === 'evening') {
      // Словами и в свою половину суток: «в 9» вечером — 21:00 (docs/28, шаг 6).
      const time = settingTime(text, awaiting.kind);

      if (time === undefined) {
        await setAwaiting(db, userId, null);
        await sayNotUnderstood(ctx, logger, userId, texts.onboarding.timeNotUnderstood);
        return false;
      }

      await setAwaiting(db, userId, null);

      if (awaiting.kind === 'morning') {
        await setMorning(db, userId, time);
        await ctx.reply(texts.onboarding.morningSaved(time));
        logger.info({ userId, time }, 'Утреннее время задано словами');
        await askNext(ctx, userId, STEP.evening);
        return true;
      }

      // «Не пиши вечером» — вечерней сводки не будет.
      await setEvening(db, userId, time === 'off' ? null : time);
      await ctx.reply(
        time === 'off' ? texts.settings.savedEveningOff : texts.onboarding.eveningSaved(time),
      );
      logger.info({ userId, time }, 'Вечернее время задано словами');
      // Вечер — последний вопрос (правка заказчицы 14.09.2026, п. 1.1):
      // шага про сферы нет, опрос закрывается.
      await finish(db, userId, new Date());
      logger.info({ userId }, 'Онбординг пройден');
      await ctx.reply(texts.onboarding.finished);
      // Карточка старта — перед первой выгрузкой (ТЗ по визуалам, 01).
      const chatId = ctx.chat?.id;
      if (deps.cards !== undefined && chatId !== undefined) {
        await deps.cards.send({ chatId, card: 'start', caption: texts.cards.start });
      }
      return true;
    }

    // ── Правка настроек словами (§12.1) ──────────────────────────────────
    /**
     * То же, что на опросе, но человек уже прошёл его.
     *
     * Отличие одно и важное: `askNext` здесь не зовётся. Поправив время
     * через месяц, человек не должен снова оказаться в опросе — он менял
     * настройку, а не проходил знакомство.
     */
    if (
      awaiting.kind === AWAITING.setMorning ||
      awaiting.kind === AWAITING.setEvening ||
      awaiting.kind === AWAITING.setName ||
      awaiting.kind === AWAITING.setCity
    ) {
      await setAwaiting(db, userId, null);

      if (awaiting.kind === AWAITING.setName) {
        const name = spokenName(text);

        if (name === undefined) {
          await sayNotUnderstood(ctx, logger, userId, texts.onboarding.nameNotUnderstood);
          return false;
        }

        await setPreferredName(db, userId, name);
        await ctx.reply(texts.settings.savedName(name));
        logger.info({ userId }, 'Имя изменено из настроек');
        return true;
      }

      if (awaiting.kind === AWAITING.setCity) {
        const zone = zoneOfCity(text);

        if (zone === undefined) {
          // Догадка по созвучию запрещена: неверный пояс ломает все сроки.
          await ctx.reply(texts.onboarding.cityNotFound);
          return true;
        }

        const change = await setTimezone(db, userId, zone);

        /**
         * Сроки **не** пересчитываются, и это решение, а не упущение.
         *
         * Пересчёт нужен только первому подтверждению: тогда мы угадали
         * пояс неверно, и сроки надо поправить. А человек, сменивший
         * город в настройках, переехал — сроки, которые он называл
         * раньше, были верны в тот момент. Разница принципиальная, и
         * признак `firstConfirmation` для неё и заведён.
         */
        if (change.firstConfirmation && change.from !== change.to) {
          try {
            await recalcDeadlines(db, userId, change);
          } catch (error) {
            logger.error({ err: error, userId }, 'Не удалось пересчитать сроки под новый город');
          }
        }

        await ctx.reply(texts.settings.savedCity(cityOfZone(zone) ?? zone));
        logger.info({ userId, zone }, 'Пояс изменён из настроек');
        return true;
      }

      const time = settingTime(text, awaiting.kind === AWAITING.setMorning ? 'morning' : 'evening');

      if (time === undefined) {
        await sayNotUnderstood(ctx, logger, userId, texts.onboarding.timeNotUnderstood);
        return false;
      }

      if (awaiting.kind === AWAITING.setMorning) {
        await setMorning(db, userId, time);
        await ctx.reply(texts.settings.savedMorning(time));
        logger.info({ userId, time }, 'Утреннее время изменено из настроек');
        return true;
      }

      await setEvening(db, userId, time === 'off' ? null : time);
      await ctx.reply(
        time === 'off' ? texts.settings.savedEveningOff : texts.settings.savedEvening(time),
      );
      logger.info({ userId, time }, 'Вечернее время изменено из настроек');
      return true;
    }

    // ── Правка записи словами ────────────────────────────────────────────
    /**
     * Час словами после «Изменить время» (ТЗ проджекта 17.09.2026, шаг
     * 5). Читает код, без модели: только однозначный час — «10:30», «6
     * вечера»; голое «в 9» — просьба повторить, ожидание остаётся (его
     * снимает «Не менять», любая кнопка или срок ожидания). Голое «в 4» —
     * день, 16:00 (вариант Б, 24.09.2026): выбирает правка, как у голоса.
     */
    if (awaiting.kind === 'retime' && awaiting.itemId !== undefined) {
      /**
       * Час выбирает правка, как у голосового переноса (docs/28, шаг 6):
       * «в 8» у дела на 19:00 — 20:00, «на час позже» — 20:00, ночь
       * далеко — вопрос. Раньше годился только однозначный час.
       */
      if (clockTimesIn(text).length === 0 && timeShiftIn(text) === undefined) {
        await ctx.reply(texts.card.retimeNotUnderstood);
        return true;
      }

      await setAwaiting(db, userId, null);
      const context = await outputContextOf(db, userId);

      const outcome = await applyDecision(db, {
        userId,
        itemId: awaiting.itemId,
        action: 'update',
        mode: 'replace',
        changes: emptyChanges(),
        // Час резолвер берёт из слов — тех же, что человек написал.
        spoken: text,
        timeZone: context.timeZone,
        reason: 'час словами по кнопке «Изменить время»',
        changedBy: 'user',
      });

      /**
       * Два чтения часа, опереться не на что («в 7» у дела без часа, ночь
       * далеко) — вопрос «07:00 или 19:00?», и он помнится, как у голоса:
       * ответ «вечером» следом доделывает перенос (`clarify.ts`).
       */
      if (outcome.kind === 'unchanged' && outcome.timeUnclear !== undefined) {
        const [row] = await db
          .select({ text: items.text })
          .from(items)
          .where(eq(items.id, awaiting.itemId));
        if (row !== undefined) {
          await saveDraft(db, {
            userId,
            batchId: null,
            text: hourClarifyCommand(row.text, outcome.timeUnclear[0]),
            reason: CLARIFY_REASON.time,
          });
        }
        await ctx.reply(
          texts.resolver.timeUnclear(
            clockOf(outcome.timeUnclear[0]),
            clockOf(outcome.timeUnclear[1]),
          ),
        );
        return true;
      }

      if (outcome.kind !== 'applied') {
        await ctx.reply(outcome.kind === 'gone' ? texts.card.gone : texts.card.editNotApplied);
        return true;
      }

      logger.info({ userId, itemId: awaiting.itemId }, 'Час дела поправлен словами');

      await ctx.reply(
        describeChange(outcome.applied, texts, context.timeZone, undefined, new Date()),
        {
          reply_markup: changeKeyboard(outcome.applied, texts, text),
        },
      );

      return true;
    }

    if (awaiting.kind === 'edit' && awaiting.itemId !== undefined) {
      await setAwaiting(db, userId, null);

      /**
       * Правится **заголовок**, и только он.
       *
       * Статус и срок у карточки уже на кнопках, а разбирать «перенеси на
       * вторник» словами умеет резолвер на обычном пути. Здесь ровно то,
       * чего кнопкой сделать было нельзя: переписать текст дела.
       */
      const context = await outputContextOf(db, userId);

      const outcome = await applyDecision(db, {
        userId,
        itemId: awaiting.itemId,
        action: 'update',
        mode: 'replace',
        // Меняется один заголовок; остальные поля пустые, как их
        // присылает резолвер, когда правит только текст.
        changes: { ...emptyChanges(), text },
        spoken: text,
        timeZone: context.timeZone,
        reason: 'правка словами из карточки',
        changedBy: 'user',
      });

      if (outcome.kind !== 'applied') {
        // Записи нет или менять нечего: сказать честно и не трогать разбор.
        await ctx.reply(outcome.kind === 'gone' ? texts.card.gone : texts.card.editNotApplied);
        return true;
      }

      const { applied } = outcome;

      await reembedIfRetitled(
        {
          db,
          ...(deps.embedder === undefined ? {} : { provider: deps.embedder }),
          ...(deps.spendGuard === undefined ? {} : { spendGuard: deps.spendGuard }),
          ...(deps.pricing === undefined ? {} : { pricing: deps.pricing }),
          logger,
        },
        applied,
      );

      logger.info({ userId, itemId: awaiting.itemId }, 'Запись поправлена словами из карточки');

      await ctx.reply(describeChange(applied, texts, context.timeZone, undefined, new Date()), {
        reply_markup: changeKeyboard(applied, texts),
      });

      return true;
    }

    return false;
  };
}
