import { beforeEach, describe, expect, it } from 'vitest';

import { and, eq, sql } from 'drizzle-orm';
import pino from 'pino';

import {
  items,
  messagesRaw,
  recurrenceSuggestions,
  reminders,
  userSettings,
  users,
} from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import type { QuestionSender } from '../presenter/telegram-sender.js';
import { dispatchReminders, planReminders, runScheduler } from './scheduler.service.js';
import { ignoredStreak, lastMorningDay } from './reminders.repo.js';
import { setItemEmbedding } from '../embedder/embedder.service.js';
import { defaultTexts } from '../../texts/index.js';
import { eveningText } from './digest.js';

/**
 * Планировщик целиком (задачи 3.14–3.17).
 *
 * Главная проверка здесь одна и она в условии готовности 3.14 дословно:
 * **двойной запуск планировщика не порождает дублей**. Всё остальное —
 * настройки, тишина, снижение частоты — проверено модульно на чистых
 * функциях; сюда попадает то, что живёт только в базе.
 *
 * Часы управляемые: `now` передаётся аргументом во все проходы.
 */

const logger = pino({ level: 'silent' });

interface Sent {
  readonly chatId: number;
  readonly text: string;
  readonly buttons: readonly string[];
}

let outbox: Sent[] = [];

const sender: QuestionSender = {
  ask: async ({ chatId, text, rows }) => {
    outbox.push({ chatId, text, buttons: rows.flat().map((one) => one.label) });
    return await Promise.resolve(1);
  },
};

let userId = '';
let tgId = 0;
let seq = 0;

const deps = () => ({ db: testDb(), sender, logger });

/** 30 августа 2026, 06:00 в Москве: до утреннего напоминания два с половиной часа. */
const NOW = new Date('2026-08-30T03:00:00.000Z');
const DAY = 24 * 60 * 60_000;

async function setTimeZone(zone: string): Promise<void> {
  await testDb().update(users).set({ timezone: zone }).where(eq(users.id, userId));
}

async function countReminders(kind?: 'morning' | 'evening'): Promise<number> {
  const [row] = await testDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(reminders)
    .where(
      kind === undefined
        ? eq(reminders.userId, userId)
        : and(eq(reminders.userId, userId), eq(reminders.kind, kind)),
    );

  return row?.count ?? 0;
}

beforeEach(async () => {
  seq += 1;
  tgId = 7300 + seq;
  outbox = [];

  const user = await upsertUser(testDb(), { tgId, firstName: 'Аня' });
  userId = user.id;

  await testDb()
    .insert(userSettings)
    .values({ userId })
    .onConflictDoUpdate({ target: userSettings.userId, set: { notificationsOn: true } });

  await setTimeZone('Europe/Moscow');
});

describe('двойной запуск не порождает дублей (условие готовности 3.14)', () => {
  it('второй проход не добавляет ни одного задания', async () => {
    const first = await planReminders(deps(), { now: NOW });
    const second = await planReminders(deps(), { now: NOW });

    expect(first).toBe(2); // утреннее и вечернее
    expect(second).toBe(0);
    expect(await countReminders()).toBe(2);
  });

  it('десять проходов подряд — по-прежнему два задания', async () => {
    // Перезапуск бота во время выкладки поднимает второй экземпляр на
    // минуту; десять проходов — заведомо больше, чем бывает в жизни.
    for (let pass = 0; pass < 10; pass += 1) {
      await planReminders(deps(), { now: new Date(NOW.getTime() + pass * 1000) });
    }

    expect(await countReminders()).toBe(2);
  });

  it('одновременные проходы тоже не задваивают', async () => {
    /**
     * Тот случай, ради которого ключ живёт уникальным индексом, а не
     * проверкой перед вставкой: между «проверил» и «вставил» помещается
     * второй экземпляр процесса.
     */
    await Promise.all([
      planReminders(deps(), { now: NOW }),
      planReminders(deps(), { now: NOW }),
      planReminders(deps(), { now: NOW }),
    ]);

    expect(await countReminders()).toBe(2);
  });

  it('назавтра появляются новые задания', async () => {
    await planReminders(deps(), { now: NOW });
    await planReminders(deps(), { now: new Date(NOW.getTime() + DAY) });

    expect(await countReminders()).toBe(4);
  });
});

describe('отправка', () => {
  it('до срока не отправляет ничего', async () => {
    await planReminders(deps(), { now: NOW });

    expect(await dispatchReminders(deps(), { now: NOW })).toBe(0);
    expect(outbox).toEqual([]);
  });

  it('в срок отправляет один раз', async () => {
    await planReminders(deps(), { now: NOW });

    const morning = new Date('2026-08-30T05:30:00.000Z'); // 08:30 МСК
    expect(await dispatchReminders(deps(), { now: morning })).toBe(1);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.chatId).toBe(tgId);

    // Второй проход в ту же минуту ничего не повторяет.
    expect(await dispatchReminders(deps(), { now: morning })).toBe(0);
    expect(outbox).toHaveLength(1);
  });

  it('выключенные напоминания не уходят, даже если были запланированы', async () => {
    // Между раскладкой и отправкой проходит до полутора суток, и человек
    // успевает передумать. Проверять настройку только при раскладке —
    // значит её не соблюдать.
    await planReminders(deps(), { now: NOW });
    await testDb()
      .update(userSettings)
      .set({ notificationsOn: false })
      .where(eq(userSettings.userId, userId));

    expect(await dispatchReminders(deps(), { now: new Date('2026-08-30T05:30:00.000Z') })).toBe(0);
    expect(outbox).toEqual([]);
  });

  it('заблокировавшему бота не пишем', async () => {
    await planReminders(deps(), { now: NOW });
    await testDb().update(users).set({ isBlocked: true }).where(eq(users.id, userId));

    expect(await dispatchReminders(deps(), { now: new Date('2026-08-30T05:30:00.000Z') })).toBe(0);
  });
});

describe('сроки (3.16)', () => {
  async function sow(deadline: Date, accuracy: 'day' | 'week' | 'month'): Promise<string> {
    const [row] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Оплатить квитанцию',
        type: 'TASK',
        priority: 'SOON',
        topic: 'деньги',
        deadlineAt: deadline,
        deadlineAccuracy: accuracy,
      })
      .returning({ id: items.id });

    return row?.id ?? '';
  }

  it('точность «день» даёт напоминание накануне и утром', async () => {
    await sow(new Date('2026-08-31T09:00:00.000Z'), 'day');
    await planReminders(deps(), { now: NOW });

    const kinds = await testDb()
      .select({ kind: reminders.kind })
      .from(reminders)
      .where(eq(reminders.userId, userId));

    expect(kinds.map((one) => one.kind).sort()).toEqual([
      'deadline_day',
      'deadline_eve',
      'evening',
      'morning',
    ]);
  });

  it('точность «неделя» не даёт ни одного', async () => {
    await sow(new Date('2026-08-31T09:00:00.000Z'), 'week');
    await planReminders(deps(), { now: NOW });

    expect(await countReminders()).toBe(2);
  });

  it('закрытое за ночь дело не напоминает о себе утром', async () => {
    /**
     * Напоминание ставится накануне вечером, а закрыть дело человек может
     * ночью. Написать утром о сделанном — значит показать, что продукт не
     * заметил сделанного.
     */
    const itemId = await sow(new Date('2026-08-30T15:00:00.000Z'), 'day');
    await planReminders(deps(), { now: new Date('2026-08-29T03:00:00.000Z') });

    await testDb()
      .update(items)
      .set({ status: 'done', completedAt: new Date('2026-08-30T01:00:00.000Z') })
      .where(eq(items.id, itemId));

    await dispatchReminders(deps(), { now: new Date('2026-08-30T05:30:00.000Z') });

    expect(outbox.map((one) => one.text)).not.toContainEqual(
      expect.stringContaining('Оплатить квитанцию'),
    );
  });

  it('под напоминанием о сроке две кнопки', async () => {
    await sow(new Date('2026-08-31T09:00:00.000Z'), 'day');
    await planReminders(deps(), { now: NOW });
    await dispatchReminders(deps(), { now: new Date('2026-08-30T18:00:00.000Z') }); // 21:00 МСК

    const withDeadline = outbox.find((one) => one.text.includes('Оплатить квитанцию'));
    expect(withDeadline?.buttons).toEqual(['Сделано', 'Перенести']);
  });
});

describe('снижение частоты (3.17)', () => {
  /** Отправленное утреннее в указанный день, без единого сообщения в ответ. */
  async function ignoredMorning(day: string): Promise<void> {
    await testDb()
      .insert(reminders)
      .values({
        userId,
        kind: 'morning',
        dueAt: new Date(`${day}T05:30:00.000Z`),
        dedupeKey: `morning:${day}`,
        sentAt: new Date(`${day}T05:30:00.000Z`),
      });
  }

  it('без реакции серия растёт', async () => {
    await ignoredMorning('2026-08-27');
    await ignoredMorning('2026-08-28');
    await ignoredMorning('2026-08-29');

    expect(await ignoredStreak(testDb(), { userId, timeZone: 'Europe/Moscow' })).toBe(3);
  });

  it('любое сообщение в тот день обрывает серию', async () => {
    await ignoredMorning('2026-08-27');
    await ignoredMorning('2026-08-28');
    await ignoredMorning('2026-08-29');

    await testDb()
      .insert(messagesRaw)
      .values({
        userId,
        updateId: 900_000 + seq,
        tgChatId: tgId,
        tgMessageId: 1,
        kind: 'text',
        text: 'ещё вспомнила',
        receivedAt: new Date('2026-08-28T14:00:00.000Z'),
      });

    // Считаем от свежего к старому: 29-е без ответа, 28-е с ответом — стоп.
    expect(await ignoredStreak(testDb(), { userId, timeZone: 'Europe/Moscow' })).toBe(1);
  });

  it('десять молчаний переводят на недельную частоту', async () => {
    // Условие готовности 3.17 дословно.
    for (let back = 1; back <= 10; back += 1) {
      const day = new Date(NOW.getTime() - back * DAY).toISOString().slice(0, 10);
      await ignoredMorning(day);
    }

    expect(await ignoredStreak(testDb(), { userId, timeZone: 'Europe/Moscow' })).toBe(10);

    // Вчерашнее утреннее было — значит сегодняшнее не ставится.
    await planReminders(deps(), { now: NOW });

    expect(await countReminders('morning')).toBe(10);
    expect(await countReminders('evening')).toBe(1);
  });

  it('после недели молчания утреннее возвращается', async () => {
    for (let back = 7; back <= 16; back += 1) {
      const day = new Date(NOW.getTime() - back * DAY).toISOString().slice(0, 10);
      await ignoredMorning(day);
    }

    expect(await lastMorningDay(testDb(), { userId, timeZone: 'Europe/Moscow' })).toBeDefined();

    await planReminders(deps(), { now: NOW });

    expect(await countReminders('morning')).toBe(11);
  });
});

describe('пояса', () => {
  it('Камчатка получает утреннее раньше Калининграда', async () => {
    await setTimeZone('Asia/Kamchatka');
    await planReminders(deps(), { now: new Date('2026-08-29T18:00:00.000Z') });

    const [kamchatka] = await testDb()
      .select({ dueAt: reminders.dueAt })
      .from(reminders)
      .where(and(eq(reminders.userId, userId), eq(reminders.kind, 'morning')));

    const other = await upsertUser(testDb(), { tgId: tgId + 500, firstName: 'Оля' });
    await testDb().insert(userSettings).values({ userId: other.id }).onConflictDoNothing();
    await testDb()
      .update(users)
      .set({ timezone: 'Europe/Kaliningrad' })
      .where(eq(users.id, other.id));

    await planReminders(deps(), { now: new Date('2026-08-29T18:00:00.000Z') });

    const [kaliningrad] = await testDb()
      .select({ dueAt: reminders.dueAt })
      .from(reminders)
      .where(and(eq(reminders.userId, other.id), eq(reminders.kind, 'morning')));

    expect(kamchatka?.dueAt.getTime()).toBeLessThan(kaliningrad?.dueAt.getTime() ?? 0);
  });
});

describe('проход целиком', () => {
  it('раскладывает и рассылает за один вызов', async () => {
    const morning = new Date('2026-08-30T05:30:00.000Z');
    const outcome = await runScheduler(deps(), { now: morning });

    // Утреннее, чей срок наступил только что, уходит в тот же проход:
    // иначе точное время из настроек не соблюдается.
    expect(outcome.sent).toBe(1);
    expect(outbox).toHaveLength(1);
  });

  it('повторный проход не рассылает повторно', async () => {
    const morning = new Date('2026-08-30T05:30:00.000Z');
    await runScheduler(deps(), { now: morning });
    const second = await runScheduler(deps(), { now: morning });

    expect(second).toEqual({ planned: 0, sent: 0 });
    expect(outbox).toHaveLength(1);
  });
});

describe('регулярность в накопленной истории (3.17а)', () => {
  /**
   * Условие готовности: засеянная история из четырёх ежемесячных оплат
   * даёт одно предложение **в вечерней сводке**; человек в режиме тишины
   * не получает его вовсе.
   *
   * Обход проверен отдельно в `recurrence/history.int.test.ts`. Здесь —
   * только связка с планировщиком: доехало ли предложение до сообщения и
   * гасят ли его настройки.
   */

  /** Единичный вектор: близость к себе — единица. */
  const axis = (index: number): number[] =>
    Array.from({ length: 256 }, (_unused, position) => (position === index ? 1 : 0));

  async function monthlyPayments(): Promise<void> {
    for (const [index, day] of ['2026-05-06', '2026-06-05', '2026-07-06', '2026-08-05'].entries()) {
      const [row] = await testDb()
        .insert(items)
        .values({
          userId,
          text: `Оплатить садик ${String(index)}`,
          type: 'TASK',
          priority: 'SOON',
          topic: 'деньги',
          status: index === 3 ? 'new' : 'done',
        })
        .returning({ id: items.id });

      const id = row?.id ?? '';
      await setItemEmbedding(testDb(), id, axis(0));
      // Дату ставим после вектора: `setItemEmbedding` двигает `updated_at`.
      await testDb()
        .update(items)
        .set({ createdAt: new Date(`${day}T09:00:00.000Z`) })
        .where(eq(items.id, id));
    }
  }

  const withSweep = () => ({ db: testDb(), sender, logger, suggestRecurrence: true });
  const evening = new Date('2026-08-30T18:00:00.000Z'); // 21:00 МСК

  async function offerCount(): Promise<number> {
    return (
      await testDb()
        .select()
        .from(recurrenceSuggestions)
        .where(eq(recurrenceSuggestions.userId, userId))
    ).length;
  }

  it('предложение приезжает в вечерней сводке с двумя кнопками', async () => {
    await monthlyPayments();
    await planReminders(withSweep(), { now: NOW });
    await dispatchReminders(withSweep(), { now: evening });

    const sent = outbox.at(-1);

    expect(sent?.text).toContain(defaultTexts.reminders.eveningInvite);
    expect(sent?.text).toMatch(/каждый месяц/u);
    expect(sent?.buttons).toEqual([
      defaultTexts.resolver.buttonRemember,
      defaultTexts.resolver.buttonNoNeed,
    ]);
  });

  it('в сводке ровно один вопрос', async () => {
    await monthlyPayments();
    await planReminders(withSweep(), { now: NOW });
    await dispatchReminders(withSweep(), { now: evening });

    expect((outbox.at(-1)?.text.match(/\?/gu) ?? []).length).toBe(1);
  });

  it('с выключенной функцией сводка приходит без предложения', async () => {
    await monthlyPayments();
    await planReminders(deps(), { now: NOW });
    await dispatchReminders(deps(), { now: evening });

    expect(outbox.at(-1)?.text).toBe(eveningText(defaultTexts, 0));
    expect(await offerCount()).toBe(0);
  });

  it('в режиме тишины человек не получает его вовсе', async () => {
    /**
     * Правила 3.17 действуют без исключений. Функция, которая обходит
     * настройку тишины, — это не функция, а баг с описанием.
     *
     * Проверяется и то, что предложение при этом **не записано**: иначе
     * недельный бюджет сгорел бы на сообщении, которого никто не видел,
     * и связка закрылась бы навсегда.
     */
    await monthlyPayments();
    await testDb()
      .update(userSettings)
      .set({ quietFrom: '20:00', quietTo: '08:00' })
      .where(eq(userSettings.userId, userId));

    await planReminders(withSweep(), { now: NOW });
    await dispatchReminders(withSweep(), { now: evening });

    expect(outbox.map((one) => one.text)).not.toContainEqual(
      expect.stringContaining('каждый месяц'),
    );
    expect(await offerCount()).toBe(0);
  });

  it('с выключенными напоминаниями — тоже вовсе', async () => {
    await monthlyPayments();
    await testDb()
      .update(userSettings)
      .set({ notificationsOn: false })
      .where(eq(userSettings.userId, userId));

    await planReminders(withSweep(), { now: NOW });
    await dispatchReminders(withSweep(), { now: evening });

    expect(outbox).toEqual([]);
    expect(await offerCount()).toBe(0);
  });

  it('назавтра второго предложения нет', async () => {
    await monthlyPayments();
    await planReminders(withSweep(), { now: NOW });
    await dispatchReminders(withSweep(), { now: evening });

    const tomorrow = new Date(evening.getTime() + DAY);
    await planReminders(withSweep(), { now: new Date(NOW.getTime() + DAY) });
    await dispatchReminders(withSweep(), { now: tomorrow });

    expect(outbox).toHaveLength(4); // утро, вечер, утро, вечер
    expect(outbox.filter((one) => one.text.includes('каждый месяц'))).toHaveLength(1);
    expect(await offerCount()).toBe(1);
  });
});
