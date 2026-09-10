import { readFile } from 'node:fs/promises';

import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, billingSubscriptions, messagesRaw } from '../../db/schema.js';
import { BILLING_ACTION, registerBillingHandlers, registerPaySupportCommands } from './billing.js';
import type { Rail } from '../../modules/billing/tariffs.js';
import { createLogger } from '../../infra/logger.js';
import type { Context } from 'grammy';
import type { StatusSender } from '../../modules/presenter/status.service.js';
import { SettingsRegistry, putSetting } from '../../modules/settings/settings.repo.js';
import type { PipelineJob } from '../../infra/queue.js';
import { DEFAULT_LIMITS } from '../../modules/buffer/buffer.service.js';
import { upsertUser } from '../../modules/users/users.repo.js';
import { testDb } from '../../test/db.js';
import { defaultTexts } from '../../texts/index.js';
import { incomingMiddleware } from './incoming.js';

/**
 * Потолок выгрузок за сутки через настоящий обработчик (задача 1.12).
 *
 * Условие готовности задачи звучит так: «31-я выгрузка за сутки **вежливо**
 * отклоняется». Проверено было только слово «отклоняется» — тесты на
 * `isOverDumpLimit` считают выгрузки и возвращают да/нет. А «вежливо» —
 * то есть человек получает ответ, а не тишину, и его сообщение при этом
 * не пропадает — не проверял никто.
 *
 * Разрыв ровно того же вида, на котором уже попадалось статусное
 * сообщение: модуль есть, тест на модуль зелёный, а в боте связка не
 * работает.
 */

const TG_ID = 7373;

interface ApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

const stubQueue = {
  getJob: () => Promise.resolve(undefined),
  add: () => Promise.resolve({}),
} as unknown as Queue<PipelineJob>;

let seq = 0;
let userId: string;

/**
 * Записывающий статусный отправитель.
 *
 * Нужен там, где проверяется **отсутствие** реплики: без него приём
 * молчит всегда (`deps.sender` не задан, incoming.ts:179), и проверка
 * «бот ничего не ответил» проходила бы и на сломанном коде. Именно так
 * и случилось при первом заходе — диверсия её не свалила.
 */
function recordingStatus(): { sender: StatusSender; said: string[] } {
  const said: string[] = [];

  return {
    said,
    sender: {
      send: ({ text }) => {
        said.push(text);
        return Promise.resolve(said.length);
      },
      edit: ({ text }) => {
        said.push(text);
        return Promise.resolve();
      },
    },
  };
}

interface BotOptions {
  readonly sender?: StatusSender | undefined;
  /** Реестр значений: без него гейт пробного периода не работает (4.3). */
  readonly settings?: SettingsRegistry | undefined;
  /** Приём ответа словами — он стоит выше гейта (задача 3.61). */
  readonly consume?: ((ctx: Context, userId: string) => Promise<boolean>) | undefined;
  /**
   * Включённые рельсы оплаты (задача 4.2).
   *
   * Без них конец пробного периода не приглашает платить — и это
   * правильно: приглашение без единого тарифа отправляет человека искать
   * кнопку, которой нет. Проверки ниже мерят **обе** стороны этого «и».
   */
  readonly payRails?: readonly Rail[] | undefined;
}

function createTestBot(options: BotOptions = {}): { bot: Bot; calls: ApiCall[] } {
  const botInfo = {
    id: 1,
    is_bot: true,
    first_name: 'ВЫДОХ',
    username: 'vydoh_test_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  } as unknown as UserFromGetMe;

  const bot = new Bot('123456789:TESTTESTTESTTESTTESTTESTTESTTEST', { botInfo });
  const calls: ApiCall[] = [];

  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload });

    return Promise.resolve({
      ok: true,
      result: { message_id: calls.length, date: 0, chat: { id: TG_ID, type: 'private' } },
    } as never);
  });

  bot.use(
    incomingMiddleware({
      db: testDb(),
      queue: stubQueue,
      ...(options.sender === undefined ? {} : { sender: options.sender }),
      ...(options.settings === undefined ? {} : { settings: options.settings }),
      ...(options.consume === undefined ? {} : { consume: options.consume }),
      ...(options.payRails === undefined ? {} : { payRails: options.payRails }),
    }),
  );

  return { bot, calls };
}

function textUpdate(text: string): Update {
  seq++;

  return {
    update_id: 700_000 + seq,
    message: {
      message_id: seq,
      date: Math.floor(Date.UTC(2026, 7, 27) / 1000),
      chat: { id: TG_ID, type: 'private', first_name: 'Аня' },
      from: { id: TG_ID, is_bot: false, first_name: 'Аня' },
      text,
    },
  } as unknown as Update;
}

/**
 * Команда — то же сообщение, но с разметкой сущности.
 *
 * Без `entities` grammY считает это обычным текстом, и проверка «команды
 * потолок пропускает» проверяла бы не то.
 */
function commandUpdate(command: string): Update {
  const update = textUpdate(command) as Update & {
    message: { entities?: unknown[] };
  };

  update.message.entities = [{ type: 'bot_command', offset: 0, length: command.length }];

  return update;
}

/**
 * Нажатие кнопки. Через приём сообщений оно не идёт — но проверить это
 * надо на настоящем апдейте, а не на предположении: гейт стоит в общем
 * мидлваре, через который проходит любой апдейт.
 */
function callbackUpdate(data: string): Update {
  seq++;

  return {
    update_id: 700_000 + seq,
    callback_query: {
      id: String(seq),
      from: { id: TG_ID, is_bot: false, first_name: 'Аня' },
      chat_instance: 'test',
      data,
      message: { message_id: seq, date: 0, chat: { id: TG_ID, type: 'private' } },
    },
  } as unknown as Update;
}

/** Уже состоявшиеся выгрузки этих суток. */
async function seedDumps(count: number): Promise<void> {
  if (count === 0) return;

  await testDb()
    .insert(batches)
    .values(
      Array.from({ length: count }, () => ({
        userId,
        status: 'done' as const,
        closedAt: new Date(),
        processedAt: new Date(),
      })),
    );
}

async function dumpCount(): Promise<number> {
  const rows = await testDb()
    .select({ id: batches.id })
    .from(batches)
    .where(eq(batches.userId, userId));
  return rows.length;
}

beforeEach(async () => {
  seq = 0;
  const user = await upsertUser(testDb(), { tgId: TG_ID, firstName: 'Аня' });
  userId = user.id;
});

describe('потолок выгрузок за сутки', () => {
  it('31-я выгрузка отклоняется, и человеку это сказано словами', async () => {
    await seedDumps(30);

    const { bot, calls } = createTestBot();
    await bot.handleUpdate(textUpdate('купить продукты'));

    const replies = calls.filter((call) => call.method === 'sendMessage');
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload['text']).toBe(defaultTexts.limits.tooManyDumps);
  });

  it('отклонённое сообщение не теряется: сначала сохраняем, потом думаем', async () => {
    // §9.1 ТЗ. Потолок — причина не заводить разбор, а не причина
    // выбросить слова человека.
    await seedDumps(30);

    const { bot } = createTestBot();
    await bot.handleUpdate(textUpdate('записать сына к врачу'));

    const saved = await testDb().select().from(messagesRaw).where(eq(messagesRaw.userId, userId));
    expect(saved).toHaveLength(1);
    expect(saved[0]?.text).toBe('записать сына к врачу');
  });

  it('новая выгрузка при этом не заводится', async () => {
    await seedDumps(30);

    const { bot } = createTestBot();
    await bot.handleUpdate(textUpdate('купить продукты'));

    expect(await dumpCount()).toBe(30);
  });

  it('команды потолок пропускает — путь к записям не закрыт', async () => {
    /**
     * Реплика о потолке говорит человеку: «посмотреть можно через
     * /menu». Если бы потолок глушил и команды, эта фраза была бы
     * ложью, а человек — заперт от собственных записей до утра.
     *
     * Найдено живым прогоном 03.09.2026: на вопрос «что у меня на
     * сегодня?» бот ответил про потолок. Вопрос действительно упирается
     * в потолок — проверка стоит до разбора, — но записи при этом
     * доступны, и реплика обязана на них указать.
     */
    await seedDumps(30);

    const { bot, calls } = createTestBot();
    await bot.handleUpdate(commandUpdate('/menu'));

    const refusals = calls.filter(
      (call) => call.payload['text'] === defaultTexts.limits.tooManyDumps,
    );
    expect(refusals).toHaveLength(0);
  });

  it('реплика о потолке называет путь к записям', () => {
    // Иначе она тупик: человек не знает, что его дела на месте и видны.
    expect(defaultTexts.limits.tooManyDumps).toContain('/menu');
  });

  it('тридцатая ещё принимается: граница там, где написано', async () => {
    // Проверка самой границы, а не только того, что она где-то есть.
    // Ошибка на единицу здесь означала бы отказ человеку, у которого
    // право ещё было.
    await seedDumps(29);

    const { bot, calls } = createTestBot();
    await bot.handleUpdate(textUpdate('купить продукты'));

    const refusals = calls.filter(
      (call) => call.payload['text'] === defaultTexts.limits.tooManyDumps,
    );
    expect(refusals).toHaveLength(0);
    expect(await dumpCount()).toBe(30);
  });
});

/**
 * Служебное сообщение об оплате: обычный `message` без текста, только с
 * полем `successful_payment`. Ровно то, что Telegram пришлёт после
 * платежа.
 */
function paymentUpdate(): Update {
  const update = textUpdate('') as Update & {
    message: { text?: string | undefined; successful_payment?: unknown };
  };

  delete update.message.text;
  update.message.successful_payment = {
    currency: 'XTR',
    total_amount: 1,
    invoice_payload: 'подписка:месяц',
    telegram_payment_charge_id: 'charge-1',
    provider_payment_charge_id: '',
  };

  return update;
}

describe('служебное сообщение об оплате не становится выгрузкой (задача 4.1)', () => {
  /**
   * **Тихий дефект, который сработал бы в первый же день оплаты.**
   * У служебного сообщения нет ни текста, ни подписи, поэтому приём
   * относит его к `kind: 'other'` и прицепляет к выгрузке как всякое
   * сообщение. Говорить в такой выгрузке нечего — и человек, только
   * что заплативший, получает «Я тебя не слышу» вместо доступа.
   *
   * Модель здесь не нужна: всё решается до буфера.
   */
  it('выгрузка по нему не открывается', async () => {
    const { bot } = createTestBot();

    await bot.handleUpdate(paymentUpdate());

    expect(await dumpCount()).toBe(0);
  });

  it('но сохранено оно всё равно — §9.1 «сначала сохраняем»', async () => {
    const { bot } = createTestBot();

    await bot.handleUpdate(paymentUpdate());

    const saved = await testDb().select().from(messagesRaw).where(eq(messagesRaw.userId, userId));
    expect(saved).toHaveLength(1);
    expect(saved[0]?.batchId).toBeNull();
  });

  it('и «Слушаю» под ним не появляется', async () => {
    /**
     * «Слушаю» под служебным сообщением — тот же обман, что «я тебя не
     * слышу»: человек не говорил, отвечать нечего.
     *
     * Со **своим** отправителем, а не с общим харнесом: без него приём
     * молчит всегда, и первая версия этой проверки прошла под
     * диверсией — то есть не мерила ничего.
     */
    const { sender, said } = recordingStatus();
    const { bot } = createTestBot({ sender });

    await bot.handleUpdate(paymentUpdate());
    expect(said).toEqual([]);

    // А на словах человека «Слушаю» быть обязано: иначе проверка
    // прошла бы и на боте, который молчит всегда.
    await bot.handleUpdate(textUpdate('купить продукты'));
    expect(said).toHaveLength(1);
  });

  it('обычное сообщение по-прежнему становится выгрузкой', async () => {
    // Обратная сторона: проверка не должна отсечь слова человека.
    const { bot } = createTestBot();

    await bot.handleUpdate(textUpdate('купить продукты'));

    expect(await dumpCount()).toBe(1);
  });
});

/** Выгрузки, потратившие пробный период. */
async function seedTrialSpent(count: number): Promise<void> {
  if (count === 0) return;

  await testDb()
    .insert(batches)
    .values(
      Array.from({ length: count }, () => ({
        userId,
        status: 'done' as const,
        closedAt: new Date(),
        processedAt: new Date(),
        trialCountedAt: new Date(),
      })),
    );
}

/** Реестр значений с заданным размером пробного периода. */
async function trialOf(limit: number): Promise<SettingsRegistry> {
  await putSetting(testDb(), { name: 'trialDumps', value: String(limit) });

  return new SettingsRegistry({ db: testDb(), ttlMs: 0 });
}

describe('пробный период и деградация (§14, задача 4.3)', () => {
  /**
   * §14 ТЗ: «Пробный период ограничен количеством выгрузок, а не днями.
   * После окончания доступа бэклог остаётся доступен на чтение, новые
   * выгрузки блокируются. Данные не удаляются.»
   *
   * Проверяется каждая из трёх частей — и обратная сторона каждой:
   * блокировка не должна запирать чтение, а слова человека не должны
   * теряться на границе.
   */

  it('пока пробный период есть — выгрузка заводится', async () => {
    await seedTrialSpent(2);
    const settings = await trialOf(10);

    const { bot } = createTestBot({ settings });
    await bot.handleUpdate(textUpdate('купить продукты'));

    expect(await dumpCount()).toBe(3);
  });

  it('граница там, где написано: последняя бесплатная проходит', async () => {
    /**
     * Ошибка на единицу здесь означала бы отказ человеку, у которого
     * право ещё было, — и наоборот, лишний бесплатный разбор за наши
     * деньги. Поэтому проверяется сама граница, а не «где-то рядом».
     */
    await seedTrialSpent(2);
    const settings = await trialOf(3);

    const { bot, calls } = createTestBot({ settings });
    await bot.handleUpdate(textUpdate('купить продукты'));

    expect(await dumpCount()).toBe(3);
    expect(calls.map((call) => call.payload['text'])).not.toContain(defaultTexts.limits.trialOver);
  });

  it('следующая за границей — блокируется', async () => {
    await seedTrialSpent(3);
    const settings = await trialOf(3);

    const { bot, calls } = createTestBot({ settings });
    await bot.handleUpdate(textUpdate('купить продукты'));

    // Новой выгрузки нет: посеянные три остались тремя.
    expect(await dumpCount()).toBe(3);
    expect(calls.map((call) => call.payload['text'])).toContain(defaultTexts.limits.trialOver);
  });

  it('и слова человека при этом сохранены — §9.1 и §14 «данные не удаляются»', async () => {
    await seedTrialSpent(3);
    const settings = await trialOf(3);

    const { bot } = createTestBot({ settings });
    await bot.handleUpdate(textUpdate('купить продукты'));

    const saved = await testDb().select().from(messagesRaw).where(eq(messagesRaw.userId, userId));

    expect(saved).toHaveLength(1);
    expect(saved[0]?.text).toBe('купить продукты');
    // Сохранено, но к выгрузке не привязано: разбор по нему не заводим.
    expect(saved[0]?.batchId).toBeNull();
  });

  it('реплика про пробный период, а не «приходи завтра»', async () => {
    /**
     * Человеку, у которого кончился пробный период, «на сегодня
     * достаточно, разберу завтра» говорит неправду: завтра ничего не
     * изменится. Поэтому гейт стоит раньше ограничения частоты.
     */
    await seedTrialSpent(3);
    await seedDumps(30);
    const settings = await trialOf(3);

    const { bot, calls } = createTestBot({ settings });
    await bot.handleUpdate(textUpdate('купить продукты'));

    const said = calls.map((call) => call.payload['text']);

    expect(said).toContain(defaultTexts.limits.trialOver);
    expect(said).not.toContain(defaultTexts.limits.tooManyDumps);
  });

  /**
   * Реплика на границе — четыре проверки, названные ревизией этапа.
   *
   * До ревизии здесь мерилась одна реплика из четырёх: `limits.trialOver`
   * («пробные разборы закончились»). Три остальные — приглашение к
   * тарифу, «оплаченный период кончился» и «продление не прошло» —
   * появились с задачей 4.2 и остались без единой проверки, хотя
   * различить их важнее всего именно платившему: он читал «пробные
   * разборы закончились» и решал, что бот забыл его оплату.
   *
   * Обстановка у всех четырёх одна: пробный исчерпан. Разница — в том,
   * что есть **кроме** него: тариф и история подписок.
   */
  describe('какими словами гейт отказывает (§14, задача 4.2; ревизия этапа)', () => {
    /** Тариф за рубли на рельсе Робокассы: приглашению нужны оба. */
    async function withPrice(limit: number): Promise<SettingsRegistry> {
      await putSetting(testDb(), { name: 'trialDumps', value: String(limit) });
      await putSetting(testDb(), { name: 'priceMonthlyRub', value: '39900' });

      return new SettingsRegistry({ db: testDb(), ttlMs: 0 });
    }

    /** Строка подписки, срок которой уже вышел. */
    async function seedPastSubscription(status: 'canceled' | 'past_due'): Promise<void> {
      await testDb()
        .insert(billingSubscriptions)
        .values({
          provider: 'robokassa',
          userId,
          plan: 'monthly',
          status,
          currentPeriodEnd: new Date(Date.now() - 24 * 3_600_000),
        });
    }

    /** Что уехало человеку: текст и кнопки под ним. */
    function replyOf(calls: readonly ApiCall[]): {
      readonly text: unknown;
      readonly buttons: string;
    } {
      const reply = calls.find((call) => call.method === 'sendMessage');

      return {
        text: reply?.payload['text'],
        buttons: JSON.stringify(reply?.payload['reply_markup'] ?? {}),
      };
    }

    it('пробный кончился, а тариф есть — приглашение с кнопкой подписки', async () => {
      await seedTrialSpent(3);
      const settings = await withPrice(3);

      const { bot, calls } = createTestBot({ settings, payRails: ['robokassa:smz'] });
      await bot.handleUpdate(textUpdate('купить продукты'));

      const said = replyOf(calls);

      expect(said.text).toBe(defaultTexts.billing.trialOverWithOffer);
      expect(said.buttons).toContain(BILLING_ACTION.open);
      expect(said.buttons).toContain(defaultTexts.menu.buttonSubscription);

      // И выгрузка при этом всё равно не заводится: приглашение платить
      // не значит «пропустим разок».
      expect(await dumpCount()).toBe(3);
    });

    it('рельс включён, а цена не задана — приглашения нет вовсе', async () => {
      /**
       * Обратная сторона того же «и»: рельс без цены продавать нечем.
       * «Выберите тариф» здесь было бы обещанием без товара — ровно то
       * состояние, в котором бот и живёт до назначения цен в панели.
       */
      await seedTrialSpent(3);
      const settings = await trialOf(3);

      const { bot, calls } = createTestBot({ settings, payRails: ['robokassa:smz'] });
      await bot.handleUpdate(textUpdate('купить продукты'));

      const said = replyOf(calls);

      expect(said.text).toBe(defaultTexts.limits.trialOver);
      expect(said.buttons).not.toContain(BILLING_ACTION.open);
    });

    it('кончился оплаченный период — реплика про оплату, а не про пробный', async () => {
      /**
       * Платившему «пробные разборы закончились» читается как «бот забыл
       * мою оплату». Причина берётся из истории подписок, а не
       * угадывается: строка остаётся и после конца периода.
       */
      await seedTrialSpent(3);
      await seedPastSubscription('canceled');
      const settings = await withPrice(3);

      const { bot, calls } = createTestBot({ settings, payRails: ['robokassa:smz'] });
      await bot.handleUpdate(textUpdate('купить продукты'));

      const said = replyOf(calls);

      expect(said.text).toBe(defaultTexts.billing.paidOver);
      expect(said.text).not.toBe(defaultTexts.billing.trialOverWithOffer);
      expect(said.buttons).toContain(BILLING_ACTION.open);
    });

    it('продление не прошло — сказано именно это', async () => {
      /**
       * `past_due` отличается от истёкшей подписки тем, что человек
       * продлеваться **хотел**: списание сорвалось. Предложить ему
       * «оплаченный период кончился» значило бы умолчать о том, что
       * чинится с его стороны — картой, а не выбором тарифа.
       */
      await seedTrialSpent(3);
      await seedPastSubscription('past_due');
      const settings = await withPrice(3);

      const { bot, calls } = createTestBot({ settings, payRails: ['robokassa:smz'] });
      await bot.handleUpdate(textUpdate('купить продукты'));

      expect(replyOf(calls).text).toBe(defaultTexts.billing.renewalOver);
    });
  });

  it('ноль в настройке означает «пробного периода нет вовсе»', async () => {
    const settings = await trialOf(0);

    const { bot, calls } = createTestBot({ settings });
    await bot.handleUpdate(textUpdate('купить продукты'));

    expect(await dumpCount()).toBe(0);
    expect(calls.map((call) => call.payload['text'])).toContain(defaultTexts.limits.trialOver);
  });

  it('без реестра значений поведение прежнее — гейта нет', async () => {
    /**
     * Зависимость необязательна нарочно: так бот жил до этой задачи, и
     * так же он работает в тех тестах, которые про пробный период
     * ничего не проверяют. Молча запирать человека при забытой
     * зависимости было бы худшим из поведений.
     */
    /**
     * Двенадцать, а не сто: умолчание пробного периода — десять, то есть
     * с реестром двенадцатая трата уже заперла бы человека, а суточный
     * потолок §10.5 (тридцать) до этого числа не дотягивается. Первая
     * версия проверки посеяла девяносто девять и упёрлась в суточный
     * потолок — то есть мерила не гейт, а соседа.
     */
    await seedTrialSpent(12);

    const { bot } = createTestBot();
    await bot.handleUpdate(textUpdate('купить продукты'));

    expect(await dumpCount()).toBe(13);
  });

  it('нажатие кнопки проходит: деградация — это чтение без записи', async () => {
    /**
     * §14 требует, чтобы бэклог остался доступен на чтение. Меню,
     * карточки и откаты живут на нажатиях кнопок, а они через приём
     * сообщений не идут вовсе — но это надо доказать, а не предположить:
     * гейт стоит в общем мидлваре, через который проходит **любой**
     * апдейт.
     */
    await seedTrialSpent(3);
    const settings = await trialOf(3);

    const { bot, calls } = createTestBot({ settings });
    await bot.handleUpdate(callbackUpdate('i:done:AAAAAAAAAAAAAAAAAAAAAA'));

    // Ни отказа, ни новой выгрузки: апдейт ушёл дальше, к обработчикам.
    expect(calls.map((call) => call.payload['text'])).not.toContain(defaultTexts.limits.trialOver);
    expect(await dumpCount()).toBe(3);
  });

  it('вопрос словами тоже глушится — и реплика называет путь к записям', async () => {
    /**
     * Осознанная цена, а не пропуск. «Что там на сегодня» отличается от
     * новой мысли только намерением, а намерение определяет модель —
     * значит деньги. Платить за того, кто не платит, нельзя.
     *
     * Ровно та же цена принята у потолка §10.5, и решается тем же:
     * реплика называет `/menu`, а команды и кнопки гейт пропускает.
     * Тест держит и цену, и её оправдание — иначе однажды кто-то
     * «починит» это, добавив вызов маршрутизатора без доступа.
     */
    await seedTrialSpent(3);
    const settings = await trialOf(3);

    const { bot, calls } = createTestBot({ settings });
    await bot.handleUpdate(textUpdate('что там на сегодня'));

    expect(calls.map((call) => call.payload['text'])).toContain(defaultTexts.limits.trialOver);
    // Тупика нет: путь к записям назван прямо в реплике.
    expect(defaultTexts.limits.trialOver).toContain('/menu');
  });

  it('команда проходит: путь к записям остаётся открыт', async () => {
    // Иначе реплика «посмотреть можно через /menu» — обман: сама
    // команда упёрлась бы в тот же гейт.
    await seedTrialSpent(3);
    const settings = await trialOf(3);

    const { bot, calls } = createTestBot({ settings });
    await bot.handleUpdate(commandUpdate('/menu'));

    expect(calls.map((call) => call.payload['text'])).not.toContain(defaultTexts.limits.trialOver);
  });

  it('ответ словами на вопрос бота проходит', async () => {
    /**
     * Человек, у которого кончился пробный период, всё равно вправе
     * назвать своё имя или время напоминания: `consume` стоит выше
     * гейта. Иначе открытый вопрос бота стал бы тупиком.
     */
    await seedTrialSpent(3);
    const settings = await trialOf(3);

    let consumed = 0;
    const { bot, calls } = createTestBot({
      settings,
      consume: () => {
        consumed++;
        return Promise.resolve(true);
      },
    });

    await bot.handleUpdate(textUpdate('в девять утра'));

    expect(consumed).toBe(1);
    expect(calls.map((call) => call.payload['text'])).not.toContain(defaultTexts.limits.trialOver);
  });
});

describe('настройка применяется на лету — условие готовности 4.9', () => {
  /**
   * §15: числа продукта меняются «без выкладки новой версии». Условие
   * готовности задачи 4.9 названо про окно тишины именно потому, что
   * оно читается на **горячем пути**: если бы его запомнили при подъёме
   * процесса, правка требовала бы перезапуска — то есть выкладки.
   *
   * Проверяется наблюдаемое последствие: задание на закрытие выгрузки
   * ставится с новой задержкой, и **без перезапуска чего бы то ни было**.
   */

  /** Задержки, с которыми ставились задания на закрытие выгрузки. */
  function recordingQueue(): { queue: Queue<PipelineJob>; delays: number[] } {
    const delays: number[] = [];

    return {
      delays,
      queue: {
        getJob: () => Promise.resolve(undefined),
        add: (_name: string, _data: unknown, options?: { delay?: number }) => {
          if (options?.delay !== undefined) delays.push(options.delay);
          return Promise.resolve({});
        },
      } as unknown as Queue<PipelineJob>,
    };
  }

  it('окно тишины из настроек доходит до задания, а не берётся из кода', async () => {
    const settings = new SettingsRegistry({ db: testDb(), ttlMs: 60_000 });
    const { queue, delays } = recordingQueue();

    const bot = new Bot('123456789:TESTTESTTESTTESTTESTTESTTESTTEST', {
      botInfo: {
        id: 1,
        is_bot: true,
        first_name: 'ВЫДОХ',
        username: 'vydoh_test_bot',
      } as unknown as UserFromGetMe,
    });

    bot.api.config.use(() =>
      Promise.resolve({
        ok: true,
        result: { message_id: 1, date: 0, chat: { id: TG_ID, type: 'private' } },
      } as never),
    );

    bot.use(incomingMiddleware({ db: testDb(), queue, settings }));

    // Умолчание из кода: тридцать секунд.
    await bot.handleUpdate(textUpdate('первая мысль'));
    expect(delays.at(-1)).toBe(30_000);

    /**
     * Правка — и **никакого перезапуска**: ни процесса, ни мидлвара, ни
     * бота. Сброс кэша делает панель после записи; здесь он вызван
     * напрямую, потому что панель тут не участвует.
     */
    await putSetting(testDb(), { name: 'silenceWindowMs', value: '5000' });
    settings.forget();

    await bot.handleUpdate(textUpdate('вторая мысль'));

    expect(delays.at(-1)).toBe(5_000);
  });

  it('суточный потолок из настроек тоже действует сразу', async () => {
    await putSetting(testDb(), { name: 'dumpsPerDay', value: '1' });

    const settings = new SettingsRegistry({ db: testDb(), ttlMs: 0 });
    await seedDumps(1);

    const { bot, calls } = createTestBot({ settings });
    await bot.handleUpdate(textUpdate('купить продукты'));

    expect(calls.map((call) => call.payload['text'])).toContain(defaultTexts.limits.tooManyDumps);
  });
});

describe('обращение по /paysupport попадает в базу (ревизия четвёртого этапа)', () => {
  /**
   * **Порядок регистрации стоил обращения человека.** Команды платёжной
   * платформы жили вместе с оплатой, а оплата регистрируется **до**
   * приёма сообщений: служебное сообщение о платеже иначе уехало бы в
   * буфер выгрузки. Из-за этого `/paysupport` отвечал, а сообщения не
   * оставалось — ни в выгрузке, ни в `messages_raw`.
   *
   * Цена: реплика `/paysupport` обещает «напишите сюда же словами,
   * разберёмся и вернём деньги, если списалось лишнее», а обращение,
   * которым человек воспользовался этим приглашением, не сохранялось.
   */
  it('сообщение с командой сохраняется, а ответ уходит', async () => {
    const { bot, calls } = createTestBot();

    registerPaySupportCommands(bot, {
      db: testDb(),
      settings: new SettingsRegistry({ db: testDb(), ttlMs: 0 }),
      logger: createLogger({ level: 'silent' }),
      providers: {},
    });

    await bot.init();
    // Через `commandUpdate`: без разметки сущности grammY считает это
    // обычным текстом, и `bot.command` до обработчика не доходит.
    await bot.handleUpdate(commandUpdate('/paysupport'));

    // Ответ ушёл: правила Telegram требуют отвечать.
    const said = calls
      .filter((one) => one.method === 'sendMessage')
      .map((one) => String(one.payload['text']));

    expect(said.join('\n')).toContain('оплат');

    // И само обращение — в базе: инвариант «сначала сохраняем».
    const saved = await testDb().select().from(messagesRaw);

    expect(saved.map((one) => one.text)).toContain('/paysupport');
  });

  it('в сборке бота команды платёжной платформы стоят после приёма', async () => {
    /**
     * **Страж порядка, а не поведения.** Проверка выше подключает приём
     * сама и потому пройдёт при любом порядке в `index.ts` — а дефект
     * был именно там: команды регистрировались внутри оплаты, то есть до
     * приёма. Здесь читается сборка.
     */
    const source = await readFile('src/index.ts', 'utf8');

    const intake = source.indexOf('incomingMiddleware(');
    const commands = source.indexOf('registerPaySupportCommands(');

    expect(intake, 'приём не найден в сборке').toBeGreaterThan(0);
    expect(commands, 'команды платёжной платформы не найдены в сборке').toBeGreaterThan(0);

    expect(
      commands,
      [
        'Команды /paysupport, /terms и /support зарегистрированы ДО приёма сообщений.',
        'Тогда обращение человека не попадёт в базу: ответ уйдёт, а сообщения не останется.',
        'Реплика при этом обещает «напишите сюда же словами, разберёмся и вернём деньги».',
      ].join('\n'),
    ).toBeGreaterThan(intake);
  });
});

describe('порядок регистрации: служебное сообщение об оплате не доезжает до буфера', () => {
  /**
   * **Ревизия четвёртого этапа: страж мерил сборку, которой в бою нет.**
   *
   * Ветка «служебное сообщение — не выгрузка» в приёме существует, и
   * четыре проверки её измеряют. Но в боевом порядке она не срабатывает
   * вовсе: обработчик оплаты регистрируется **до** приёма, значит
   * служебное сообщение забирает он. Комментарий при этом утверждал
   * обратное.
   *
   * Ветка остаётся — она страхует обратный порядок, — а вот сам порядок
   * не был закреплён ничем: перестановка двух строк в `index.ts` тихо
   * отправила бы сообщение о платеже в буфер выгрузки, и модель
   * разобрала бы его как мысль человека.
   */
  it('в боевом порядке оплата забирается до приёма: выгрузки не появляется', async () => {
    const botInfo = {
      id: 1,
      is_bot: true,
      first_name: 'ВЫДОХ',
      username: 'vydoh_test_bot',
    } as unknown as UserFromGetMe;

    const bot = new Bot('123456789:TESTTESTTESTTESTTESTTESTTESTTEST', { botInfo });
    const calls: ApiCall[] = [];

    bot.api.config.use((_prev, method, payload) => {
      calls.push({ method, payload });

      return Promise.resolve({
        ok: true,
        result: { message_id: calls.length, date: 0, chat: { id: TG_ID, type: 'private' } },
      } as never);
    });

    // **Тот же порядок, что в сборке**: сперва оплата, потом приём.
    registerBillingHandlers(bot, {
      db: testDb(),
      settings: new SettingsRegistry({ db: testDb(), ttlMs: 0 }),
      logger: createLogger({ level: 'silent' }),
      providers: {},
    });

    bot.use(incomingMiddleware({ db: testDb(), queue: stubQueue }));

    await bot.init();
    await bot.handleUpdate(paymentUpdate());

    // Выгрузки нет: сообщение о платеже до буфера не доехало.
    expect(await testDb().select().from(batches)).toEqual([]);

    /**
     * И в `messages_raw` его тоже нет — так и должно быть.
     *
     * §9.1 «сначала сохраняем» про **слова человека**, а служебное
     * сообщение об оплате написал Telegram: человек нажал кнопку. Сам
     * платёж записан там, где ему место, — в событиях оплаты, вымаранных
     * от личного (§16).
     */
    expect(await testDb().select().from(messagesRaw)).toEqual([]);
  });

  it('страж порядка читает сборку: оплата объявлена раньше приёма', async () => {
    /**
     * Проверка выше собирает бот сама и потому пройдёт при любом порядке
     * в `index.ts` — а дефект был бы именно там. Здесь читается сборка.
     */
    const source = await readFile('src/index.ts', 'utf8');

    const billing = source.indexOf('registerBillingHandlers(');
    const intake = source.indexOf('incomingMiddleware(');

    expect(billing, 'оплата не найдена в сборке').toBeGreaterThan(0);
    expect(intake, 'приём не найден в сборке').toBeGreaterThan(0);

    expect(
      billing,
      [
        'Обработчик оплаты объявлен ПОСЛЕ приёма сообщений.',
        'Тогда служебное сообщение о платеже уедет в буфер выгрузки,',
        'и модель разберёт его как мысль человека.',
      ].join('\n'),
    ).toBeLessThan(intake);
  });
});

describe('осиротевшее закрытие снимается вместе с выгрузкой', () => {
  /**
   * Потолок сообщений закрывает выгрузку прямо в приёме, а отложенное
   * закрытие от предыдущего сообщения остаётся висеть до конца окна.
   *
   * Вреда от него больше нет — заход над закрытой выгрузкой себя не
   * переставляет (ревизия этапов 1–2), — но обещание `closeJobId` «одно
   * задание на выгрузку» без снятия неправда: задание живёт дольше самой
   * выгрузки, просыпается над чужим и ходит в базу зря. А главное: пока
   * оно висит, у следующей выгрузки того же человека закрытие идёт уже
   * не своим путём.
   */

  it('закрытая потолком выгрузка снимает своё отложенное задание', async () => {
    // Потолок сообщений настройкой не объявлен (§15 его не просит) и живёт
    // умолчанием в коде — поэтому он приходит сюда параметром.
    const limits = { ...DEFAULT_LIMITS, maxMessagesPerBatch: 2 };

    const removed: string[] = [];
    const jobs = new Map<string, { remove: () => Promise<void> }>();

    const queue = {
      getJob: (id: string) => Promise.resolve(jobs.get(id)),
      add: (_name: string, _data: unknown, options?: { jobId?: string }) => {
        const id = options?.jobId;

        if (id !== undefined) {
          jobs.set(id, {
            remove: () => {
              removed.push(id);
              jobs.delete(id);
              return Promise.resolve();
            },
          });
        }

        return Promise.resolve({});
      },
    } as unknown as Queue<PipelineJob>;

    const settings = new SettingsRegistry({ db: testDb(), ttlMs: 0 });
    const bot = new Bot('123456789:TESTTESTTESTTESTTESTTESTTESTTEST', {
      botInfo: {
        id: 1,
        is_bot: true,
        first_name: 'ВЫДОХ',
        username: 'vydoh_test_bot',
      } as unknown as UserFromGetMe,
    });

    bot.api.config.use(() =>
      Promise.resolve({
        ok: true,
        result: { message_id: 1, date: 0, chat: { id: TG_ID, type: 'private' } },
      } as never),
    );

    bot.use(incomingMiddleware({ db: testDb(), queue, settings, limits }));

    // Первое сообщение ставит закрытие по тишине.
    await bot.handleUpdate(textUpdate('первая мысль'));
    expect(jobs.size, 'закрытие по тишине не поставлено').toBe(1);

    // Второе упирается в потолок: выгрузка уходит в разбор сразу.
    await bot.handleUpdate(textUpdate('вторая мысль'));

    expect(removed, 'задание закрытия осталось висеть над закрытой выгрузкой').toHaveLength(1);
    expect(jobs.size).toBe(0);
  });
});
