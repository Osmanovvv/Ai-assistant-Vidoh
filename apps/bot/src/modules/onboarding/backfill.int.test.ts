import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { items, topics } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { localDateParts, startOfDayInZone } from '../classifier/dates.js';
import { topicsFor } from '../topics/topics.repo.js';
import { upsertUser } from '../users/users.repo.js';
import { moveItemsToOwnTopics, recalcDeadlines } from './backfill.js';

/**
 * Домиграция первой выгрузки (задача 2.14).
 *
 * Проверяется главное свойство: календарный день, который человек назвал,
 * остаётся тем же днём в его собственном поясе. Срок хранится моментом, и
 * при смене пояса момент обязан переехать — иначе напоминание придёт не
 * тогда.
 */

const MOSCOW = 'Europe/Moscow';
const VLADIVOSTOK = 'Asia/Vladivostok';
const KALININGRAD = 'Europe/Kaliningrad';

let userId: string;

/**
 * Запись со сроком, как её создал бы разбор: срок — начало суток в поясе,
 * который действовал на тот момент.
 */
async function addItem(params: {
  readonly deadlineLocalDate: string | null;
  readonly zone: string;
  readonly createdAt: Date;
  readonly topic?: string;
}): Promise<string> {
  const at =
    params.deadlineLocalDate === null
      ? null
      : startOfLocalDay(params.deadlineLocalDate, params.zone);

  const [row] = await testDb()
    .insert(items)
    .values({
      userId,
      text: 'записать сына к врачу',
      type: 'TASK',
      priority: 'SOON',
      topic: params.topic ?? 'здоровье',
      sourceOrder: 0,
      deadlineAt: at,
      deadlineAccuracy: at === null ? null : 'day',
      createdAt: params.createdAt,
    })
    .returning({ id: items.id });

  return row!.id;
}

/**
 * «2026-08-27» в поясе → момент начала этих суток.
 *
 * Считается тем же кодом, что и в разборе: своя арифметика в тесте
 * проверяла бы саму себя, а не поведение.
 */
function startOfLocalDay(date: string, zone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return startOfDayInZone({ year: year!, month: month!, day: day! }, zone);
}

/** Локальная дата срока в заданном поясе — то, что человек видит. */
async function deadlineDateIn(itemId: string, zone: string): Promise<string | null> {
  const [row] = await testDb()
    .select({ deadlineAt: items.deadlineAt })
    .from(items)
    .where(eq(items.id, itemId));

  if (!row?.deadlineAt) return null;

  const parts = localDateParts(row.deadlineAt, zone);
  return `${String(parts.year)}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

beforeEach(async () => {
  const user = await upsertUser(testDb(), { tgId: 820, firstName: 'Аня' });
  userId = user.id;
});

describe('пересчёт сроков', () => {
  it('день остаётся тем же днём в новом поясе', async () => {
    // Условие готовности задачи: «в четверг» из первой выгрузки после
    // смены пояса на владивостокский имеет правильную абсолютную дату.
    //
    // Разбор шёл днём по московскому времени — сутки у Москвы и
    // Владивостока в этот момент совпадают, поправки на день нет.
    const id = await addItem({
      deadlineLocalDate: '2026-08-27',
      zone: MOSCOW,
      createdAt: new Date('2026-08-25T09:00:00.000Z'),
    });

    // До пересчёта человек во Владивостоке видит четверг московским
    // моментом — то есть 27-е у него начинается в семь утра.
    expect(await deadlineDateIn(id, MOSCOW)).toBe('2026-08-27');

    const result = await recalcDeadlines(testDb(), userId, { from: MOSCOW, to: VLADIVOSTOK });

    expect(result.recalculated).toBe(1);
    expect(result.movedToAnotherDay).toBe(0);
    expect(await deadlineDateIn(id, VLADIVOSTOK)).toBe('2026-08-27');
  });

  it('«сегодня», сказанное ночью, переезжает на верное число', async () => {
    // Самый неприятный случай. Женщина во Владивостоке говорит «сегодня»
    // в два часа ночи 27-го. По Москве это 26-е, девятнадцать часов, — и
    // модель, которой передали московское время, разрешила «сегодня» в
    // 26-е. Пересчёт обязан это исправить, а не только сдвинуть момент.
    const createdAt = new Date('2026-08-26T16:00:00.000Z'); // 26-е 19:00 МСК, 27-е 02:00 ВЛД

    const id = await addItem({
      deadlineLocalDate: '2026-08-26',
      zone: MOSCOW,
      createdAt,
    });

    const result = await recalcDeadlines(testDb(), userId, { from: MOSCOW, to: VLADIVOSTOK });

    expect(result.movedToAnotherDay).toBe(1);
    expect(await deadlineDateIn(id, VLADIVOSTOK)).toBe('2026-08-27');
  });

  it('поправка работает и в обратную сторону', async () => {
    // Калининград на час позади Москвы. Полночь по Калининграду — это
    // ещё вчерашний день по Москве.
    const createdAt = new Date('2026-08-26T22:30:00.000Z'); // 27-е 01:30 МСК, 27-е 00:30 КЛД

    const id = await addItem({
      deadlineLocalDate: '2026-08-27',
      zone: MOSCOW,
      createdAt,
    });

    const result = await recalcDeadlines(testDb(), userId, { from: MOSCOW, to: KALININGRAD });

    // Сутки у Москвы и Калининграда в этот момент совпадают: поправки нет.
    expect(result.movedToAnotherDay).toBe(0);
    expect(await deadlineDateIn(id, KALININGRAD)).toBe('2026-08-27');
  });

  it('сдвиг через конец месяца не даёт 32 августа', async () => {
    const createdAt = new Date('2026-08-30T16:00:00.000Z'); // 30-е МСК, 31-е ВЛД

    const id = await addItem({
      deadlineLocalDate: '2026-08-31',
      zone: MOSCOW,
      createdAt,
    });

    await recalcDeadlines(testDb(), userId, { from: MOSCOW, to: VLADIVOSTOK });

    expect(await deadlineDateIn(id, VLADIVOSTOK)).toBe('2026-09-01');
  });

  it('записи без срока не трогает', async () => {
    const id = await addItem({
      deadlineLocalDate: null,
      zone: MOSCOW,
      createdAt: new Date('2026-08-25T09:00:00.000Z'),
    });

    const result = await recalcDeadlines(testDb(), userId, { from: MOSCOW, to: VLADIVOSTOK });

    expect(result.recalculated).toBe(0);
    expect(await deadlineDateIn(id, VLADIVOSTOK)).toBeNull();
  });

  it('тот же пояс — ни одного запроса на изменение', async () => {
    const id = await addItem({
      deadlineLocalDate: '2026-08-27',
      zone: MOSCOW,
      createdAt: new Date('2026-08-25T09:00:00.000Z'),
    });

    const result = await recalcDeadlines(testDb(), userId, { from: MOSCOW, to: MOSCOW });

    expect(result).toEqual({ recalculated: 0, movedToAnotherDay: 0 });
    expect(await deadlineDateIn(id, MOSCOW)).toBe('2026-08-27');
  });

  it('повторный пересчёт по уже новому поясу ничего не портит', async () => {
    // Идемпотентность: двойное нажатие кнопки не должно уносить срок
    // на двое суток.
    const createdAt = new Date('2026-08-26T16:00:00.000Z');
    const id = await addItem({ deadlineLocalDate: '2026-08-26', zone: MOSCOW, createdAt });

    await recalcDeadlines(testDb(), userId, { from: MOSCOW, to: VLADIVOSTOK });
    await recalcDeadlines(testDb(), userId, { from: VLADIVOSTOK, to: VLADIVOSTOK });

    expect(await deadlineDateIn(id, VLADIVOSTOK)).toBe('2026-08-27');
  });
});

describe('перенос записей в темы человека', () => {
  it('запись в невыбранной теме уходит в тему по умолчанию', async () => {
    // §6.4: не попавшее ни в одну тему уходит в тему по умолчанию, а
    // создавать темы за человека запрещено.
    const id = await addItem({
      deadlineLocalDate: null,
      zone: MOSCOW,
      createdAt: new Date('2026-08-25T09:00:00.000Z'),
      topic: 'здоровье',
    });

    await testDb()
      .insert(topics)
      .values([
        { userId, name: 'дети', sortOrder: 0 },
        { userId, name: 'личное', sortOrder: 1, isDefault: true },
      ]);

    const result = await moveItemsToOwnTopics(testDb(), userId, await topicsFor(testDb(), userId));

    expect(result.moved).toBe(1);
    expect(result.orphaned).toEqual(['здоровье']);

    const [row] = await testDb().select({ topic: items.topic }).from(items).where(eq(items.id, id));
    expect(row?.topic).toBe('личное');
  });

  it('запись в выбранной теме остаётся на месте', async () => {
    const id = await addItem({
      deadlineLocalDate: null,
      zone: MOSCOW,
      createdAt: new Date('2026-08-25T09:00:00.000Z'),
      topic: 'здоровье',
    });

    await testDb()
      .insert(topics)
      .values([
        { userId, name: 'здоровье', sortOrder: 0 },
        { userId, name: 'личное', sortOrder: 1, isDefault: true },
      ]);

    const result = await moveItemsToOwnTopics(testDb(), userId, await topicsFor(testDb(), userId));

    expect(result.moved).toBe(0);
    const [row] = await testDb().select({ topic: items.topic }).from(items).where(eq(items.id, id));
    expect(row?.topic).toBe('здоровье');
  });

  it('«ё» и регистр не считаются другой темой', async () => {
    const id = await addItem({
      deadlineLocalDate: null,
      zone: MOSCOW,
      createdAt: new Date('2026-08-25T09:00:00.000Z'),
      topic: 'Учеба',
    });

    await testDb()
      .insert(topics)
      .values([
        { userId, name: 'учёба', sortOrder: 0 },
        { userId, name: 'личное', sortOrder: 1, isDefault: true },
      ]);

    const result = await moveItemsToOwnTopics(testDb(), userId, await topicsFor(testDb(), userId));

    expect(result.moved).toBe(0);
    const [row] = await testDb().select({ topic: items.topic }).from(items).where(eq(items.id, id));
    expect(row?.topic).toBe('Учеба');
  });

  it('каждое потерянное имя возвращается один раз', async () => {
    // По этому списку §6.4 предлагает создать тему. Дубли в предложении
    // выглядели бы как ошибка.
    for (const topic of ['работа', 'работа', 'покупки']) {
      await addItem({
        deadlineLocalDate: null,
        zone: MOSCOW,
        createdAt: new Date('2026-08-25T09:00:00.000Z'),
        topic,
      });
    }

    await testDb()
      .insert(topics)
      .values([{ userId, name: 'личное', isDefault: true }]);

    const result = await moveItemsToOwnTopics(testDb(), userId, await topicsFor(testDb(), userId));

    expect(result.moved).toBe(3);
    expect([...result.orphaned].sort()).toEqual(['покупки', 'работа']);
  });

  it('черновики тоже переносятся: у них темы нет, и трогать их незачем', async () => {
    await testDb()
      .insert(items)
      .values({ userId, text: 'непонятное', isDraft: true, draftReason: 'сбой' });

    await testDb()
      .insert(topics)
      .values([{ userId, name: 'личное', isDefault: true }]);

    const result = await moveItemsToOwnTopics(testDb(), userId, await topicsFor(testDb(), userId));

    expect(result.moved).toBe(0);
  });
});
