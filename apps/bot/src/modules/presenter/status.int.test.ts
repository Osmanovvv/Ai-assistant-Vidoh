import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, messagesRaw } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { attachMessageToBatch } from '../buffer/buffer.service.js';
import { upsertUser } from '../users/users.repo.js';
import { finishStatus, showStatus, type StatusSender } from './status.service.js';

const T0 = new Date('2026-08-23T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

let userId: string;
let batchId: string;
let seq = 0;

/** Считает обращения к Telegram: их число и есть предмет проверки. */
function recordingSender() {
  const sent: string[] = [];
  const edited: string[] = [];
  let nextMessageId = 100;

  const sender: StatusSender = {
    send: ({ text }) => {
      sent.push(text);
      return Promise.resolve(nextMessageId++);
    },
    edit: ({ text }) => {
      edited.push(text);
      return Promise.resolve();
    },
  };

  return { sender, sent, edited };
}

beforeEach(async () => {
  seq = 0;
  const user = await upsertUser(testDb(), { tgId: 500, firstName: 'Аня' });
  userId = user.id;

  seq++;
  const [message] = await testDb()
    .insert(messagesRaw)
    .values({ userId, updateId: seq, tgChatId: 500, tgMessageId: seq, kind: 'voice' })
    .returning({ id: messagesRaw.id });

  const attached = await attachMessageToBatch(testDb(), {
    userId,
    messageId: message!.id,
    now: at(0),
  });
  batchId = attached.batchId;
});

const target = () => ({ batchId, chatId: 500 });

describe('первое сообщение', () => {
  it('отправляется один раз', async () => {
    const { sender, sent, edited } = recordingSender();

    await showStatus({ db: testDb(), sender, now: () => at(0) }, target(), 'Слушаю.');

    expect(sent).toEqual(['Слушаю.']);
    expect(edited).toEqual([]);
  });

  it('идентификатор сохраняется в выгрузке', async () => {
    const { sender } = recordingSender();

    await showStatus({ db: testDb(), sender, now: () => at(0) }, target(), 'Слушаю.');

    const [batch] = await testDb().select().from(batches).where(eq(batches.id, batchId));
    expect(batch?.statusMessageId).toBe(100);
    expect(batch?.statusUpdatedAt).toBeInstanceOf(Date);
  });

  it('уходит в нужную ветку темы', async () => {
    let capturedThread: number | undefined;
    const sender: StatusSender = {
      send: ({ threadId }) => {
        capturedThread = threadId;
        return Promise.resolve(1);
      },
      edit: () => Promise.resolve(),
    };

    await showStatus(
      { db: testDb(), sender, now: () => at(0) },
      { batchId, chatId: 500, threadId: 330568 },
      'Слушаю.',
    );

    expect(capturedThread).toBe(330568);
  });
});

describe('последующие обновления', () => {
  it('правят сообщение, а не шлют новое', async () => {
    const { sender, sent, edited } = recordingSender();
    const deps = { db: testDb(), sender, minEditIntervalMs: 0 };

    await showStatus({ ...deps, now: () => at(0) }, target(), 'Слушаю.');
    await showStatus({ ...deps, now: () => at(2_000) }, target(), 'Разбираю…');
    await showStatus({ ...deps, now: () => at(4_000) }, target(), 'Готово.');

    expect(sent).toEqual(['Слушаю.']);
    expect(edited).toEqual(['Разбираю…', 'Готово.']);
  });

  it('серия из пяти голосовых даёт ровно одно сообщение бота', async () => {
    // §9.2 ТЗ: бот не отвечает на каждое голосовое отдельно.
    const { sender, sent } = recordingSender();
    const deps = { db: testDb(), sender, minEditIntervalMs: 0 };

    for (let i = 0; i < 5; i++) {
      await showStatus({ ...deps, now: () => at(i * 2_000) }, target(), 'Слушаю.');
    }

    expect(sent).toHaveLength(1);
  });
});

describe('ограничение частоты правок', () => {
  it('слишком частая правка пропускается', async () => {
    // Telegram ограничивает частоту обращений к чату, а поток модели
    // идёт токенами — слать построчно нельзя.
    const { sender, edited } = recordingSender();
    const deps = { db: testDb(), sender, minEditIntervalMs: 1_000 };

    await showStatus({ ...deps, now: () => at(0) }, target(), 'Слушаю.');
    const updated = await showStatus({ ...deps, now: () => at(300) }, target(), 'Разбираю…');

    expect(updated).toBe(false);
    expect(edited).toEqual([]);
  });

  it('правка после паузы проходит', async () => {
    const { sender, edited } = recordingSender();
    const deps = { db: testDb(), sender, minEditIntervalMs: 1_000 };

    await showStatus({ ...deps, now: () => at(0) }, target(), 'Слушаю.');
    const updated = await showStatus({ ...deps, now: () => at(1_500) }, target(), 'Разбираю…');

    expect(updated).toBe(true);
    expect(edited).toEqual(['Разбираю…']);
  });

  it('финальный ответ проходит всегда', async () => {
    // Его терять нельзя: это и есть результат работы бота.
    const { sender, edited } = recordingSender();
    const deps = { db: testDb(), sender, minEditIntervalMs: 10_000 };

    await showStatus({ ...deps, now: () => at(0) }, target(), 'Слушаю.');
    const updated = await finishStatus({ ...deps, now: () => at(50) }, target(), 'Вот что вышло.');

    expect(updated).toBe(true);
    expect(edited).toEqual(['Вот что вышло.']);
  });
});

describe('ошибки', () => {
  it('падает на неизвестной выгрузке', async () => {
    const { sender } = recordingSender();

    await expect(
      showStatus(
        { db: testDb(), sender },
        { batchId: '00000000-0000-0000-0000-000000000000', chatId: 500 },
        'Слушаю.',
      ),
    ).rejects.toThrow(/не найдена/u);
  });
});
