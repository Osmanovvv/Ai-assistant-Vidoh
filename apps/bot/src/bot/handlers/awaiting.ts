import { InlineKeyboard, type Context } from 'grammy';
import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import {
  AWAITING,
  awaitingOf,
  parseName,
  parseTime,
  setAwaiting,
  setPreferredName,
} from '../../modules/onboarding/awaiting.js';
import { zoneOfCity } from '../../modules/onboarding/cities.js';
import { recalcDeadlines } from '../../modules/onboarding/backfill.js';
import {
  cityOfZone,
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
import { applyDecision } from '../../modules/resolver/patch.js';
import { describeChange, undoButtons } from '../../modules/resolver/change-text.js';
import { outputContextOf } from '../../modules/users/state.repo.js';
import { textsFor } from '../../texts/index.js';

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
   */
  async function sayNotUnderstood(ctx: Context, userId: string, text: string): Promise<void> {
    try {
      await ctx.reply(text);
    } catch (error) {
      logger.warn({ err: error, userId }, 'Не удалось сказать «не понял», мысль идёт в разбор');
    }
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
      const name = parseName(text);

      if (name === undefined) {
        await setAwaiting(db, userId, null);
        await sayNotUnderstood(ctx, userId, texts.onboarding.nameNotUnderstood);
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
      const time = parseTime(text);

      if (time === undefined) {
        await setAwaiting(db, userId, null);
        await sayNotUnderstood(ctx, userId, texts.onboarding.timeNotUnderstood);
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

      await setEvening(db, userId, time);
      await ctx.reply(texts.onboarding.eveningSaved(time));
      logger.info({ userId, time }, 'Вечернее время задано словами');
      await askNext(ctx, userId, STEP.topics);
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
        const name = parseName(text);

        if (name === undefined) {
          await sayNotUnderstood(ctx, userId, texts.onboarding.nameNotUnderstood);
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

      const time = parseTime(text);

      if (time === undefined) {
        await sayNotUnderstood(ctx, userId, texts.onboarding.timeNotUnderstood);
        return false;
      }

      if (awaiting.kind === AWAITING.setMorning) {
        await setMorning(db, userId, time);
        await ctx.reply(texts.settings.savedMorning(time));
        logger.info({ userId, time }, 'Утреннее время изменено из настроек');
        return true;
      }

      await setEvening(db, userId, time);
      await ctx.reply(texts.settings.savedEvening(time));
      logger.info({ userId, time }, 'Вечернее время изменено из настроек');
      return true;
    }

    // ── Правка записи словами ────────────────────────────────────────────
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

      const applied = await applyDecision(db, {
        userId,
        itemId: awaiting.itemId,
        action: 'update',
        mode: 'replace',
        // Меняется один заголовок; остальные поля пустые, как их
        // присылает резолвер, когда правит только текст.
        changes: {
          note: '',
          text,
          deadline: '',
          deadlineAccuracy: 'none',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        spoken: text,
        timeZone: context.timeZone,
        reason: 'правка словами из карточки',
        changedBy: 'user',
      });

      if (applied === undefined) {
        // Записи нет или менять нечего: сказать честно и не трогать разбор.
        await ctx.reply(texts.card.editNotApplied);
        return true;
      }

      logger.info({ userId, itemId: awaiting.itemId }, 'Запись поправлена словами из карточки');

      await ctx.reply(describeChange(applied, texts, context.timeZone), {
        reply_markup: new InlineKeyboard(
          undoButtons(applied.revisionId, texts).map((button) => [
            { text: button.label, callback_data: button.action },
          ]),
        ),
      });

      return true;
    }

    return false;
  };
}
