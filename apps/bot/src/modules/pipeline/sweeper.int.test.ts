import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, items, messagesRaw, pendingQuestions, telegramUpdates } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { attachMessageToBatch } from '../buffer/buffer.service.js';
import { askQuestion } from '../resolver/questions.repo.js';
import { confirmConsent, upsertUser } from '../users/users.repo.js';
import { sweepOnce } from './sweeper.js';

/**
 * Досмотр застрявших выгрузок.
 *
 * Проверяется то, ради чего он появился: выгрузка, о которой очередь
 * забыла, всё равно доходит до обработки — без перезапуска сервиса.
 */

const logger = createLogger({ level: 'silent' });

/**
 * Исход прохода этой проверке неинтересен — но объявить его надо.
 *
 * Поле обязательное нарочно: необязательное означало бы «досмотр умеет
 * молчать», а это ровно тот отказ, который чинили. Здесь молчание
 * названо вслух, а не забыто.
 */
const ignoreOutcome = (): void => undefined;

const T0 = new Date('2026-08-25T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

let userId: string;
let seq = 0;

beforeEach(async () => {
  const user = await upsertUser(testDb(), { tgId: 800, firstName: 'Аня' });
  userId = user.id;
  // Согласие нажато: сообщения до него — не сироты, а ждущие (§16).
  await confirmConsent(testDb(), userId, { edition: '2026-10-01' });
  seq = 0;
});

/** Открытая выгрузка с одним сообщением, полученным в заданный момент. */
async function openBatchAt(offsetMs: number): Promise<string> {
  seq++;
  const [row] = await testDb()
    .insert(messagesRaw)
    .values({
      userId,
      updateId: 8000 + seq,
      tgChatId: 800,
      tgMessageId: seq,
      kind: 'text',
      text: 'мысль',
      receivedAt: at(offsetMs),
    })
    .returning({ id: messagesRaw.id });

  const attached = await attachMessageToBatch(testDb(), {
    userId,
    messageId: row!.id,
    now: at(offsetMs),
  });

  return attached.batchId;
}

async function statusOf(batchId: string): Promise<string | undefined> {
  const [row] = await testDb()
    .select({ status: batches.status })
    .from(batches)
    .where(eq(batches.id, batchId));
  return row?.status;
}

describe('sweepOnce', () => {
  it('подбирает выгрузку, о которой очередь забыла', async () => {
    // Ровно тот случай, ради которого досмотр появился: после перезапуска
    // Redis воркер перестал разбирать отложенные задания, и выгрузка
    // висела бы открытой вечно.
    const batchId = await openBatchAt(0);
    const processed: string[] = [];

    const result = await sweepOnce({
      onOutcome: ignoreOutcome,
      db: testDb(),
      logger,
      // Тишина уже прошла: последнее сообщение было минуту назад.
      now: () => at(60_000),
      process: (id) => {
        processed.push(id);
        return Promise.resolve();
      },
    });

    expect(result.closed).toBe(1);
    expect(processed).toEqual([userId]);
    expect(await statusOf(batchId)).toBe('queued');
  });

  it('не трогает выгрузку, в которую только что писали', async () => {
    // Иначе досмотр закрывал бы мысль на полуслове.
    const batchId = await openBatchAt(0);
    const processed: string[] = [];

    const result = await sweepOnce({
      onOutcome: ignoreOutcome,
      db: testDb(),
      logger,
      now: () => at(5_000),
      process: (id) => {
        processed.push(id);
        return Promise.resolve();
      },
    });

    expect(result.users).toBe(0);
    expect(processed).toEqual([]);
    expect(await statusOf(batchId)).toBe('open');
  });

  it('возвращает в очередь выгрузку, застрявшую в обработке', async () => {
    const batchId = await openBatchAt(0);
    await testDb().update(batches).set({ status: 'processing' }).where(eq(batches.id, batchId));

    const result = await sweepOnce({
      onOutcome: ignoreOutcome,
      db: testDb(),
      logger,
      // Потолок обработки три минуты; четыре — точно застряла (задача 3.58).
      now: () => at(4 * 60_000),
      process: () => Promise.resolve(),
    });

    expect(result.requeued).toBe(1);
    expect(await statusOf(batchId)).toBe('queued');
  });

  it('живую обработку не трогает', async () => {
    /**
     * Боевое 04.09.2026, 18:25:31: досмотр вернул в очередь выгрузку,
     * разбор которой шёл и закончился через четыре секунды. Замок на
     * пользователя спас от двойного ответа, но журнал врал «очередь
     * забыла».
     */
    const batchId = await openBatchAt(0);
    await testDb().update(batches).set({ status: 'processing' }).where(eq(batches.id, batchId));

    const result = await sweepOnce({
      onOutcome: ignoreOutcome,
      db: testDb(),
      logger,
      now: () => at(60_000),
      process: () => Promise.resolve(),
    });

    expect(result.requeued).toBe(0);
    expect(await statusOf(batchId)).toBe('processing');
  });

  it('на пустой базе ничего не делает и никого не будит', async () => {
    const processed: string[] = [];

    const result = await sweepOnce({
      onOutcome: ignoreOutcome,
      db: testDb(),
      logger,
      process: (id) => {
        processed.push(id);
        return Promise.resolve();
      },
    });

    // Уборка на пустой базе тоже проходит — и говорит «убрал ноль», а не
    // молчит: `null` здесь означал бы, что она сорвалась.
    expect(result).toEqual({
      requeued: 0,
      closed: 0,
      users: 0,
      pruned: 0,
      expiredQuestions: 0,
      orphanedMessages: 0,
    });
    expect(processed).toEqual([]);
  });

  it('сбой на одном пользователе не останавливает остальных', async () => {
    // Досмотр — последний рубеж. Если он падает на первом же споткнувшемся
    // пользователе, остальные так и остаются без ответа.
    const first = await upsertUser(testDb(), { tgId: 801, firstName: 'Первая' });
    const second = await upsertUser(testDb(), { tgId: 802, firstName: 'Вторая' });

    for (const [index, user] of [first, second].entries()) {
      const [row] = await testDb()
        .insert(messagesRaw)
        .values({
          userId: user.id,
          updateId: 8100 + index,
          tgChatId: 801 + index,
          tgMessageId: 900 + index,
          kind: 'text',
          text: 'мысль',
          receivedAt: at(0),
        })
        .returning({ id: messagesRaw.id });

      await attachMessageToBatch(testDb(), { userId: user.id, messageId: row!.id, now: at(0) });
    }

    const seen: string[] = [];

    const result = await sweepOnce({
      onOutcome: ignoreOutcome,
      db: testDb(),
      logger,
      now: () => at(60_000),
      process: (id) => {
        seen.push(id);
        return seen.length === 1
          ? Promise.reject(new Error('база моргнула'))
          : Promise.resolve(undefined);
      },
    });

    expect(result.users).toBe(2);
    expect(seen).toHaveLength(2);
  });

  it('подбирает выгрузку, оставшуюся в очереди без задания', async () => {
    // Временный сбой возвращает выгрузку в очередь. Если задание при этом
    // потерялось, подобрать её больше некому — кроме досмотра.
    const batchId = await openBatchAt(0);
    await testDb().update(batches).set({ status: 'queued' }).where(eq(batches.id, batchId));

    const processed: string[] = [];

    const result = await sweepOnce({
      onOutcome: ignoreOutcome,
      db: testDb(),
      logger,
      process: (id) => {
        processed.push(id);
        return Promise.resolve();
      },
    });

    expect(result.users).toBe(1);
    expect(processed).toEqual([userId]);
  });
});

describe('уборка за собой', () => {
  /**
   * Ревизия этапов 1–2, находка 6 и её близнец.
   *
   * `pruneUpdates` и `expireQuestions` были написаны, покрыты зелёными
   * тестами и не звались ниоткуда. Обе ждали планировщика (задача 3.14),
   * которого в продукте нет, — и обе оказались тем самым «написано,
   * покрыто тестами и недостижимо».
   *
   * Проверяется здесь не сама уборка — её проверяют тесты у себя дома, —
   * а **связка**: что уборка случается на живом повторяющемся проходе.
   */

  it('чистит журнал апдейтов старше суток, свежие не трогает', async () => {
    /**
     * Сутки набраны здесь вручную, а не взяты из `UPDATE_LOG_RETENTION_MS`:
     * возьми проверка боевую константу — и подмена срока на неделю сдвинула
     * бы вместе с ним границу самой проверки. Страж, зеленеющий от
     * диверсии, хуже отсутствующего.
     */
    const DAY_MS = 24 * 60 * 60_000;

    await testDb()
      .insert(telegramUpdates)
      .values([
        { updateId: 8_900_001, receivedAt: at(-DAY_MS - 60_000) },
        { updateId: 8_900_002, receivedAt: at(-DAY_MS + 60_000) },
      ]);

    // Ни одной выгрузки: проход тихий, и уборка обязана случиться всё
    // равно — иначе она стоит после раннего возврата.
    const result = await sweepOnce({
      onOutcome: ignoreOutcome,
      db: testDb(),
      logger,
      now: () => T0,
      process: () => Promise.resolve(),
    });

    const left = await testDb()
      .select({ updateId: telegramUpdates.updateId })
      .from(telegramUpdates);

    expect(
      left.map((one) => one.updateId),
      'из журнала ушло не то: сутки — это граница, а не «всё» и не «ничего»',
    ).toEqual([8_900_002]);

    expect(result.pruned).toBe(1);
  });

  it('закрывает протухший вопрос, не дожидаясь человека', async () => {
    /**
     * `openQuestionOf` закрывает такой вопрос при первом же обращении
     * человека. У ушедшего человека обращения не будет: в панели его
     * вопрос висит открытым вечно, а доля исходов «время вышло» занижена
     * ровно на таких людей.
     */
    // Выгрузка вопроса уже разобрана: уборка нарочно не трогает вопрос
    // той, что разбирают прямо сейчас.
    const [batch] = await testDb()
      .insert(batches)
      .values({ userId, status: 'done' })
      .returning({ id: batches.id });

    const [item] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Записать сына к врачу в четверг',
        type: 'TASK',
        priority: 'SOON',
        topic: 'здоровье',
      })
      .returning({ id: items.id });

    await askQuestion(testDb(), {
      userId,
      itemId: item?.id ?? '',
      batchId: batch?.id ?? '',
      segment: 'нет, в пятницу',
      action: 'update',
      changes: {
        note: '',
        text: '',
        deadline: '2026-09-04',
        deadlineAccuracy: 'day',
        recurrenceKind: 'none',
        recurrenceInterval: 0,
        recurrenceText: '',
      },
      // Вопрос заведён сутки назад: к T0 его шестичасовой срок давно вышел.
      now: at(-24 * 60 * 60_000),
    });

    const result = await sweepOnce({
      onOutcome: ignoreOutcome,
      db: testDb(),
      logger,
      now: () => T0,
      process: () => Promise.resolve(),
    });

    const [row] = await testDb().select().from(pendingQuestions);

    expect(row?.outcome, 'протухший вопрос остался открытым').toBe('timeout');
    expect(row?.resolvedAt).not.toBeNull();
    expect(result.expiredQuestions).toBe(1);
  });

  it('сорвавшаяся уборка не оставляет человека без ответа и не молчит', async () => {
    /**
     * Уборка стоит внутри последнего рубежа. Упади она — и человек остался
     * бы без разбора вовсе, а это дороже любой таблицы.
     *
     * Наверх при этом уходит `null`, а не ноль: пустая колонка в этом
     * проекте читается как факт, и сорвавшаяся чистка, отданная нулём, была
     * бы неотличима от честного «убирать было нечего».
     */
    const batchId = await openBatchAt(0);
    await testDb().update(batches).set({ status: 'queued' }).where(eq(batches.id, batchId));

    const live = testDb();
    const broken = new Proxy(live, {
      get(target, key, receiver) {
        if (key === 'delete') {
          return () => {
            throw new Error('база отказала');
          };
        }

        return Reflect.get(target, key, receiver) as unknown;
      },
    });

    const processed: string[] = [];

    const result = await sweepOnce({
      onOutcome: ignoreOutcome,
      db: broken,
      logger,
      now: () => T0,
      process: (id) => {
        processed.push(id);
        return Promise.resolve();
      },
    });

    expect(processed, 'упавшая уборка унесла с собой весь проход').toEqual([userId]);
    expect(
      result.pruned,
      'сорвавшаяся чистка отдана нулём — её не отличить от «нечего чистить»',
    ).toBeNull();
  });
});

describe('исход досмотра доезжает до наблюдений §18', () => {
  /**
   * Ревизия этапов 1–2, молчаливый отказ.
   *
   * Досмотр зовёт разбор **мимо очереди**, а все наблюдения §18 висели на
   * событиях воркера. Ровно в том состоянии, ради которого досмотр и
   * написан — Redis перезапустили, воркер отложенные задания не берёт, —
   * §18 не получал ни одного наблюдения: и рост доли ошибок, и «модель
   * недоступна» выглядели тихим днём. Пульс при этом зелёный: он
   * спрашивает Postgres и Redis, а они живы.
   */

  it('удавшийся разбор — наблюдение', async () => {
    const batchId = await openBatchAt(0);
    await testDb().update(batches).set({ status: 'queued' }).where(eq(batches.id, batchId));

    const seen: string[] = [];

    await sweepOnce({
      db: testDb(),
      logger,
      onOutcome: (outcome) => seen.push(outcome),
      process: () => Promise.resolve(),
    });

    expect(seen).toEqual(['ok']);
  });

  it('сорвавшийся разбор — тоже наблюдение, и с причиной', async () => {
    const batchId = await openBatchAt(0);
    await testDb().update(batches).set({ status: 'queued' }).where(eq(batches.id, batchId));

    const seen: { outcome: string; message: string }[] = [];

    await sweepOnce({
      db: testDb(),
      logger,
      onOutcome: (outcome, error) =>
        seen.push({
          outcome,
          message: error instanceof Error ? error.message : '',
        }),
      process: () => Promise.reject(new Error('модель недоступна')),
    });

    expect(seen).toEqual([{ outcome: 'failed', message: 'модель недоступна' }]);
  });

  it('заход с занятым замком успехом не считается', async () => {
    /**
     * Разбора не было: замок держит воркер, который минутами тянет
     * расшифровку того же человека. У досмотра это штатная механика, а не
     * редкость — считай мы такой заход успехом, доля ошибок §18
     * разбавлялась бы тем, чего не происходило. «Успех» вместо «не
     * пробовал» — та же ложь, что ноль вместо «не смогли».
     */
    const batchId = await openBatchAt(0);
    await testDb().update(batches).set({ status: 'queued' }).where(eq(batches.id, batchId));

    const seen: string[] = [];

    await sweepOnce({
      db: testDb(),
      logger,
      onOutcome: (outcome) => seen.push(outcome),
      process: () => Promise.resolve({ skipped: true }),
    });

    expect(seen).toEqual(['skipped']);
  });

  it('брошенное приёмником не обрывает проход', async () => {
    /**
     * Приёмник — чужой код. Оборвись на нём проход, и остальные ждущие
     * остались бы без разбора: ровно от этого тут и стоит `try`.
     */
    const first = await openBatchAt(0);
    await testDb().update(batches).set({ status: 'queued' }).where(eq(batches.id, first));

    const other = await upsertUser(testDb(), { tgId: 801, firstName: 'Оля' });
    const [second] = await testDb()
      .insert(batches)
      .values({ userId: other.id, status: 'queued' })
      .returning({ id: batches.id });
    expect(second?.id).toBeDefined();

    const processed: string[] = [];

    const result = await sweepOnce({
      db: testDb(),
      logger,
      onOutcome: () => {
        throw new Error('приёмник сломался');
      },
      process: (id) => {
        processed.push(id);
        return Promise.resolve();
      },
    });

    expect(processed, 'сломавшийся приёмник унёс с собой весь проход').toHaveLength(2);
    expect(result.users).toBe(2);
  });
});

describe('сообщения без выгрузки видны', () => {
  /**
   * Ревизия этапов 1–2, молчаливый отказ.
   *
   * Сообщение сохранено, а к выгрузке не привязано — тихая потеря мысли
   * при сохранённых словах. Разбор читает сообщения строго по выгрузке, и
   * такая фраза не склеится ни с чем: человек не получает ни «Слушаю», ни
   * разбора, и сказанное не попадёт даже в следующую выгрузку. Досмотр
   * слеп по устройству: он смотрит в выгрузки, а у сироты выгрузки нет.
   *
   * **Подбирать молча нельзя, и это решение.** Подбор завёл бы выгрузку
   * мимо суточного потолка §10.5, заплатил бы за расшифровку голосового у
   * человека без доступа и гонялся бы с живым приёмом за то же сообщение.
   * Узнать — наша работа, решать — человека.
   */

  it('осиротевшая фраза считается и названа', async () => {
    const HOUR = 60 * 60_000;

    await testDb()
      .insert(messagesRaw)
      .values({
        userId,
        updateId: 9_100_001,
        tgChatId: 800,
        tgMessageId: 9001,
        kind: 'text',
        text: 'записать сына к врачу',
        receivedAt: at(-2 * HOUR),
      });

    const result = await sweepOnce({
      db: testDb(),
      logger,
      now: () => T0,
      onOutcome: ignoreOutcome,
      process: () => Promise.resolve(),
    });

    expect(result.orphanedMessages, 'сирота осталась невидимой').toBe(1);
  });

  it('сообщение до нажатия «Согласна» — не сирота: оно ждёт нажатия', async () => {
    /**
     * Без согласия выгрузка не заводится нарочно (§16, решение заказчицы
     * 12.09.2026): слова сохранены и уйдут в разбор после кнопки. Считать
     * их сиротами значило бы каждую минуту писать в журнал о том, что
     * устроено так по замыслу — как было с ответами на вопросы опроса.
     */
    const HOUR = 60 * 60_000;
    const waiting = await upsertUser(testDb(), { tgId: 801, firstName: 'Оля' });

    await testDb()
      .insert(messagesRaw)
      .values({
        userId: waiting.id,
        updateId: 9_100_002,
        tgChatId: 801,
        tgMessageId: 9002,
        kind: 'text',
        text: 'записать сына к врачу',
        receivedAt: at(-2 * HOUR),
      });

    const result = await sweepOnce({
      db: testDb(),
      logger,
      now: () => T0,
      onOutcome: ignoreOutcome,
      process: () => Promise.resolve(),
    });

    expect(result.orphanedMessages).toBe(0);
  });

  it('ответ словами на вопрос бота сиротой не считается (найдено на бою 12.09.2026)', async () => {
    /**
     * «7:30» в ответ на вопрос про утреннее время бот съедает сам и в
     * разбор не пускает — по замыслу. Строка оставалась без выгрузки, и
     * счётчик неделю писал «есть сообщения без выгрузки: 2» о том, что
     * давно обработано. Съеденное помечается — и не считается.
     */
    const HOUR = 60 * 60_000;

    await testDb()
      .insert(messagesRaw)
      .values({
        userId,
        updateId: 9_100_004,
        tgChatId: 800,
        tgMessageId: 9004,
        kind: 'text',
        text: '7:30',
        receivedAt: at(-2 * HOUR),
        consumedAt: at(-2 * HOUR),
      });

    const result = await sweepOnce({
      db: testDb(),
      logger,
      now: () => T0,
      onOutcome: ignoreOutcome,
      process: () => Promise.resolve(),
    });

    expect(result.orphanedMessages).toBe(0);
  });

  it('команда сиротой не считается', async () => {
    /**
     * Команда сохраняется и дальше буфера не идёт нарочно: иначе бот
     * отвечает «Слушаю.» на `/delete_my_data` и потом зачитывает её
     * обратно расшифровкой. Считать её потерей значит утопить настоящие
     * потери в шуме.
     */
    const HOUR = 60 * 60_000;

    await testDb()
      .insert(messagesRaw)
      .values({
        userId,
        updateId: 9_100_002,
        tgChatId: 800,
        tgMessageId: 9002,
        kind: 'text',
        text: '/menu',
        receivedAt: at(-2 * HOUR),
      });

    const result = await sweepOnce({
      db: testDb(),
      logger,
      now: () => T0,
      onOutcome: ignoreOutcome,
      process: () => Promise.resolve(),
    });

    expect(result.orphanedMessages).toBe(0);
  });

  it('только что пришедшее сиротой не считается', async () => {
    // Приём сохраняет сообщение раньше, чем привязывает его к выгрузке:
    // между этими шагами лежит живая работа, и торопиться нельзя.
    await testDb()
      .insert(messagesRaw)
      .values({
        userId,
        updateId: 9_100_003,
        tgChatId: 800,
        tgMessageId: 9003,
        kind: 'text',
        text: 'ещё в пути',
        receivedAt: at(-60_000),
      });

    const result = await sweepOnce({
      db: testDb(),
      logger,
      now: () => T0,
      onOutcome: ignoreOutcome,
      process: () => Promise.resolve(),
    });

    expect(result.orphanedMessages).toBe(0);
  });
});
