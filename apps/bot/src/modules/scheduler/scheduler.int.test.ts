import { beforeEach, describe, expect, it } from 'vitest';

import { and, eq, sql } from 'drizzle-orm';
import pino from 'pino';

import {
  batches,
  items,
  messagesRaw,
  projectSteps,
  recurrenceSuggestions,
  reminders,
  userSettings,
  users,
} from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { putSetting, SettingsRegistry } from '../settings/settings.repo.js';
import { touchActivity, upsertUser } from '../users/users.repo.js';
import type { QuestionSender } from '../presenter/telegram-sender.js';
import {
  dispatchReminders,
  MAX_ATTEMPTS,
  planReminders,
  runScheduler,
  startScheduler,
} from './scheduler.service.js';
import { ignoredStreak, lastMorningDay } from './reminders.repo.js';
import { setEvening, setMorning, setTimezone } from '../onboarding/onboarding.service.js';
import { applyDecision, appliedOf, emptyChanges } from '../resolver/patch.js';
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

/** Срывать ли отправку: так проверяется счётчик попыток (§5 ТЗ). */
let sendFails = false;
let sendThrows = false;
/** Первая отправка ждёт, пока тест её не отпустит: проход «в полёте». */
let sendGate: Promise<void> | null = null;

const sender: QuestionSender = {
  ask: async ({ chatId, text, rows }) => {
    if (sendThrows) throw new Error('внутри отправки что-то упало');
    if (sendFails) return await Promise.resolve(0);
    if (sendGate !== null) {
      const gate = sendGate;
      sendGate = null;
      await gate;
    }

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
  sendFails = false;
  sendThrows = false;
  sendGate = null;

  const user = await upsertUser(testDb(), { tgId, firstName: 'Аня' });
  userId = user.id;
  // Тесты живут в августе 2026 по фиксированным часам; отметка активности
  // «сейчас» (настоящие часы) считалась бы реакцией на любое утреннее.
  await testDb()
    .update(users)
    .set({ lastActiveAt: new Date('2026-08-01T00:00:00.000Z') })
    .where(eq(users.id, userId));

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

describe('сорвавшаяся отправка (§5 ТЗ, колонка attempts)', () => {
  /**
   * Раньше ответ отправителя не смотрели вовсе, и сорвавшаяся отправка
   * помечалась отправленной: сообщение терялось молча, а человек, ничего
   * не получивший, попадал в серию молчания (3.17) — продукт снижал ему
   * частоту за собственный сбой.
   */
  const morning = new Date('2026-08-30T05:30:00.000Z');

  it('не помечается отправленной и пробуется снова', async () => {
    await planReminders(deps(), { now: NOW });
    sendFails = true;

    expect(await dispatchReminders(deps(), { now: morning })).toBe(0);

    const [row] = await testDb()
      .select()
      .from(reminders)
      .where(and(eq(reminders.userId, userId), eq(reminders.kind, 'morning')));

    expect(row?.sentAt).toBeNull();
    expect(row?.attempts).toBe(1);
  });

  it('после трёх попыток сдаётся и говорит об этом', async () => {
    await planReminders(deps(), { now: NOW });
    sendFails = true;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await dispatchReminders(deps(), { now: morning });
    }

    const [row] = await testDb()
      .select()
      .from(reminders)
      .where(and(eq(reminders.userId, userId), eq(reminders.kind, 'morning')));

    expect(row?.attempts).toBe(MAX_ATTEMPTS);
    expect(row?.skippedReason).toBe('failed');
    expect(row?.sentAt).toBeNull();
  });

  it('удавшаяся со второй попытки доходит', async () => {
    await planReminders(deps(), { now: NOW });

    sendFails = true;
    await dispatchReminders(deps(), { now: morning });
    sendFails = false;

    expect(await dispatchReminders(deps(), { now: morning })).toBe(1);
    expect(outbox).toHaveLength(1);
  });

  it('исключение внутри отправки — тоже попытка, и повтор конечен (ревизия этапа 3, D8)', async () => {
    /**
     * Ошибка, вылетевшая из сборки или отправки, ловилась и писалась в
     * журнал — и всё: попытка не считалась, и та же строка пробовалась
     * каждую минуту без предела. При двадцати таких порция была занята
     * ими целиком, и здоровые за ними не уходили.
     */
    await planReminders(deps(), { now: NOW });
    sendThrows = true;

    for (let attempt = 0; attempt < MAX_ATTEMPTS + 2; attempt += 1) {
      await dispatchReminders(deps(), { now: morning });
    }

    const [row] = await testDb()
      .select()
      .from(reminders)
      .where(and(eq(reminders.userId, userId), eq(reminders.kind, 'morning')));

    expect(row?.attempts).toBe(MAX_ATTEMPTS);
    expect(row?.skippedReason).toBe('failed');
    expect(row?.sentAt).toBeNull();
  });

  it('недоставленное не считается молчанием человека', async () => {
    // Иначе наш сбой снижал бы человеку частоту напоминаний.
    await planReminders(deps(), { now: NOW });
    sendFails = true;
    await dispatchReminders(deps(), { now: morning });

    expect(await ignoredStreak(testDb(), { userId, timeZone: 'Europe/Moscow' })).toBe(0);
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

  it('дело со своим напоминанием не называется в утренней сводке дважды', async () => {
    /**
     * Найдено на приёмке этапа 3. Напоминание «сегодня срок» встаёт на то
     * же местное утро, что и сводка: человек получал два сообщения подряд
     * про одну запись — сначала списком, потом отдельно.
     */
    await sow(new Date('2026-08-30T15:00:00.000Z'), 'day'); // срок сегодня
    await planReminders(deps(), { now: new Date('2026-08-29T03:00:00.000Z') });

    const morning = new Date('2026-08-30T05:30:00.000Z'); // 08:30 МСК
    await dispatchReminders(deps(), { now: morning });

    const digest = outbox.find((one) => one.text.includes(defaultTexts.reminders.morningInvite));
    const deadline = outbox.find((one) => one.buttons.includes(defaultTexts.reminders.buttonDone));

    expect(digest?.text).not.toContain('Оплатить квитанцию');
    expect(deadline?.text).toContain('Оплатить квитанцию');
  });

  it('большая цель в утреннем — ближайшим шагом (ревизия этапа 3, E17)', async () => {
    const [project] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Ремонт на кухне',
        type: 'TASK',
        priority: 'NOW',
        topic: 'дом',
        isProject: true,
      })
      .returning({ id: items.id });
    await testDb()
      .insert(projectSteps)
      .values({ itemId: project?.id ?? '', userId, text: 'Позвонить мастеру', position: 1 });

    await planReminders(deps(), { now: new Date('2026-08-29T03:00:00.000Z') });
    await dispatchReminders(deps(), { now: new Date('2026-08-30T05:30:00.000Z') });

    const digest = outbox.find((one) => one.text.includes(defaultTexts.reminders.morningInvite));
    expect(digest?.text).toContain('Позвонить мастеру');
    expect(digest?.text).not.toContain('Ремонт на кухне');
  });

  it('под напоминанием о сроке две кнопки', async () => {
    await sow(new Date('2026-08-31T09:00:00.000Z'), 'day');
    await planReminders(deps(), { now: NOW });
    await dispatchReminders(deps(), { now: new Date('2026-08-30T18:00:00.000Z') }); // 21:00 МСК

    const withDeadline = outbox.find((one) => one.text.includes('Оплатить квитанцию'));
    expect(withDeadline?.buttons).toEqual(['Сделано', 'Перенести']);
  });
});

describe('возврат к проекту (§11; ревизия этапа 3, G1)', () => {
  const noon = new Date('2026-08-30T09:00:00.000Z'); // 12:00 МСК

  async function project(overrides: { readonly steps?: readonly string[] } = {}): Promise<string> {
    const [row] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Разобраться с ремонтом',
        type: 'TASK',
        priority: 'LATER',
        topic: 'дом',
        isProject: true,
        // Десять дней без движения.
        updatedAt: new Date('2026-08-20T09:00:00.000Z'),
      })
      .returning({ id: items.id });
    const id = row?.id ?? '';

    for (const [index, text] of (overrides.steps ?? []).entries()) {
      await testDb()
        .insert(projectSteps)
        .values({ itemId: id, userId, text, position: index + 1 });
    }

    return id;
  }

  it('неразложенный проект тоже получает вопрос — без шага, но с приглашением начать', async () => {
    /**
     * Шаги раскладываются только когда человек сам спросил про проект
     * голосом; названный в выгрузке и ни разу не спрошенный жил без
     * шагов — и §11 для него не работал никогда: «один вопрос про
     * ближайший шаг» требовал шага.
     */
    await project();

    await planReminders(deps(), { now: NOW });
    await dispatchReminders(deps(), { now: noon });

    const nudge = outbox.find((one) => one.text.includes('Разобраться с ремонтом'));
    expect(nudge?.text).toBe(defaultTexts.reminders.projectStuckNoStep('Разобраться с ремонтом'));
  });

  it('проект с шагами — вопрос про ближайший, как и было', async () => {
    await project({ steps: ['Позвонить мастеру', 'Выбрать плитку'] });

    await planReminders(deps(), { now: NOW });
    await dispatchReminders(deps(), { now: noon });

    const nudge = outbox.find((one) => one.text.includes('Разобраться с ремонтом'));
    expect(nudge?.text).toBe(
      defaultTexts.reminders.projectStuck('Разобраться с ремонтом', 'Позвонить мастеру'),
    );
  });
});

describe('напоминание по сроку сверяется с нынешним сроком (ревизия этапа 3, D1)', () => {
  /**
   * Задания по сроку раскладываются на полтора суток вперёд с ключом
   * «вид:запись:день». Срок за это время меняется — правкой словами,
   * «Отложить», «Сделано» у регулярного, — а задание оставалось: в
   * 21:00 приходило «Завтра срок: к врачу» про день, которого уже нет.
   * Теперь на отправке день задания сверяется с нынешним сроком записи.
   */
  const eve = new Date('2026-08-30T18:00:00.000Z'); // 21:00 МСК, накануне 31.08
  const morning = new Date('2026-08-31T05:30:00.000Z'); // 08:30 МСК, 31.08

  async function sow(
    overrides: {
      readonly recurring?: boolean;
    } = {},
  ): Promise<string> {
    const [row] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Оплатить садик',
        type: 'TASK',
        priority: 'SOON',
        topic: 'деньги',
        deadlineAt: new Date('2026-08-30T21:00:00.000Z'), // 31.08 по Москве
        deadlineAccuracy: 'day',
        ...(overrides.recurring === true
          ? {
              recurrenceRule: { kind: 'monthly', interval: 1, anchor: '2026-01-31' },
              recurrenceText: 'каждый месяц',
              recurrenceSource: 'stated' as const,
            }
          : {}),
      })
      .returning({ id: items.id });

    return row?.id ?? '';
  }

  async function skippedOf(kind: 'deadline_eve' | 'deadline_day'): Promise<string | null> {
    const [row] = await testDb()
      .select({ reason: reminders.skippedReason })
      .from(reminders)
      .where(and(eq(reminders.userId, userId), eq(reminders.kind, kind)));

    return row?.reason ?? null;
  }

  const deadlineTexts = () => outbox.map((one) => one.text).filter((text) => text.includes('срок'));

  it('после переноса срока «Завтра срок» про старый день не приходит', async () => {
    const id = await sow();
    await planReminders(deps(), { now: NOW });

    // Днём сказала «не завтра, а в пятницу» — срок 04.09.
    await testDb()
      .update(items)
      .set({ deadlineAt: new Date('2026-09-03T21:00:00.000Z') })
      .where(eq(items.id, id));

    await dispatchReminders(deps(), { now: eve });

    expect(deadlineTexts()).toEqual([]);
    expect(await skippedOf('deadline_eve')).toBe('stale');
  });

  it('по новому сроку напоминание ставится — старый ключ ему не мешает', async () => {
    const id = await sow();
    await planReminders(deps(), { now: NOW });
    await testDb()
      .update(items)
      .set({ deadlineAt: new Date('2026-09-03T21:00:00.000Z') })
      .where(eq(items.id, id));

    // Вечер 02.09: горизонт 36 часов уже видит пятницу.
    await planReminders(deps(), { now: new Date('2026-09-02T15:00:00.000Z') });

    const keys = await testDb()
      .select({ key: reminders.dedupeKey })
      .from(reminders)
      .where(and(eq(reminders.userId, userId), eq(reminders.kind, 'deadline_eve')));

    expect(keys.map((row) => row.key).sort()).toEqual([
      `deadline_eve:${id}:2026-08-31`,
      `deadline_eve:${id}:2026-09-04`,
    ]);
  });

  it('«Сделано» у регулярного накануне снимает утреннее «Сегодня срок»', async () => {
    const id = await sow({ recurring: true });
    await planReminders(deps(), { now: NOW });

    // Вечером 30.08 нажала «Сделано»: срок ушёл на 30.09.
    appliedOf(
      await applyDecision(testDb(), {
        userId,
        itemId: id,
        action: 'complete',
        changes: emptyChanges(),
        timeZone: 'Europe/Moscow',
        now: new Date('2026-08-30T17:00:00.000Z'),
      }),
    );

    await dispatchReminders(deps(), { now: morning });

    expect(deadlineTexts()).toEqual([]);
    expect(await skippedOf('deadline_day')).toBe('stale');
  });

  it('срок стал неточным — напоминание тоже снимается', async () => {
    const id = await sow();
    await planReminders(deps(), { now: NOW });
    await testDb().update(items).set({ deadlineAccuracy: 'week' }).where(eq(items.id, id));

    await dispatchReminders(deps(), { now: eve });

    expect(deadlineTexts()).toEqual([]);
    expect(await skippedOf('deadline_eve')).toBe('stale');
  });

  it('срок не менялся — напоминание приходит, как раньше', async () => {
    await sow();
    await planReminders(deps(), { now: NOW });

    await dispatchReminders(deps(), { now: eve });

    expect(deadlineTexts()).toHaveLength(1);
    expect(await skippedOf('deadline_eve')).toBeNull();
  });
});

describe('отложенное возвращается (ревизия этапа 3, C1)', () => {
  /**
   * «Отложить» обещало «Напомню позже» — и не напоминало: отложенное
   * не считалось открытым, планировщик его не видел, а статус назад не
   * поднимал никто. Теперь дело открыто, напоминания по сроку ставятся,
   * а в день срока оно просыпается — снова «в работе».
   */
  async function snoozed(deadline: Date | null): Promise<string> {
    const [row] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Записаться к врачу',
        type: 'TASK',
        priority: 'SOON',
        topic: 'здоровье',
        status: 'snoozed',
        deadlineAt: deadline,
        deadlineAccuracy: deadline === null ? null : 'day',
      })
      .returning({ id: items.id });

    return row?.id ?? '';
  }

  async function statusOf(id: string): Promise<string> {
    const [row] = await testDb()
      .select({ status: items.status })
      .from(items)
      .where(eq(items.id, id));
    return row?.status ?? '';
  }

  it('отложенное до завтра получает напоминание накануне и утром', async () => {
    // Завтра 31.08 по Москве — начало дня 30.08 21:00 UTC.
    await snoozed(new Date('2026-08-30T21:00:00.000Z'));
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

  it('до своего дня не просыпается', async () => {
    const id = await snoozed(new Date('2026-08-30T21:00:00.000Z'));

    await runScheduler(deps(), { now: NOW });

    expect(await statusOf(id)).toBe('snoozed');
  });

  it('в день срока просыпается: снова в работе', async () => {
    const id = await snoozed(new Date('2026-08-30T21:00:00.000Z'));

    // 31.08, 00:01 по Москве — срок наступил.
    await runScheduler(deps(), { now: new Date('2026-08-30T21:01:00.000Z') });

    expect(await statusOf(id)).toBe('active');
  });

  it('отложенное без срока просыпается первым же проходом: ждать ему нечего', async () => {
    const id = await snoozed(null);

    await runScheduler(deps(), { now: NOW });

    expect(await statusOf(id)).toBe('active');
  });

  it('чужое отложенное проход не трогает', async () => {
    const stranger = await upsertUser(testDb(), { tgId: 7900 + seq, firstName: 'Чужая' });
    const [row] = await testDb()
      .insert(items)
      .values({
        userId: stranger.id,
        text: 'Не моё',
        type: 'TASK',
        priority: 'SOON',
        topic: 'дом',
        status: 'snoozed',
        deadlineAt: new Date('2026-08-30T21:00:00.000Z'),
        deadlineAccuracy: 'day',
      })
      .returning({ id: items.id });

    await runScheduler(deps(), { now: new Date('2026-08-30T21:01:00.000Z') });

    // Просыпается и чужое: проход общий на всех, у него нет «своих».
    expect(await statusOf(row?.id ?? '')).toBe('active');
  });
});

describe('вечерний итог считает сделанные регулярные (ревизия этапа 3, C9)', () => {
  const evening = new Date('2026-08-30T18:00:00.000Z'); // 21:00 МСК

  async function sow(overrides: {
    readonly status?: 'new' | 'done' | 'cancelled';
    readonly completedAt?: Date | null;
    readonly recurring?: boolean;
  }): Promise<void> {
    await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Оплатить садик',
        type: 'TASK',
        priority: 'SOON',
        topic: 'дом',
        status: overrides.status ?? 'new',
        completedAt: overrides.completedAt ?? null,
        ...(overrides.recurring === true
          ? {
              deadlineAt: new Date('2026-10-04T21:00:00.000Z'),
              deadlineAccuracy: 'day' as const,
              recurrenceRule: { kind: 'monthly', interval: 1, anchor: '2026-01-05' },
              recurrenceText: 'каждый месяц',
              recurrenceSource: 'stated' as const,
            }
          : {}),
      });
  }

  async function eveningTextSent(): Promise<string> {
    await planReminders(deps(), { now: NOW });
    await dispatchReminders(deps(), { now: evening });
    return (
      outbox
        .map((one) => one.text)
        .find((text) => text.includes('закончился') || text.includes('закрыто')) ?? ''
    );
  }

  it('сделанное сегодня регулярное — закрыто одно, а не «день закончился»', async () => {
    // Днём отметила садик: запись не закрыта, но сделана сегодня.
    await sow({ recurring: true, completedAt: new Date('2026-08-30T10:00:00.000Z') });

    expect(await eveningTextSent()).toContain(defaultTexts.reminders.eveningClosed(1));
  });

  it('регулярное, сделанное вчера, сегодня не считается', async () => {
    await sow({ recurring: true, completedAt: new Date('2026-08-29T10:00:00.000Z') });

    expect(await eveningTextSent()).toContain(defaultTexts.reminders.eveningQuiet);
  });

  it('обычное закрытое и регулярное сделанное считаются вместе', async () => {
    await sow({ status: 'done', completedAt: new Date('2026-08-30T09:00:00.000Z') });
    await sow({ recurring: true, completedAt: new Date('2026-08-30T10:00:00.000Z') });

    expect(await eveningTextSent()).toContain(defaultTexts.reminders.eveningClosed(2));
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

  it('нажатие кнопки — тоже реакция (ревизия этапа 3, D13)', async () => {
    /**
     * Нажатия в `messages_raw` не пишутся; серия смотрела только на
     * сообщения. Человек, закрывший дело кнопкой под утренним, считался
     * молчащим — и ему снижали частоту за то, что он отвечал.
     */
    await ignoredMorning('2026-08-27');
    await ignoredMorning('2026-08-28');
    await ignoredMorning('2026-08-29');

    // Нажатие 28-го днём: обработчики отмечают активность человека.
    await touchActivity(testDb(), userId, new Date('2026-08-28T14:00:00.000Z'));

    expect(await ignoredStreak(testDb(), { userId, timeZone: 'Europe/Moscow' })).toBe(1);
  });

  it('активность в день без утреннего тоже обрывает серию (D13)', async () => {
    // Утренние по понедельникам (недельная частота): 17-го и 24-го без
    // ответа, а 20-го человек писал. Молчал он только 24-го.
    await ignoredMorning('2026-08-17');
    await ignoredMorning('2026-08-24');
    await testDb()
      .insert(messagesRaw)
      .values({
        userId,
        updateId: 900_000 + seq,
        tgChatId: tgId,
        tgMessageId: 1,
        kind: 'text',
        text: 'вспомнила про врача',
        receivedAt: new Date('2026-08-20T14:00:00.000Z'),
      });

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

describe('остановка дожидается идущего прохода (ревизия этапа 3, D7)', () => {
  it('стоп возвращается после того, как отправленное помечено', async () => {
    /**
     * Выкладка в 08:30, когда уходят утренние: сообщение отправлено, а
     * пометить его в базе процесс не успел — базу закрыли. После
     * перезапуска «Доброе утро» уходит второй раз. §21 п.11 требует
     * «без дублей»: остановка обязана дождаться прохода.
     */
    await planReminders(deps(), { now: NOW });

    let release: () => void = () => undefined;
    sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const stop = startScheduler(deps(), 5);

    // Ждём, пока проход дойдёт до отправки и повиснет на калитке:
    // отправитель обнуляет калитку, когда берёт её.
    const gateTaken = (): boolean => sendGate === null;
    while (!gateTaken()) await new Promise((resolve) => setTimeout(resolve, 5));

    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped, 'стоп вернулся, не дождавшись прохода').toBe(false);

    release();
    await stopping;

    // Проход идёт по настоящим часам и раскладывает ещё и сегодняшнее;
    // нас интересует утреннее 30.08 — то, что висело на калитке.
    const rows = await testDb()
      .select({ sentAt: reminders.sentAt })
      .from(reminders)
      .where(and(eq(reminders.userId, userId), eq(reminders.dedupeKey, 'morning:2026-08-30')));

    expect(rows.map((row) => row.sentAt !== null)).toEqual([true]);
  });

  it('стоп без идущего прохода возвращается сразу', async () => {
    const stop = startScheduler(deps(), 60_000);

    await stop();
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

    expect(second).toEqual({ planned: 0, sent: 0, woken: 0 });
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

  it('сорвавшаяся отправка не сжигает связку: предложение снимается, и назавтра спросят снова (ревизия этапа 3, C2)', async () => {
    /**
     * Предложение записывалось при сборке сводки, а не после отправки:
     * отказ Telegram — и про эту связку бот не спросил бы больше никогда,
     * а недельный бюджет предложений сгорал на невидимом сообщении.
     */
    await monthlyPayments();
    await planReminders(withSweep(), { now: NOW });

    sendFails = true;
    await dispatchReminders(withSweep(), { now: evening });
    expect(await offerCount()).toBe(0);

    // Повтор через минуту — тем же заданием: связка цела, вопрос уходит.
    sendFails = false;
    await dispatchReminders(withSweep(), { now: new Date(evening.getTime() + 60_000) });

    expect(outbox.map((one) => one.text)).toContainEqual(expect.stringContaining('каждый месяц'));
    expect(await offerCount()).toBe(1);
  });

  it('с выключенным вечером человек не получает его вовсе', async () => {
    /**
     * Правила 3.17 действуют без исключений: предложение едет внутри
     * вечерней сводки и умирает вместе с ней. Функция, которая обходит
     * настройки, — это не функция, а баг с описанием.
     *
     * **Проверяется выключателем вечера, а не режимом тишины, и это
     * следствие правки на приёмке.** Тишина больше не может накрыть время,
     * которое человек выбрал сам: иначе умолчание 22:00–08:00 молча
     * отменяло бы выбранный им вечер, как оно отменяло чужое утро в 07:00.
     * Значит вечернюю сводку тишиной не заглушить — заглушается она
     * выключателем.
     *
     * Проверяется и то, что предложение при этом **не записано**: иначе
     * недельный бюджет сгорел бы на сообщении, которого никто не видел,
     * и связка закрылась бы навсегда.
     */
    await monthlyPayments();
    await testDb()
      .update(userSettings)
      .set({ eveningOn: false })
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

describe('выбранное время вступает в силу сразу (задача 3.26)', () => {
  /**
   * Дефект найден ручным прогоном на боевом 01.09.2026.
   *
   * Человек выбрал на онбординге утро 09:00, а задание осталось на 08:30
   * — значение по умолчанию. Порядок такой: онбординг идёт **после**
   * первой выгрузки (§12.2), и планировщик к этому времени уже разложил
   * ближайшие полтора суток по прежним настройкам.
   *
   * **Прежние тесты этого не воспроизводили.** Они задают настройки до
   * первого прохода и планируют один раз, а дефект живёт именно в
   * порядке: сперва разложили, потом человек выбрал. Поэтому проверка
   * здесь идёт по шагам, а не одним вызовом.
   */

  /** Во сколько поставлено задание — в местном времени человека. */
  async function morningAt(): Promise<string | undefined> {
    const rows = await testDb()
      .select({ dueAt: reminders.dueAt })
      .from(reminders)
      .where(and(eq(reminders.userId, userId), eq(reminders.kind, 'morning')));

    const [row] = rows;
    if (row === undefined) return undefined;

    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(row.dueAt);
  }

  it('утро, выбранное после раскладки, переносит задание', async () => {
    await planReminders(deps(), { now: NOW });
    expect(await morningAt()).toBe('08:30');

    await setMorning(testDb(), userId, '09:00');
    await planReminders(deps(), { now: NOW });

    expect(await morningAt()).toBe('09:00');
  });

  it('смена города тоже: утреннее встаёт по новому поясу (ревизия этапа 3, D11)', async () => {
    /**
     * Переехала во Владивосток и сменила город в настройках. Раньше
     * разложенное по Москве оставалось: утреннее приходило в 15:30 по
     * новому времени, а в 08:30 — ничего, потому что ключ дня был занят.
     */
    await planReminders(deps(), { now: NOW });
    expect(await morningAt()).toBe('08:30');

    await setTimezone(testDb(), userId, 'Asia/Vladivostok');
    await planReminders(deps(), { now: NOW });

    const rows = await testDb()
      .select({ dueAt: reminders.dueAt })
      .from(reminders)
      .where(and(eq(reminders.userId, userId), eq(reminders.kind, 'morning')));

    const local = rows.map((row) =>
      new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Asia/Vladivostok',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(row.dueAt),
    );

    expect(local).toEqual(['08:30']);
  });

  it('вечер тоже', async () => {
    await planReminders(deps(), { now: NOW });

    await setEvening(testDb(), userId, '20:00');
    await planReminders(deps(), { now: NOW });

    const rows = await testDb()
      .select({ dueAt: reminders.dueAt })
      .from(reminders)
      .where(and(eq(reminders.userId, userId), eq(reminders.kind, 'evening')));

    const hours = rows.map((row) =>
      new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(row.dueAt),
    );

    expect(hours).toEqual(['20:00']);
  });

  it('заданий не задваивается: старое снято, а не оставлено', async () => {
    await planReminders(deps(), { now: NOW });
    await setMorning(testDb(), userId, '09:00');
    await planReminders(deps(), { now: NOW });

    expect(await countReminders('morning')).toBe(1);
  });

  it('отправленное не снимается — оно уже история', async () => {
    /**
     * Важная граница. По отправленным считается серия молчания (3.17), и
     * если снятие заденет их, снижение частоты сломается молча.
     */
    await planReminders(deps(), { now: NOW });
    await dispatchReminders(deps(), { now: new Date(NOW.getTime() + 3 * 60 * 60_000) });

    const sentBefore = await testDb()
      .select({ id: reminders.id })
      .from(reminders)
      .where(and(eq(reminders.userId, userId), sql`sent_at is not null`));

    expect(sentBefore.length).toBeGreaterThan(0);

    await setMorning(testDb(), userId, '09:00');

    const sentAfter = await testDb()
      .select({ id: reminders.id })
      .from(reminders)
      .where(and(eq(reminders.userId, userId), sql`sent_at is not null`));

    expect(sentAfter.length).toBe(sentBefore.length);
  });
});

describe('напоминание не приглашает того, кому бот откажет (ревизия этапа)', () => {
  /**
   * **Приглашение, которое бот сам не исполнит, хуже молчания.** «Наговори,
   * разложу» уходило каждое утро и тому, у кого пробные разборы кончились
   * — а на наговорённое приходит отказ. Каждый день.
   *
   * Дела на сегодня при этом остаются: §14 велит держать бэклог
   * доступным на чтение, и напоминание о делах — чтение.
   */

  /** Те же зависимости, что у остальных проверок, плюс реестр настроек. */
  const withSettings = () => ({
    ...deps(),
    settings: new SettingsRegistry({ db: testDb(), ttlMs: 0 }),
  });

  it('у человека без доступа утреннее письмо приглашает оплатить, а не выгружать', async () => {
    await putSetting(testDb(), { name: 'trialDumps', value: '1' });

    // Пробная выгрузка потрачена: бот такому откажет.
    await testDb().insert(batches).values({ userId, status: 'done', trialCountedAt: new Date() });

    await planReminders(withSettings(), { now: NOW });
    await dispatchReminders(withSettings(), { now: new Date('2026-08-30T05:30:00.000Z') });

    const sent = outbox.at(-1);

    expect(sent?.text).toContain(defaultTexts.reminders.needsPay);
    expect(sent?.text).not.toContain(defaultTexts.reminders.morningInvite);

    // И кнопка оплаты рядом: искать её в меню человек не должен.
    expect(sent?.buttons).toEqual([defaultTexts.menu.buttonSubscription]);
  });

  it('у человека с доступом всё как было', async () => {
    await planReminders(withSettings(), { now: NOW });
    await dispatchReminders(withSettings(), { now: new Date('2026-08-30T05:30:00.000Z') });

    const sent = outbox.at(-1);

    expect(sent?.text).toContain(defaultTexts.reminders.morningInvite);
    expect(sent?.buttons).toEqual([]);
  });
});

describe('раскладка доходит до всех, а не до первых пятисот (ревизия этапа)', () => {
  /**
   * **Начиная с пятьсот первого человека напоминания не приходили
   * вовсе** — и узнать об этом было неоткуда: ни числа, ни строки в
   * журнале. Порядок строк при этом задавал Postgres, то есть «первые
   * пятьсот» каждый проход могли быть разными.
   *
   * Проверка берёт 501 человека: на сотне дефект не видно, и именно
   * поэтому его не поймал ни один прежний прогон.
   */
  it('пятьсот первому человеку напоминание тоже поставлено', async () => {
    const many: string[] = [];

    for (let index = 0; index < 501; index++) {
      const person = await upsertUser(testDb(), {
        tgId: 600_000 + index,
        firstName: `Человек ${String(index)}`,
      });

      await setMorning(testDb(), person.id, '08:30');
      many.push(person.id);
    }

    await planReminders(deps(), { now: NOW });

    const [row] = await testDb()
      .select({ total: sql<number>`count(distinct ${reminders.userId})::int` })
      .from(reminders)
      .where(eq(reminders.kind, 'morning'));

    // Все, кому положено: посеянный в общем `beforeEach` плюс эти 501.
    expect(row?.total ?? 0).toBeGreaterThanOrEqual(501);

    // И конкретно последний по порядку — не «первые пятьсот».
    const sorted = [...many].sort((one, two) => one.localeCompare(two));
    const last = sorted[sorted.length - 1] ?? '';

    const [tail] = await testDb()
      .select({ total: sql<number>`count(*)::int` })
      .from(reminders)
      .where(and(eq(reminders.userId, last), eq(reminders.kind, 'morning')));

    expect(tail?.total ?? 0).toBe(1);
  }, 120_000);
});
