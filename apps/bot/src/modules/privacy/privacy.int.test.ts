import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  aiCalls,
  batches,
  items,
  messagesRaw,
  topics,
  userSettings,
  users,
  userState,
} from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { attachMessageToBatch } from '../buffer/buffer.service.js';
import { recordAiCall } from '../metering/ai-calls.repo.js';
import { recordConsent, upsertUser } from '../users/users.repo.js';
import { deleteUserData, exportUserData } from './privacy.service.js';

let userId: string;
let seq = 0;

/** Пользователь с данными во всех таблицах. */
async function seedUser(tgId: number): Promise<string> {
  const user = await upsertUser(testDb(), {
    tgId,
    firstName: 'Аня',
    username: 'anya',
    referralSource: 'blog',
  });
  await recordConsent(testDb(), user.id);

  for (const text of ['купить продукты', 'записать к врачу']) {
    seq++;
    const [message] = await testDb()
      .insert(messagesRaw)
      .values({
        userId: user.id,
        updateId: 3000 + seq,
        tgChatId: tgId,
        tgMessageId: seq,
        kind: 'text',
        text,
      })
      .returning({ id: messagesRaw.id });

    await attachMessageToBatch(testDb(), { userId: user.id, messageId: message!.id });
  }

  await recordAiCall(testDb(), {
    context: { stage: 'speech', model: 'mock', userId: user.id },
    usage: { audioSeconds: 30 },
    latencyMs: 100,
    ok: true,
  });

  // Темы, записи и уровень сил: всё, что появилось после задачи 1.20 и
  // однажды не попало в выгрузку.
  await testDb()
    .insert(topics)
    .values([
      { userId: user.id, name: 'здоровье', sortOrder: 0 },
      { userId: user.id, name: 'личное', sortOrder: 1, isDefault: true },
    ]);

  await testDb()
    .insert(items)
    .values([
      {
        userId: user.id,
        text: 'записать сына к врачу',
        type: 'TASK',
        priority: 'SOON',
        topic: 'здоровье',
        // Порядок внутри выгрузки конвейер проставляет всегда: время
        // создания у записей одной вставки совпадает, и без него
        // сортировка разрешала бы ничью идентификатором, то есть случайно.
        sourceOrder: 0,
        embedding: new Array<number>(256).fill(0.1),
      },
      {
        userId: user.id,
        text: 'непонятная фраза',
        sourceOrder: 1,
        isDraft: true,
        draftReason: 'извлечение не удалось',
      },
    ]);

  await testDb()
    .insert(userState)
    .values({ userId: user.id, energy: 'low', energyAt: new Date('2026-08-26T06:00:00.000Z') });

  return user.id;
}

beforeEach(async () => {
  seq = 0;
  userId = await seedUser(500);
});

describe('exportUserData', () => {
  it('отдаёт профиль, настройки, выгрузки и сообщения', async () => {
    const data = await exportUserData(testDb(), userId);

    expect(data?.profile.tgId).toBe(500);
    expect(data?.profile.username).toBe('anya');
    expect(data?.profile.referralSource).toBe('blog');
    expect(data?.profile.consentAt).not.toBeNull();
    expect(data?.settings?.energyDefault).toBe('normal');
    expect(data?.messages).toHaveLength(2);
    expect(data?.dumps).toHaveLength(1);
  });

  it('отдаёт записи человека, включая черновики', async () => {
    // §16 ТЗ: человек имеет право на свои данные, а дела — это они и
    // есть. Экспорт их не отдавал, и заметить это было неоткуда.
    const data = await exportUserData(testDb(), userId);

    expect(data?.items.map((item) => item.text)).toEqual([
      'записать сына к врачу',
      'непонятная фраза',
    ]);

    const [task, draft] = data?.items ?? [];
    expect(task?.type).toBe('TASK');
    expect(task?.topic).toBe('здоровье');
    expect(draft?.isDraft).toBe(true);
    expect(draft?.draftReason).toBe('извлечение не удалось');
  });

  it('отдаёт темы человека', async () => {
    const data = await exportUserData(testDb(), userId);

    expect(data?.topics.map((topic) => topic.name)).toEqual(['здоровье', 'личное']);
    expect(data?.topics.find((topic) => topic.name === 'личное')?.isDefault).toBe(true);
  });

  it('отдаёт то, что бот вывел сам: уровень сил', async () => {
    // Это не слова человека, а вывод о нём. Тем более отдавать надо:
    // иначе выгрузка показывает не всё, что о нём известно.
    const data = await exportUserData(testDb(), userId);

    expect(data?.state?.energy).toBe('low');
    expect(data?.state?.energyAt).toMatch(/^2026-08-26T06:00/u);
  });

  it('отдаёт настройки, появившиеся после 1.20', async () => {
    const data = await exportUserData(testDb(), userId);

    expect(data?.settings?.eveningOn).toBe(true);
    expect(data?.settings?.textProfile).toBe('reserved');
    expect(data?.settings).toHaveProperty('onboardingDoneAt');
  });

  it('вектор в выгрузку не идёт: это машинное представление уже отданного текста', async () => {
    const data = await exportUserData(testDb(), userId);

    expect(JSON.stringify(data)).not.toContain('0.1,0.1');
  });

  it('сохраняет порядок сообщений', async () => {
    const data = await exportUserData(testDb(), userId);

    expect(data?.messages.map((m) => m.text)).toEqual(['купить продукты', 'записать к врачу']);
  });

  it('не отдаёт служебные идентификаторы', async () => {
    const data = await exportUserData(testDb(), userId);

    // Человеку нужны его тексты, а не наши первичные ключи.
    expect(JSON.stringify(data)).not.toContain(userId);
  });

  it('формат машиночитаемый: даты в ISO', async () => {
    const data = await exportUserData(testDb(), userId);

    expect(data?.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(data?.profile.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('возвращает null для неизвестного пользователя', async () => {
    await expect(
      exportUserData(testDb(), '00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeNull();
  });
});

describe('deleteUserData', () => {
  it('удаляет всё: профиль, настройки, сообщения, выгрузки, записи, темы, состояние', async () => {
    const report = await deleteUserData(testDb(), userId);

    expect(report.deleted).toBe(true);
    expect(report.messages).toBe(2);
    expect(report.dumps).toBe(1);

    expect(await testDb().select().from(users)).toHaveLength(0);
    expect(await testDb().select().from(userSettings)).toHaveLength(0);
    expect(await testDb().select().from(messagesRaw)).toHaveLength(0);
    expect(await testDb().select().from(batches)).toHaveLength(0);

    // Каскад по внешним ключам. Проверяется явно: таблицы добавляются по
    // ходу проекта, и «ничего не осталось» должно оставаться правдой.
    expect(await testDb().select().from(items)).toHaveLength(0);
    expect(await testDb().select().from(topics)).toHaveLength(0);
    expect(await testDb().select().from(userState)).toHaveLength(0);
  });

  it('после удаления бот начинает с нуля: критерий приёмки 13', async () => {
    await deleteUserData(testDb(), userId);

    // Повторный вход создаёт чистого пользователя без прежней истории.
    const fresh = await upsertUser(testDb(), { tgId: 500, firstName: 'Аня' });

    expect(fresh.id).not.toBe(userId);
    expect(fresh.consentAt).toBeNull();
    expect(fresh.referralSource).toBeNull();
    expect(await testDb().select().from(messagesRaw)).toHaveLength(0);
  });

  it('обезличивает записи учёта расхода, но не удаляет их', async () => {
    // В них нет ни строчки пользовательского текста, а без них рассыпется
    // история себестоимости, по которой считается цена подписки.
    await deleteUserData(testDb(), userId);

    const calls = await testDb().select().from(aiCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userId).toBeNull();
    expect(calls[0]?.audioSeconds).toBe(30);
  });

  it('не задевает данные другого пользователя', async () => {
    const otherId = await seedUser(600);

    await deleteUserData(testDb(), userId);

    const remaining = await testDb().select().from(users);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(otherId);
    expect(await testDb().select().from(messagesRaw)).toHaveLength(2);
  });

  it('удаление неизвестного пользователя не ошибка', async () => {
    await expect(deleteUserData(testDb(), '00000000-0000-0000-0000-000000000000')).resolves.toEqual(
      { deleted: false, messages: 0, dumps: 0 },
    );
  });

  it('повторное удаление идемпотентно', async () => {
    await deleteUserData(testDb(), userId);

    await expect(deleteUserData(testDb(), userId)).resolves.toEqual({
      deleted: false,
      messages: 0,
      dumps: 0,
    });
  });
});

/**
 * Полнота удаления по всей базе (§16 ТЗ, критерий 13).
 *
 * Проверка выше перечисляет таблицы руками — семь штук. Такой список
 * устаревает молча: таблица появится, а тест останется зелёным, потому
 * что о ней не знает. Ровно так уже вышло с выгрузкой, и ровно так —
 * с проверкой резервных копий 27.08.2026.
 *
 * Здесь список берётся из самой базы: кто ссылается на `users`, тот и
 * обязан отпустить человека. Каскад и обезличивание проверяются одним и
 * тем же утверждением — **ни одна строка нигде не показывает на
 * удалённого**, — потому что `set null` тоже обрывает ссылку.
 *
 * Чего проверка не поймает: таблицу, которая хранит `tg_id` человека без
 * внешнего ключа. От этого страхует второй тест ниже.
 */
interface Reference {
  readonly table: string;
  readonly column: string;
}

async function referencesToUsers(): Promise<readonly Reference[]> {
  const result = await testDb().execute<{ table_name: string; column_name: string }>(sql`
    select tc.table_name, kcu.column_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name
     and kcu.table_schema = tc.table_schema
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name
     and ccu.table_schema = tc.table_schema
    where tc.constraint_type = 'FOREIGN KEY'
      and tc.table_schema = 'public'
      and ccu.table_name = 'users'
      and ccu.column_name = 'id'
    order by tc.table_name, kcu.column_name
  `);

  return result.rows.map((row) => ({ table: row.table_name, column: row.column_name }));
}

describe('удаление по всей базе, а не по списку', () => {
  it('ни одна таблица не хранит ссылку на удалённого человека', async () => {
    const references = await referencesToUsers();

    // Пустой или короткий список означал бы, что проверка ничего не
    // проверяет. На момент второго этапа ссылок шесть: настройки,
    // сообщения, выгрузки, записи, темы, состояние — плюс учёт расхода.
    expect(references.length).toBeGreaterThanOrEqual(7);

    await deleteUserData(testDb(), userId);

    const survived: string[] = [];
    for (const reference of references) {
      const result = await testDb().execute<{ left: string }>(
        sql`select count(*)::text as left from ${sql.identifier(reference.table)}
            where ${sql.identifier(reference.column)} = ${userId}`,
      );

      if (result.rows[0]?.left !== '0') {
        survived.push(`${reference.table}.${reference.column}: ${result.rows[0]?.left ?? '?'}`);
      }
    }

    expect(
      survived,
      'После удаления на человека всё ещё ссылаются. Каскад или обезличивание не настроены.',
    ).toEqual([]);
  });

  it('каждая таблица с колонкой user_id связана с людьми внешним ключом', async () => {
    // Без ключа удаление до такой таблицы не дойдёт, и данные человека
    // останутся в базе — при том что кнопка отчитается об успехе.
    const result = await testDb().execute<{ table_name: string }>(sql`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'user_id'
      order by table_name
    `);

    const linked = new Set((await referencesToUsers()).map((reference) => reference.table));
    const orphans = result.rows.map((row) => row.table_name).filter((name) => !linked.has(name));

    expect(
      orphans,
      'Таблицы с user_id без внешнего ключа на users: удаление их не тронет.',
    ).toEqual([]);
  });
});
