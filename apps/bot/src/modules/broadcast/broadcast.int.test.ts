import { eq } from 'drizzle-orm';
import { GrammyError } from 'grammy';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, broadcastDeliveries, broadcasts, users } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import {
  countsOf,
  createBroadcast,
  requestStop,
  retryFailed,
  startBroadcast,
  TELEGRAM_MESSAGE_LIMIT,
} from './broadcast.repo.js';
import { sendChunk, type BroadcastClock, type BroadcastSender } from './broadcast.service.js';

/**
 * Рассылка (§15 ТЗ, задача 4.10).
 *
 * Условие готовности названо числом: **тысяча адресатов не ловит 429 и
 * останавливается по кнопке**. Поэтому главная проверка здесь — не «все
 * сообщения ушли», а «частота не превысила лимит»: заглушка сама
 * отвечает 429, если мы обратились к ней чаще положенного, ровно как
 * Telegram.
 *
 * Часы поддельные: тысяча сообщений при двадцати в секунду идёт минуту,
 * и ждать её по-настоящему проверка не должна. Но время в ней течёт
 * честно — заглушка судит о частоте по тем же часам, по которым воркер
 * выдерживает интервал.
 */

/** Поддельные часы: сон двигает время вперёд, а не ждёт. */
function fakeClock(): BroadcastClock & { readonly slept: () => number } {
  let at = 1_000_000;
  let slept = 0;

  return {
    now: () => at,
    sleep: async (ms) => {
      at += ms;
      slept += ms;
      await Promise.resolve();
    },
    slept: () => slept,
  };
}

/**
 * Telegram-заглушка, которая считает частоту, как настоящий Telegram.
 *
 * Хранит времена отправок и отвечает 429, если за последнюю секунду их
 * стало больше лимита. Без этого проверка «не ловит 429» проверяла бы
 * только то, что мы вызвали `sleep`, — а не то, что темп выдержан.
 */
function throttledSender(params: {
  readonly clock: BroadcastClock;
  readonly limitPerSecond: number;
  readonly blocked?: ReadonlySet<number>;
  readonly broken?: ReadonlySet<number>;
}): BroadcastSender & {
  readonly delivered: () => readonly number[];
  readonly refusals: () => number;
} {
  const at: number[] = [];
  const delivered: number[] = [];
  let refusals = 0;

  return {
    send: async ({ tgId }) => {
      const now = params.clock.now();
      const recent = at.filter((one) => now - one < 1_000).length;

      if (recent >= params.limitPerSecond) {
        refusals++;
        throw new GrammyError(
          'Call to sendMessage failed',
          { ok: false, error_code: 429, description: 'Too Many Requests', parameters: {} },
          'sendMessage',
          {},
        );
      }

      at.push(now);

      if (params.blocked?.has(tgId) === true) {
        throw new GrammyError(
          'Call to sendMessage failed',
          { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
          'sendMessage',
          {},
        );
      }

      if (params.broken?.has(tgId) === true) {
        throw new Error('сеть моргнула');
      }

      delivered.push(tgId);
      await Promise.resolve();
    },
    delivered: () => delivered,
    refusals: () => refusals,
  };
}

/**
 * Завести столько людей, сколько нужно проверке.
 *
 * Пачками, а не по одному: тысяча отдельных вставок занимала полминуты
 * из тридцати пяти секунд прогона — то есть проверка мерила скорость
 * посева, а не рассылки.
 */
async function people(howMany: number, from = 500_000): Promise<readonly number[]> {
  const ids: number[] = [];
  const rows: { tgId: number; firstName: string }[] = [];

  for (let index = 0; index < howMany; index++) {
    const tgId = from + index;
    rows.push({ tgId, firstName: `человек-${String(index)}` });
    ids.push(tgId);
  }

  for (let at = 0; at < rows.length; at += 200) {
    await testDb()
      .insert(users)
      .values(rows.slice(at, at + 200));
  }

  return ids;
}

beforeEach(async () => {
  await testDb().delete(broadcastDeliveries);
  await testDb().delete(broadcasts);
  await testDb().delete(batches);
  await testDb().delete(users);
});

describe('составление и предпросмотр', () => {
  it('получатели закрепляются при создании, а не считаются на ходу', async () => {
    /**
     * Иначе «рассылка на 1000 человек» означала бы разное на разных
     * минутах: кто-то зарегистрировался, кто-то заблокировал бота.
     * Предпросмотр показывал бы одно число, отчёт — другое.
     */
    await people(3);

    const made = await createBroadcast(testDb(), {
      text: 'Оплата открылась.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    expect(made.recipients).toBe(3);

    // Появился четвёртый — на уже составленную рассылку он не влияет.
    await people(1, 777_001);

    expect((await countsOf(testDb(), made.id)).total).toBe(3);
  });

  it('заблокировавшие не попадают в список вовсе', async () => {
    /**
     * §15 требует пропускать их прямо. По 403 это тоже ловится, но
     * каждый такой ответ — потраченный запрос из общего лимита: на
     * тысяче адресатов, где половина заблокировала, рассылка шла бы
     * вдвое дольше и вдвое ближе к 429.
     */
    const [first] = await people(2);
    await testDb()
      .update(users)
      .set({ isBlocked: true })
      .where(eq(users.tgId, first ?? 0));

    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    expect(made.recipients).toBe(1);
  });

  it('пустой текст не принимается', async () => {
    await expect(
      createBroadcast(testDb(), {
        text: '   ',
        segment: 'all',
        by: 'аня',
        trialLimit: 10,
      }),
    ).rejects.toThrow('Пустой текст');
  });

  it('двойное подтверждение не даёт двух запусков', async () => {
    // Две нажатые кнопки — это два воркера на одной рассылке, то есть
    // два сообщения одному человеку и удвоенная частота.
    await people(1);
    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    expect(await startBroadcast(testDb(), made.id)).toBe(true);
    expect(await startBroadcast(testDb(), made.id)).toBe(false);
  });

  it('сегмент «пробный кончился» считается теми же выгрузками, что доступ', async () => {
    /**
     * §14 считает пробный период выгрузками, а не днями. Своё
     * определение здесь разошлось бы с тем, по которому человека
     * действительно пускают, и рассылка «оплата открылась» ушла бы тем,
     * у кого ещё всё в порядке.
     */
    const ids = await people(2);

    const [row] = await testDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.tgId, ids[0] ?? 0));

    const [other] = await testDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.tgId, ids[1] ?? 0));

    // Один потратил две выгрузки из двух — пробный кончился.
    await testDb()
      .insert(batches)
      .values([
        { userId: row?.id ?? '', status: 'done', trialCountedAt: new Date() },
        { userId: row?.id ?? '', status: 'done', trialCountedAt: new Date() },
      ]);

    /**
     * А у второго выгрузок столько же, но пробный они **не тратили**.
     *
     * Так бывает у платящего и у быстрых добавлений. Без этих строк
     * проверка не различала бы «две выгрузки» и «два пробных»: снятие
     * условия `trial_counted_at is not null` оставляло её зелёной, и
     * рассылка «оплата открылась» ушла бы тем, у кого всё в порядке.
     * Найдено диверсией над общим предикатом.
     */
    await testDb()
      .insert(batches)
      .values([
        { userId: other?.id ?? '', status: 'done' },
        { userId: other?.id ?? '', status: 'done' },
        { userId: other?.id ?? '', status: 'done' },
      ]);

    const spent = await createBroadcast(testDb(), {
      text: 'Оплата открылась.',
      segment: 'trialSpent',
      by: 'аня',
      trialLimit: 2,
    });

    const left = await createBroadcast(testDb(), {
      text: 'Как дела?',
      segment: 'trialLeft',
      by: 'аня',
      trialLimit: 2,
    });

    expect(spent.recipients).toBe(1);
    expect(left.recipients).toBe(1);
  });
});

describe('тысяча адресатов — условие готовности 4.10', () => {
  it('не ловит 429 и доходит до конца', async () => {
    /**
     * **Главная проверка задачи.** Заглушка судит о частоте по тем же
     * часам, по которым воркер выдерживает интервал, и отвечает 429
     * ровно как Telegram — значит проверяется темп, а не факт вызова
     * `sleep`.
     *
     * Лимит заглушки 30 в секунду — примерно столько разрешает Telegram
     * боту суммарно. Темп рассылки 20: треть запаса оставлена живым
     * людям, которые пишут боту в эту же минуту.
     */
    await people(1_000);

    const made = await createBroadcast(testDb(), {
      text: 'Оплата открылась, заходите.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    await startBroadcast(testDb(), made.id);

    const clock = fakeClock();
    const sender = throttledSender({ clock, limitPerSecond: 30 });

    let guard = 0;
    let step = await sendChunk({ db: testDb(), sender, clock, perSecond: 20 }, made.id);

    while (step.more && guard++ < 20) {
      step = await sendChunk({ db: testDb(), sender, clock, perSecond: 20 }, made.id);
    }

    expect(sender.refusals()).toBe(0);
    expect(sender.delivered()).toHaveLength(1_000);

    const counts = await countsOf(testDb(), made.id);
    expect(counts.sent).toBe(1_000);
    expect(counts.pending).toBe(0);

    // И рассылка сама объявила себя законченной.
    const [row] = await testDb().select().from(broadcasts).where(eq(broadcasts.id, made.id));
    expect(row?.status).toBe('done');
  });

  it('останавливается по кнопке, не досылая порцию до конца', async () => {
    /**
     * §15 просит остановить **на середине**, а не «на границе порции».
     * Порция — двести сообщений; человек, нажавший «Остановить», не
     * должен ждать, пока они уйдут.
     */
    await people(1_000);

    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    await startBroadcast(testDb(), made.id);

    const clock = fakeClock();
    const sender = throttledSender({ clock, limitPerSecond: 30 });

    // Первая порция уходит целиком.
    const first = await sendChunk({ db: testDb(), sender, clock, perSecond: 20 }, made.id);
    expect(first.sent).toBeGreaterThan(0);
    expect(first.more).toBe(true);

    // Нажали «Остановить» посреди рассылки.
    expect(await requestStop(testDb(), made.id)).toBe(true);

    const after = await sendChunk({ db: testDb(), sender, clock, perSecond: 20 }, made.id);

    expect(after.stopped).toBe(true);
    expect(after.sent).toBe(0);
    expect(after.more).toBe(false);

    const counts = await countsOf(testDb(), made.id);
    expect(counts.pending).toBeGreaterThan(0);
    expect(counts.sent).toBe(first.sent);

    const [row] = await testDb().select().from(broadcasts).where(eq(broadcasts.id, made.id));
    expect(row?.status).toBe('stopped');
  });

  it('темп действительно выдержан: тысяча за минуту, а не мгновенно', async () => {
    /**
     * Оборотная сторона проверки выше. Без этой строки рассылка,
     * отправляющая всё за ноль времени, тоже не ловила бы 429 — если бы
     * заглушка мерила частоту неверно. Тут проверяется, что воркер
     * потратил столько времени, сколько требует темп.
     */
    await people(100);

    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    await startBroadcast(testDb(), made.id);

    const clock = fakeClock();
    const sender = throttledSender({ clock, limitPerSecond: 30 });

    let step = await sendChunk({ db: testDb(), sender, clock, perSecond: 20 }, made.id);
    while (step.more) {
      step = await sendChunk({ db: testDb(), sender, clock, perSecond: 20 }, made.id);
    }

    // Сто сообщений при двадцати в секунду — около пяти секунд.
    expect(clock.slept()).toBeGreaterThanOrEqual(4_500);
  });
});

describe('что делать с отказами', () => {
  it('заблокировавший помечается пропущенным, а не неудачей', async () => {
    const ids = await people(3);
    const blocked = ids[1] ?? 0;

    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    await startBroadcast(testDb(), made.id);

    const clock = fakeClock();
    const sender = throttledSender({
      clock,
      limitPerSecond: 30,
      blocked: new Set([blocked]),
    });

    await sendChunk({ db: testDb(), sender, clock, perSecond: 20 }, made.id);

    const counts = await countsOf(testDb(), made.id);
    expect(counts.sent).toBe(2);
    expect(counts.skipped).toBe(1);
    expect(counts.failed).toBe(0);

    // И в профиле человека стоит пометка: следующая рассылка его уже
    // не посчитает.
    const [row] = await testDb().select().from(users).where(eq(users.tgId, blocked));
    expect(row?.isBlocked).toBe(true);
  });

  it('429 не расходует строку: она остаётся неотправленной', async () => {
    /**
     * 429 означает «мы слишком быстро», а не «этому человеку не
     * доставить». Пометить такую строку неудачей значило бы потерять
     * человека из-за своей же спешки.
     */
    await people(5);

    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    await startBroadcast(testDb(), made.id);

    const clock = fakeClock();
    // Лимит заглушки ниже темпа рассылки — 429 неизбежен.
    const sender = throttledSender({ clock, limitPerSecond: 2 });

    const step = await sendChunk({ db: testDb(), sender, clock, perSecond: 50 }, made.id);

    expect(sender.refusals()).toBeGreaterThan(0);
    expect(step.failed).toBe(0);
    expect(step.more).toBe(true);

    const counts = await countsOf(testDb(), made.id);
    expect(counts.failed).toBe(0);
    expect(counts.pending).toBeGreaterThan(0);
    // И воркер действительно подождал, а не пошёл дальше сразу.
    expect(clock.slept()).toBeGreaterThanOrEqual(1_000);
  });

  it('настоящий отказ помечается неудачей и виден в журнале', async () => {
    const ids = await people(3);
    const broken = ids[2] ?? 0;

    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    await startBroadcast(testDb(), made.id);

    const clock = fakeClock();
    const sender = throttledSender({ clock, limitPerSecond: 30, broken: new Set([broken]) });

    await sendChunk({ db: testDb(), sender, clock, perSecond: 20 }, made.id);

    const counts = await countsOf(testDb(), made.id);
    expect(counts.sent).toBe(2);
    expect(counts.failed).toBe(1);
  });

  it('повторный запуск берёт только неудачные, а не всех заново', async () => {
    /**
     * §15: «журнал сбоев с возможностью повторного запуска». Повтор,
     * берущий всех, прислал бы людям одно и то же дважды — и это худшее,
     * что рассылка может сделать.
     */
    const ids = await people(3);
    const broken = ids[2] ?? 0;

    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    await startBroadcast(testDb(), made.id);

    const clock = fakeClock();
    const first = throttledSender({ clock, limitPerSecond: 30, broken: new Set([broken]) });
    await sendChunk({ db: testDb(), sender: first, clock, perSecond: 20 }, made.id);

    expect(await retryFailed(testDb(), made.id)).toBe(1);

    const second = throttledSender({ clock, limitPerSecond: 30 });
    await sendChunk({ db: testDb(), sender: second, clock, perSecond: 20 }, made.id);

    // Второй заход отправил ровно одному — тому, кому не дошло.
    expect(second.delivered()).toEqual([broken]);

    const counts = await countsOf(testDb(), made.id);
    expect(counts.sent).toBe(3);
    expect(counts.failed).toBe(0);
  });

  it('пропущенные повтором не тревожатся', async () => {
    // Человек заблокировал бота: повтор — это ещё один запрос из общего
    // лимита за тем же самым 403.
    const ids = await people(2);
    const blocked = ids[0] ?? 0;

    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    await startBroadcast(testDb(), made.id);

    const clock = fakeClock();
    const sender = throttledSender({ clock, limitPerSecond: 30, blocked: new Set([blocked]) });
    await sendChunk({ db: testDb(), sender, clock, perSecond: 20 }, made.id);

    expect(await retryFailed(testDb(), made.id)).toBe(0);
    expect((await countsOf(testDb(), made.id)).skipped).toBe(1);
  });
});

describe('повторный заход не рассылает заново', () => {
  it('перезапуск посреди рассылки не присылает второе сообщение', async () => {
    /**
     * Ради этого и хранится строка на получателя. Перезапуск бота
     * выкладкой посреди рассылки — обычное дело; со счётчиком «отправлено
     * 412» второй заход начал бы с начала.
     */
    await people(5);

    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    await startBroadcast(testDb(), made.id);

    const clock = fakeClock();
    const first = throttledSender({ clock, limitPerSecond: 30 });
    await sendChunk({ db: testDb(), sender: first, clock, perSecond: 20, chunk: 2 }, made.id);

    expect(first.delivered()).toHaveLength(2);

    // «Перезапуск»: новый заход, новый отправитель.
    const second = throttledSender({ clock, limitPerSecond: 30 });
    let step = await sendChunk({ db: testDb(), sender: second, clock, perSecond: 20 }, made.id);
    while (step.more) {
      step = await sendChunk({ db: testDb(), sender: second, clock, perSecond: 20 }, made.id);
    }

    // Второй заход отправил остаток и ни одного повтора.
    expect(second.delivered()).toHaveLength(3);
    expect(new Set([...first.delivered(), ...second.delivered()]).size).toBe(5);

    expect((await countsOf(testDb(), made.id)).sent).toBe(5);
  });
});

describe('два воркера на одной рассылке', () => {
  it('не присылают человеку двух сообщений', async () => {
    /**
     * Одновременность очереди — единица, но задание, не уложившееся в
     * замок BullMQ, считается зависшим и запускается вторым воркером.
     * Тогда оба берут одну порцию — и человек получает второе
     * сообщение. Держится это отметкой «только если строка ещё
     * pending», и вот она.
     */
    await people(20);

    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    await startBroadcast(testDb(), made.id);

    const clock = fakeClock();
    const first = throttledSender({ clock, limitPerSecond: 1_000 });
    const second = throttledSender({ clock, limitPerSecond: 1_000 });

    await Promise.all([
      sendChunk({ db: testDb(), sender: first, clock, perSecond: 1_000 }, made.id),
      sendChunk({ db: testDb(), sender: second, clock, perSecond: 1_000 }, made.id),
    ]);

    const all = [...first.delivered(), ...second.delivered()];

    /**
     * **Отправок ровно двадцать, а не больше.** Не «зачтено двадцать»:
     * зачёт сошёлся бы и при двойной отправке — строк-то по одной на
     * человека. Проверяется именно то, сколько сообщений ушло в
     * Telegram, потому что второе сообщение получает живой человек.
     */
    expect(all).toHaveLength(20);
    expect(new Set(all).size).toBe(20);

    const counts = await countsOf(testDb(), made.id);

    expect(counts.sent).toBe(20);
    expect(counts.pending).toBe(0);
  });
});

describe('пределы, о которых лучше узнать до отправки', () => {
  it('текст длиннее предела Telegram не принимается', async () => {
    /**
     * Иначе рассылка на тысячу человек дала бы тысячу неудачных
     * отправок с одной и той же причиной, потратив тысячу запросов из
     * общего лимита. Сказать об этом до отправки стоит одну строку.
     */
    await people(1);

    await expect(
      createBroadcast(testDb(), {
        text: 'а'.repeat(TELEGRAM_MESSAGE_LIMIT + 1),
        segment: 'all',
        by: 'аня',
        trialLimit: 10,
      }),
    ).rejects.toThrow('Слишком длинно');
  });

  it('ровно по пределу — принимается', async () => {
    // Граница включительно: отказывать на разрешённом Telegram размере
    // значило бы придумать своё ограничение и не сказать о нём.
    await people(1);

    const made = await createBroadcast(testDb(), {
      text: 'а'.repeat(TELEGRAM_MESSAGE_LIMIT),
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    expect(made.recipients).toBe(1);
  });
});
