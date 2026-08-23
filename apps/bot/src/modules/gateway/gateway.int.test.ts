import { eq } from 'drizzle-orm';
import type { Message, Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';

import { messagesRaw, telegramUpdates, users } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { acceptUpdate } from './gateway.service.js';

const chat = { id: 500, type: 'private' } as const;
const from = { id: 500, is_bot: false, first_name: 'Аня', username: 'anya' } as const;

let nextUpdateId = 1;
let nextMessageId = 1;

function messageUpdate(overrides: Partial<Message>): Update {
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++,
      date: 1_700_000_000,
      chat,
      from,
      ...overrides,
    },
  } as Update;
}

function textUpdate(text: string, overrides: Partial<Message> = {}): Update {
  return messageUpdate({ text, ...overrides });
}

function voiceUpdate(fileId: string, durationSec: number): Update {
  return messageUpdate({
    voice: { file_id: fileId, file_unique_id: 'u', duration: durationSec },
  });
}

describe('acceptUpdate: приём и немедленное сохранение', () => {
  it('сохраняет входящее сообщение и регистрирует пользователя', async () => {
    const db = testDb();

    const outcome = await acceptUpdate(db, textUpdate('купить продукты'));

    expect(outcome.status).toBe('saved');

    const saved = await db.select().from(messagesRaw);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.text).toBe('купить продукты');
    expect(saved[0]?.kind).toBe('text');

    const registered = await db.select().from(users);
    expect(registered).toHaveLength(1);
    expect(registered[0]?.tgId).toBe(500);
    expect(registered[0]?.username).toBe('anya');
  });

  it('создаёт настройки пользователя со значениями по умолчанию', async () => {
    const db = testDb();

    await acceptUpdate(db, textUpdate('привет'));

    const settings = await db.query.userSettings.findMany();
    expect(settings).toHaveLength(1);
    expect(settings[0]?.energyDefault).toBe('normal');
    expect(settings[0]?.notificationsOn).toBe(true);
  });

  it('сохраняет голосовое с длительностью и ссылкой на файл', async () => {
    const db = testDb();

    await acceptUpdate(db, voiceUpdate('voice-1', 63));

    const [saved] = await db.select().from(messagesRaw);
    expect(saved?.kind).toBe('voice');
    expect(saved?.fileId).toBe('voice-1');
    expect(saved?.audioDurationSec).toBe(63);
    expect(saved?.transcript).toBeNull();
  });

  it('второе сообщение того же пользователя не создаёт второго пользователя', async () => {
    const db = testDb();

    await acceptUpdate(db, textUpdate('первое'));
    await acceptUpdate(db, textUpdate('второе'));

    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(messagesRaw)).toHaveLength(2);
  });
});

describe('acceptUpdate: защита от повторной доставки', () => {
  it('повторный тот же апдейт не создаёт вторую запись', async () => {
    const db = testDb();
    const update = textUpdate('записать сына к врачу');

    const first = await acceptUpdate(db, update);
    const second = await acceptUpdate(db, update);

    expect(first.status).toBe('saved');
    expect(second.status).toBe('duplicate');
    expect(await db.select().from(messagesRaw)).toHaveLength(1);
  });

  it('одновременная доставка двух копий обрабатывается один раз', async () => {
    const db = testDb();
    const update = textUpdate('гонка');

    const [a, b] = await Promise.all([acceptUpdate(db, update), acceptUpdate(db, update)]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['duplicate', 'saved']);
    expect(await db.select().from(messagesRaw)).toHaveLength(1);
  });

  it('журнал апдейтов пополняется на каждый принятый апдейт', async () => {
    const db = testDb();

    await acceptUpdate(db, textUpdate('раз'));
    await acceptUpdate(db, textUpdate('два'));

    expect(await db.select().from(telegramUpdates)).toHaveLength(2);
  });
});

describe('acceptUpdate: апдейты без сообщения', () => {
  it('нажатие кнопки помечается обработанным, но ничего не сохраняет', async () => {
    const db = testDb();
    const update = {
      update_id: nextUpdateId++,
      callback_query: { id: 'cb-1', from, chat_instance: 'x', data: 'undo:1' },
    } as unknown as Update;

    const outcome = await acceptUpdate(db, update);

    expect(outcome.status).toBe('ignored');
    expect(await db.select().from(messagesRaw)).toHaveLength(0);
    expect(await db.select().from(telegramUpdates)).toHaveLength(1);
  });

  it('сообщение от другого бота игнорируется', async () => {
    const db = testDb();
    const update = textUpdate('я бот', {
      from: { id: 999, is_bot: true, first_name: 'SomeBot' },
    });

    const outcome = await acceptUpdate(db, update);

    expect(outcome.status).toBe('ignored');
    expect(await db.select().from(users)).toHaveLength(0);
  });
});

describe('acceptUpdate: реферальный источник', () => {
  it('сохраняется при первом запуске', async () => {
    const db = testDb();

    await acceptUpdate(db, textUpdate('/start blogger42'));

    const [user] = await db.select().from(users);
    expect(user?.referralSource).toBe('blogger42');
  });

  it('не перетирается повторным /start с другим источником', async () => {
    const db = testDb();

    await acceptUpdate(db, textUpdate('/start blogger42'));
    await acceptUpdate(db, textUpdate('/start другой'));
    await acceptUpdate(db, textUpdate('/start second_source'));

    const [user] = await db.select().from(users);
    expect(user?.referralSource).toBe('blogger42');
  });

  it('обычное сообщение не затирает источник', async () => {
    const db = testDb();

    await acceptUpdate(db, textUpdate('/start blogger42'));
    await acceptUpdate(db, textUpdate('купить молоко'));

    const [user] = await db.select().from(users);
    expect(user?.referralSource).toBe('blogger42');
  });
});

describe('acceptUpdate: транзакционность', () => {
  it('сбой при сохранении не оставляет апдейт помеченным', async () => {
    const db = testDb();

    // Сообщение без chat.id пройти не может: вставка упадёт на NOT NULL.
    const broken = {
      update_id: 90_001,
      message: {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: null as unknown as number, type: 'private' },
        from,
        text: 'сломанное',
      },
    } as unknown as Update;

    await expect(acceptUpdate(db, broken)).rejects.toThrow();

    // Ключевая проверка: апдейт не помечен обработанным, значит повтор
    // от Telegram будет принят, а не отброшен как дубль.
    const journal = await db
      .select()
      .from(telegramUpdates)
      .where(eq(telegramUpdates.updateId, 90_001));
    expect(journal).toHaveLength(0);
    expect(await db.select().from(messagesRaw)).toHaveLength(0);
  });
});
