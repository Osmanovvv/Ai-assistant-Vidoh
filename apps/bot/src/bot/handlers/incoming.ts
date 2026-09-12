import type { Queue } from 'bullmq';
import { InlineKeyboard, type Context, type MiddlewareFn } from 'grammy';

import type { Database } from '../../infra/db.js';
import type { PipelineJob } from '../../infra/queue.js';
import { cancelBatchClose, enqueueUserProcessing, scheduleBatchClose } from '../../infra/queue.js';
import {
  DEFAULT_LIMITS,
  attachMessageToBatch,
  isOverDumpLimit,
  type BufferLimits,
} from '../../modules/buffer/buffer.service.js';
import { sellable } from '../../modules/billing/checkout.service.js';
import { accessOf } from '../../modules/billing/subscription.service.js';
import type { Rail } from '../../modules/billing/tariffs.js';
import { BILLING_ACTION } from './billing.js';
import { acceptUpdate } from '../../modules/gateway/gateway.service.js';
import { heldMessagesOf, markConsumed } from '../../modules/gateway/orphans.js';
import { effectiveLimits, type SettingsRegistry } from '../../modules/settings/settings.repo.js';
import { showStatus, type StatusSender } from '../../modules/presenter/status.service.js';
import { consentConfirmedOf } from '../../modules/users/users.repo.js';
import { textProfileOf } from '../../modules/users/settings.repo.js';
import { textsFor } from '../../texts/index.js';

/**
 * Приём входящего (задачи 1.9, 1.10, 1.12).
 *
 * Порядок здесь и есть инвариант §9.1 ТЗ: сначала сохраняем, потом думаем.
 * Ни одно обращение к модели и ни одна отправка ответа не происходит
 * раньше, чем сообщение легло в базу.
 */

/** Нажатие «Согласна»: обработчик живёт в `start.ts`, реплика — здесь и там. */
export const CONSENT_ACTION = { accept: 'consent:accept' } as const;

export interface IncomingDeps {
  readonly db: Database;
  readonly queue: Queue<PipelineJob>;
  /**
   * Адрес политики — для экрана согласия, который встречает сообщение,
   * присланное раньше нажатия «Согласна» (§16). Обязателен: гейт без
   * ссылки на политику просил бы согласиться неизвестно с чем.
   */
  readonly privacyPolicyUrl: string;
  readonly limits?: BufferLimits;
  /**
   * Системные значения: отсюда берётся размер пробного периода (4.3).
   *
   * Необязательна нарочно. Без неё гейт пробного периода не работает —
   * ровно так бот и жил до задачи 4.3, и так же он работает в тех
   * тестах, которые про пробный период ничего не проверяют. Молча
   * запирать человека при забытой зависимости было бы хуже всего.
   */
  readonly settings?: SettingsRegistry | undefined;
  /**
   * Отправитель статусного сообщения (задача 1.17). Без него бот молча
   * копит выгрузку и ничего не отвечает — так и было, пока модуль
   * существовал, но не был подключён.
   */
  readonly sender?: StatusSender | undefined;
  /**
   * Приём ответа словами (задача 3.61).
   *
   * Возвращает `true` — сообщение было ответом на вопрос бота, в буфер
   * выгрузки оно не идёт и разбором не становится.
   *
   * **Стоит перед буфером и потому обязано быть дешёвым.** Пока бот
   * ничего не ждёт, это один запрос в базу и `false`; ни одной догадки о
   * содержимом сообщения здесь не делается. Не задан — приём работает
   * ровно так, как до задачи.
   */
  readonly consume?: ((ctx: Context, userId: string) => Promise<boolean>) | undefined;
  /**
   * Рельсы оплаты, у которых есть провайдер (§14, задача 4.2).
   *
   * От них зависит, чем кончается пробный период: приглашением выбрать
   * тариф или сообщением «оплата ещё не открыта». Пустой список —
   * законное состояние, ровно в нём бот и жил до этой задачи, и обещать
   * оплату в нём было бы обманом.
   *
   * Наличия рельса недостаточно: цена задаётся в панели (§15.3), и
   * решение принимает `sellable` — одно место на кнопки и на это
   * приглашение.
   */
  readonly payRails?: readonly Rail[] | undefined;
}

/**
 * Команда — это управление ботом, а не мысль.
 *
 * Признак берётся из служебной разметки Telegram, а не из первого символа
 * текста: человек может начать мысль со слэша, и это будет мысль.
 */
function isCommand(ctx: Context): boolean {
  const entities = ctx.message?.entities;
  return entities?.some((entity) => entity.type === 'bot_command' && entity.offset === 0) ?? false;
}

/**
 * Служебное сообщение Telegram — не слова человека (задача 4.1).
 *
 * **Тихий дефект, который сработал бы в первый же день оплаты.** После
 * успешного платежа Telegram присылает обычный `message` — но без
 * текста и без подписи, только с полем `successful_payment`. Разбор
 * приёма относит такое к `kind: 'other'` (см. message-mapper.ts), а
 * дальше оно прицепляется к выгрузке как всякое сообщение. В выгрузке
 * говорить нечего, и человек, только что заплативший, получает от бота
 * «Я тебя не слышу» вместо доступа.
 *
 * Перечислением, а не правилом «нет текста — значит служебное».
 * Наклейка, фотография и кружок текста тоже не имеют, но их **сказал
 * человек**, и молчаливо менять на них поведение бота эта задача права
 * не имеет. Список растёт по мере надобности.
 *
 * Сообщение при этом уже сохранено: инвариант §9.1 «сначала сохраняем»
 * не нарушен — оно просто не становится выгрузкой. Дальше по цепочке
 * оно идёт: обработчик оплаты ждёт именно его.
 *
 * **В боевом порядке эта ветка не срабатывает, и так и задумано** —
 * уточнение ревизии четвёртого этапа. Обработчик оплаты регистрируется
 * **до** приёма (`index.ts`), значит служебное сообщение забирает он, и
 * до приёма оно не доходит вовсе. Ветка страхует **обратный** порядок:
 * перестановка регистрации не должна превращать сообщение о платеже в
 * «мысль человека», разобранную моделью.
 *
 * Прежде комментарий утверждал обратное — будто ветка работает в бою, —
 * и её четыре проверки мерили сборку, которой в бою нет. Сам порядок
 * теперь стережёт отдельная проверка: она собирает бот как `index.ts` и
 * убеждается, что апдейт оплаты до буфера не доезжает.
 */
function isServiceMessage(ctx: Context): boolean {
  const message = ctx.message;
  if (message === undefined) return false;

  return message.successful_payment !== undefined || message.refunded_payment !== undefined;
}

export function incomingMiddleware(deps: IncomingDeps): MiddlewareFn {
  const base = deps.limits ?? DEFAULT_LIMITS;

  return async (ctx, next) => {
    /**
     * Ограничения читаются на каждом сообщении, а не при подъёме
     * процесса (§15, задача 4.9).
     *
     * Условие готовности 4.9 названо про окно тишины: изменение из
     * админки применяется **без перезапуска**. Значение, прочитанное
     * один раз при старте, требовало бы выкладки — то есть ровно того,
     * от чего §15 избавляет. Кэш реестра делает это дешёвым: на горячем
     * пути один поход в память.
     */
    const limits = await effectiveLimits(deps.settings, base);

    const outcome = await acceptUpdate(deps.db, ctx.update);

    if (outcome.status === 'duplicate') {
      // Повторная доставка того же апдейта: дальше идти нельзя, иначе
      // обработчики отработают дважды.
      return;
    }

    if (outcome.status === 'ignored') {
      await next();
      return;
    }

    // Команда сохранена — она нужна для журнала и дедупликации, — но
    // дальше буфера не идёт. Иначе бот отвечает «Слушаю.» на
    // /delete_my_data, открывает под неё выгрузку и потом зачитывает
    // эту команду обратно как расшифровку. Так и было видно в чате.
    //
    // Согласием команда тоже не считается: §16 ТЗ говорит о первом
    // сообщении после экрана с политикой, а не о нажатии кнопки меню.
    if (isCommand(ctx)) {
      await next();
      return;
    }

    // Служебное сообщение Telegram — тоже не выгрузка: см. выше, иначе
    // человек сразу после оплаты слышит «я тебя не слышу».
    if (isServiceMessage(ctx)) {
      await next();
      return;
    }

    /**
     * Ответ на вопрос бота словами — до буфера (задача 3.61).
     *
     * Раньше ограничения частоты: человек, упёршийся в потолок выгрузок,
     * всё равно вправе назвать своё имя или время напоминания. И раньше
     * буфера: иначе ответ стал бы выгрузкой, а это ровно то, из-за чего
     * опрос был целиком на кнопках.
     *
     * Сообщение при этом уже сохранено — инвариант §9.1 «сначала
     * сохраняем» не нарушен, оно просто не привязывается к выгрузке.
     *
     * **Отказ внутри приёма ответа здесь не ловится, и это решение**
     * (ревизия этапов 1–2). Сообщение уже в базе, а к выгрузке ещё не
     * привязано, поэтому исключение отсюда оставляет его сиротой:
     * повтор апдейта от Telegram выше отброшен как дубль. Но «приём
     * ответа упал» не значит «это была мысль»: упади отправка после
     * того, как имя сохранено, провал в буфер отдал бы имя модели как
     * выгрузку — за деньги. Поэтому отправки на дороге к буферу —
     * «не понял» имя и время в приёме ответа (`awaiting.ts`) и «не
     * похоже на код» в приёме промокода (`billing.ts`) — стережёт
     * вызываемая сторона, одной обёрткой `sayNotUnderstood`, а не эта
     * строка.
     */
    if (deps.consume && (await deps.consume(ctx, outcome.userId))) {
      // Съедено — так и помечается, иначе строка без выгрузки навсегда
      // считалась бы сиротой (найдено на бою 12.09.2026).
      await markConsumed(deps.db, outcome.messageId);
      return;
    }

    /**
     * §16: без нажатой «Согласна» разбора нет (решение заказчицы
     * 12.09.2026, ответ 13).
     *
     * До этого согласием считалось первое сообщение после экрана с
     * политикой — оно записывалось здесь же. Теперь согласие даётся
     * только кнопкой (`start.ts`), а сообщение, присланное раньше,
     * **сохранено** (§9.1 «сначала сохраняем», §16 «ничего не теряется»)
     * и ждёт: после нажатия его подхватит `releaseHeldMessages`. Человеку
     * говорится, что слова на месте и чего не хватает, — с той же
     * кнопкой, чтобы не искать её под приветствием.
     *
     * Стоит после приёма ответа словами и до гейта доступа: ответ на
     * вопрос бота — не разбор, а человеку без согласия «пробный период
     * кончился» говорить рано — сначала согласие, потом всё остальное.
     */
    if (!(await consentConfirmedOf(deps.db, outcome.userId))) {
      const texts = textsFor(await textProfileOf(deps.db, outcome.userId));

      await ctx.reply(texts.consent.required(deps.privacyPolicyUrl), {
        reply_markup: new InlineKeyboard().text(texts.consent.button, CONSENT_ACTION.accept),
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
      });
      return;
    }

    /**
     * §14 ТЗ: пробный период кончился — новые выгрузки не заводим
     * (задача 4.3).
     *
     * **Здесь — но не только здесь** (правка ревизии четвёртого этапа).
     * §14 требует деградации «бэклог на чтение, новые выгрузки
     * блокируются», и главная точка запрета — эта: там, где сообщение
     * превращается в выгрузку. Меню, карточки и откаты идут мимо
     * законно: нажатие кнопки через приём сообщений не проходит вовсе
     * (`acceptUpdate` отдаёт «апдейт без сообщения»), команды
     * отсекаются выше, а ответ словами забирает `consume` — тоже выше.
     *
     * Но прежний комментарий объявлял мимо идущими **все** кнопки, и на
     * этом держалась дыра: кнопка «это новое» под старым вопросом ведёт
     * к настоящему разбору, то есть к деньгам. Теперь доступ спрашивают
     * два места — приём сообщений и этот кнопочный путь (`question.ts`),
     * — и оба тем же `accessOf`.
     *
     * **Раньше ограничения частоты**, потому что реплика точнее:
     * человеку, у которого кончился пробный период, «приходи завтра»
     * говорит неправду — завтра ничего не изменится.
     *
     * Сообщение при этом уже сохранено: §9.1 «сначала сохраняем» не
     * нарушен, и слова человека не потеряны — просто разбор по ним не
     * заводится. §14 прямо требует «данные не удаляются».
     *
     * **Вопрос словами тоже глушится, и это осознанная цена.** «Что там
     * на сегодня» отличается от новой мысли только намерением, а
     * намерение определяет маршрутизатор — то есть модель, то есть
     * деньги. Спрашивать модель у человека без доступа значит платить за
     * того, кто не платит. Ровно та же цена уже принята у потолка §10.5
     * (см. `limits.tooManyDumps`), и решается она тем же способом:
     * реплика называет путь к записям — `/menu`, — а команды и нажатия
     * кнопок гейт пропускает.
     */
    if (deps.settings !== undefined) {
      const access = await accessOf(deps.db, {
        userId: outcome.userId,
        settings: deps.settings,
      });

      if (!access.allowed) {
        const texts = textsFor(await textProfileOf(deps.db, outcome.userId));

        /**
         * Приглашение к оплате — только если оплата действительно есть.
         *
         * «Выберите тариф» без единого тарифа отправляет человека искать
         * кнопку, которой нет, и это худший конец пробного периода из
         * возможных. Поэтому предложение и кнопка появляются вместе, а
         * решает за обоих `sellable`: и провайдер, и назначенная цена.
         */
        const offers =
          deps.payRails === undefined || deps.payRails.length === 0
            ? []
            : await sellable(deps.settings, deps.payRails);

        /**
         * **Реплика по причине отказа**, а не одна на все случаи.
         *
         * Ревизия четвёртого этапа: человек, у которого кончилась
         * оплаченная подписка, читал «пробные разборы закончились» — про
         * пробный период, которого он не касался. То же получал тот,
         * кому вернули деньги, и тот, у кого не прошло продление. Для
         * платившего это не мелкая неточность: он решает, что бот забыл
         * его оплату.
         */
        const said =
          offers.length === 0
            ? texts.limits.trialOver
            : access.why === 'renewalFailed'
              ? texts.billing.renewalOver
              : access.why === 'expired'
                ? texts.billing.paidOver
                : texts.billing.trialOverWithOffer;

        await ctx.reply(said, {
          ...(offers.length === 0
            ? {}
            : {
                reply_markup: new InlineKeyboard().text(
                  texts.menu.buttonSubscription,
                  BILLING_ACTION.open,
                ),
              }),
        });

        return;
      }
    }

    // §10.5 ТЗ: ограничение частоты. Сообщение уже сохранено — мы просто
    // не заводим по нему разбор, а не выбрасываем текст.
    //
    // Проверка стоит до привязки, и потому обязана знать про открытую
    // выгрузку сама: сообщение в начатую серию потолок не глушит,
    // иначе тридцатая мысль разбиралась бы по первому голосовому, а
    // остальные оставались без выгрузки (см. `isOverDumpLimit`).
    if (await isOverDumpLimit(deps.db, outcome.userId, { limits })) {
      // Профиль спрашивается только там, где реплика действительно
      // уходит: это горячий путь, и лишний запрос на каждое сообщение
      // ради текста, который отправляется редко, не нужен.
      const texts = textsFor(await textProfileOf(deps.db, outcome.userId));
      await ctx.reply(texts.limits.tooManyDumps);
      return;
    }

    await bufferMessage(deps, {
      userId: outcome.userId,
      messageId: outcome.messageId,
      chatId: ctx.chat?.id,
      threadId: ctx.message?.message_thread_id,
      limits,
    });

    await next();
  };
}

/**
 * Сообщение — в буфер выгрузки: привязка, закрытие по тишине или сразу,
 * «Слушаю» на первое.
 *
 * Одной функцией на два входа: обычный приём и выпуск ждавших согласия
 * (`releaseHeldMessages`). Разъехавшись, они дали бы сообщение, которое
 * после кнопки привязано, но не закрывается или не подтверждается.
 */
async function bufferMessage(
  deps: IncomingDeps,
  params: {
    readonly userId: string;
    readonly messageId: string;
    readonly chatId: number | undefined;
    readonly threadId: number | undefined;
    readonly limits: BufferLimits;
  },
): Promise<void> {
  const { userId, limits } = params;

  const attached = await attachMessageToBatch(deps.db, {
    userId,
    messageId: params.messageId,
    limits,
  });

  if (attached.closed) {
    // Потолок по числу сообщений или по возрасту: обрабатываем сразу,
    // не дожидаясь тишины.
    await enqueueUserProcessing(deps.queue, userId);

    /**
     * И снимаем закрытие, поставленное предыдущим сообщением.
     *
     * Иначе оно висит до конца окна, просыпается над закрытой выгрузкой
     * и уходит ни с чем. Вреда от него нет — заход над закрытой
     * выгрузкой себя не переставляет, — но обещание `closeJobId`
     * («одно задание на выгрузку») без этой строки неправда: задание
     * живёт дольше самой выгрузки.
     */
    await cancelBatchClose(deps.queue, attached.batchId);
  } else {
    // Каждое новое сообщение отодвигает закрытие: серия голосовых —
    // это одна мысль (§9.1 правило 2 ТЗ).
    await scheduleBatchClose(deps.queue, {
      batchId: attached.batchId,
      userId,
      delayMs: limits.silenceWindowMs,
    });
  }

  // §10.2 ТЗ: приём подтверждается сразу, не дожидаясь разбора.
  // §9.2 ТЗ: пока идёт ожидание тишины, бот молчит — поэтому реплика
  // одна на выгрузку, а не на каждое сообщение. Ставится после
  // постановки заданий: медленный Telegram не должен задерживать
  // конвейер, а сбой отправки не должен мешать разбору.
  if (deps.sender && params.chatId !== undefined && attached.messageCount === 1) {
    const texts = textsFor(await textProfileOf(deps.db, userId));

    await showStatus(
      { db: deps.db, sender: deps.sender },
      {
        batchId: attached.batchId,
        chatId: params.chatId,
        threadId: params.threadId,
      },
      texts.listening.acknowledged,
    );
  }
}

/**
 * Выпуск сообщений, ждавших нажатия «Согласна» (§16, решение заказчицы
 * 12.09.2026): каждое уходит в буфер, как только что присланное, — в
 * порядке получения. Зовётся из обработчика кнопки (`start.ts`).
 * Возвращает число выпущенных — для журнала.
 */
export async function releaseHeldMessages(
  deps: IncomingDeps,
  params: { readonly userId: string; readonly chatId: number | undefined },
): Promise<number> {
  const held = await heldMessagesOf(deps.db, params.userId);
  if (held.length === 0) return 0;

  const limits = await effectiveLimits(deps.settings, deps.limits ?? DEFAULT_LIMITS);

  for (const message of held) {
    await bufferMessage(deps, {
      userId: params.userId,
      messageId: message.id,
      chatId: params.chatId,
      threadId: message.threadId ?? undefined,
      limits,
    });
  }

  return held.length;
}
