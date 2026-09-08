import { eq } from 'drizzle-orm';
import { GrammyError } from 'grammy';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  batches,
  billingSubscriptions,
  broadcastDeliveries,
  broadcasts,
  users,
} from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import {
  claimDelivery,
  recipientsOf,
  countsOf,
  createBroadcast,
  listBroadcasts,
  nextPending,
  requestStop,
  resumeBroadcast,
  retryFailed,
  runningBroadcasts,
  settleStopRequests,
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

    expect(await retryFailed(testDb(), made.id)).toEqual({ ok: true, back: 1 });

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

    // Повторять нечего, и это отказ с названной причиной, а не ноль:
    // «ноль» читался бы как «повторили ноль писем» (ревизия этапа).
    expect(await retryFailed(testDb(), made.id)).toEqual({
      ok: false,
      back: 0,
      why: 'неудачных писем нет',
    });
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

describe('ревизия четвёртого этапа: рассылка не досылает лишнего и не врёт о себе', () => {
  it('повтор неудачных у остановленной рассылки отвергается', async () => {
    /**
     * **Самая дорогая находка ревизии в рассылке.** Второй запрос
     * `retryFailed` шёл без условия на состояние и ставил
     * `status: 'running', stopRequestedAt: null` — то есть кнопка
     * «Повторить неудачные» **снимала просьбу остановиться**. У
     * остановленной рассылки в `pending` остаются все недосланные, и
     * воркер досылал их всех: человек нажимал «Остановить», потом
     * «Повторить» у трёх адресов — и письмо уходило восьмистам.
     *
     * Прежняя проверка покраснеть не могла: она прогоняла заход до
     * конца, и к моменту повтора `pending` был пуст.
     */
    const ids = await people(5);

    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    await startBroadcast(testDb(), made.id);

    /**
     * Порция из двух, и оба письма не доходят: получается рассылка с
     * неудачными **и** с недосланными — то самое состояние, в котором
     * прежний повтор досылал всех. Кому именно не дошло, значения не
     * имеет: порядок строк задаёт база, и привязываться к нему нельзя.
     */
    const clock = fakeClock();
    const first = throttledSender({ clock, limitPerSecond: 30, broken: new Set(ids) });

    await sendChunk({ db: testDb(), sender: first, clock, perSecond: 20, chunk: 2 }, made.id);

    // Человек нажал «Остановить», и воркер это увидел.
    await requestStop(testDb(), made.id);
    await sendChunk({ db: testDb(), sender: first, clock, perSecond: 20 }, made.id);

    const stopped = await countsOf(testDb(), made.id);

    expect(stopped.failed).toBeGreaterThan(0);
    expect(stopped.pending).toBeGreaterThan(0);

    // И теперь повтор неудачных — отказ, а не досылка всем оставшимся.
    const outcome = await retryFailed(testDb(), made.id);

    expect(outcome.ok).toBe(false);

    const second = throttledSender({ clock, limitPerSecond: 30 });
    await sendChunk({ db: testDb(), sender: second, clock, perSecond: 20 }, made.id);

    // Ни одного письма: рассылка остановлена, и повтор её не поднял.
    expect(second.delivered()).toEqual([]);
  });

  it('взятая строка держит рассылку открытой, а не объявляет разосланной', async () => {
    /**
     * Строка, взятая воркером и не дошедшая до отметки (воркер умер
     * между взятием и отправкой — выкладка посреди рассылки штатна),
     * лежит в `sending` и в `pending` не считается. Прежде рассылка
     * объявлялась «разослана», человек письма не получал, и узнать об
     * этом было неоткуда: перезахват возможен лишь через пять минут, а
     * заход к тому времени закрыт.
     */
    const ids = await people(2);

    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    await startBroadcast(testDb(), made.id);

    // Одну строку берём себе и «умираем»: отметки не будет.
    const [taken] = await nextPending(testDb(), made.id, 1);

    expect(taken).toBeDefined();
    expect(await claimDelivery(testDb(), taken?.id ?? '')).toBe(true);

    // Остальное отправляется как обычно.
    const clock = fakeClock();
    const sender = throttledSender({ clock, limitPerSecond: 30 });
    const step = await sendChunk({ db: testDb(), sender, clock, perSecond: 20 }, made.id);

    expect(sender.delivered()).toHaveLength(ids.length - 1);

    // Рассылка НЕ закончена: взятая строка держит её открытой.
    expect(step.left).toBe(1);
    expect(step.more).toBe(true);
    expect(step.afterMs).toBeGreaterThan(0);

    const counts = await countsOf(testDb(), made.id);

    expect(counts.sending).toBe(1);
    expect((await listBroadcasts(testDb()))[0]?.status).toBe('running');
  });

  it('непрочитанная просьба остановиться исполняется при старте', async () => {
    /**
     * **Тупик, из которого не было выхода.** Метку ставит панель,
     * исполняет воркер. Умри воркер между ними — и рассылка остаётся
     * «идущей» с непустой меткой: подхват её пропускает, «Остановить»
     * заблокировано (метка уже стоит), «Продолжить» не показывается (не
     * остановлена). Панель показывала «останавливаю» навсегда.
     */
    await people(2);

    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    await startBroadcast(testDb(), made.id);
    await requestStop(testDb(), made.id);

    // Воркер её не увидел: подхват при старте таких не берёт.
    expect(await runningBroadcasts(testDb())).toEqual([]);

    const settled = await settleStopRequests(testDb());

    expect(settled).toEqual([made.id]);
    expect((await listBroadcasts(testDb()))[0]?.status).toBe('stopped');

    // И «Продолжить» снова работает — выход из тупика есть.
    expect(await resumeBroadcast(testDb(), made.id)).toBe(true);
  });

  it('исполнение просьбы не трогает рассылку без метки', async () => {
    await people(1);

    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    await startBroadcast(testDb(), made.id);

    expect(await settleStopRequests(testDb())).toEqual([]);
    expect((await listBroadcasts(testDb()))[0]?.status).toBe('running');
  });

  it('повтор законченной рассылки поднимает её и досылает только неудачным', async () => {
    // Обратная сторона отказа: законный путь обязан работать.
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

    expect((await listBroadcasts(testDb()))[0]?.status).toBe('done');

    const outcome = await retryFailed(testDb(), made.id);

    expect(outcome).toEqual({ ok: true, back: 1 });
    expect((await listBroadcasts(testDb()))[0]?.status).toBe('running');
  });
});

describe('сегменты пробного периода не задевают платящих (ревизия этапа)', () => {
  /**
   * Сегмент «у кого пробный период кончился» — это письмо «пробные
   * разборы закончились, вот тарифы». Оно уходило и тому, кто **уже
   * платит**: пробные выгрузки он потратил до подписки, а условие
   * смотрело только на них. Человек, заплативший неделю назад, получал
   * приглашение заплатить — то самое письмо, после которого просят
   * вернуть деньги.
   */

  it('платящий не попадает в «пробный кончился»', async () => {
    const ids = await people(2);
    const payer = ids[0] ?? 0;

    const [who] = await testDb().select({ id: users.id }).from(users).where(eq(users.tgId, payer));

    // Обоим пробный период исчерпан.
    for (const tgId of ids) {
      const [person] = await testDb()
        .select({ id: users.id })
        .from(users)
        .where(eq(users.tgId, tgId));

      await testDb()
        .insert(batches)
        .values({
          userId: person?.id ?? '',
          status: 'done',
          trialCountedAt: new Date(),
        });
    }

    // А один из них платит.
    await testDb()
      .insert(billingSubscriptions)
      .values({
        provider: 'robokassa:smz',
        userId: who?.id ?? '',
        plan: 'monthly',
        autoRenew: true,
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 3_600_000),
      });

    const spent = await recipientsOf(testDb(), { segment: 'trialSpent', trialLimit: 1 });

    expect(spent.map((one) => one.tgId)).not.toContain(payer);
    expect(spent).toHaveLength(1);
  });

  it('платящий не попадает и в «пробный ещё идёт»', async () => {
    // Платящий пробный не тратит вовсе, и приглашать его «попробовать»
    // незачем.
    const ids = await people(2);
    const payer = ids[0] ?? 0;

    const [who] = await testDb().select({ id: users.id }).from(users).where(eq(users.tgId, payer));

    await testDb()
      .insert(billingSubscriptions)
      .values({
        provider: 'robokassa:smz',
        userId: who?.id ?? '',
        plan: 'monthly',
        autoRenew: true,
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 3_600_000),
      });

    const left = await recipientsOf(testDb(), { segment: 'trialLeft', trialLimit: 10 });

    expect(left.map((one) => one.tgId)).not.toContain(payer);
  });

  it('кончившаяся подписка снова делает человека получателем', async () => {
    // «Платит сейчас» — про сейчас: у кого период кончился, письмо про
    // тарифы уместно.
    const ids = await people(1);
    const was = ids[0] ?? 0;

    const [who] = await testDb().select({ id: users.id }).from(users).where(eq(users.tgId, was));

    await testDb()
      .insert(batches)
      .values({ userId: who?.id ?? '', status: 'done', trialCountedAt: new Date() });

    await testDb()
      .insert(billingSubscriptions)
      .values({
        provider: 'robokassa:smz',
        userId: who?.id ?? '',
        plan: 'monthly',
        autoRenew: false,
        currentPeriodEnd: new Date(Date.now() - 24 * 3_600_000),
      });

    const spent = await recipientsOf(testDb(), { segment: 'trialSpent', trialLimit: 1 });

    expect(spent.map((one) => one.tgId)).toContain(was);
  });
});
