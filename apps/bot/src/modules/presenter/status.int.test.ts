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
      return Promise.resolve('edited' as const);
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
      edit: () => Promise.resolve('edited' as const),
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

describe('удалённое статусное сообщение', () => {
  /**
   * Ревизия этапов 1–2, молчаливый отказ.
   *
   * В личном чате Telegram человеку разрешено удалять сообщения бота, а
   * статусное сообщение выглядит служебным. Итог разбора уходит ровно
   * этим путём — §9.2 требует одной реплики на выгрузку, — и правка била
   * в пустоту: человек получал **ничего**. Не ошибку, не «попробуй ещё»,
   * а тишину, которую честно читает как поломку.
   *
   * Панель при этом показывала выгрузку удавшейся: обработчик не бросил,
   * значит `done`, а раздел ошибок берёт только `failed` — перезапустить
   * её было нечем.
   */

  it('исчезло — отправляется заново, а не в пустоту', async () => {
    const sent: string[] = [];
    let messageId = 500;

    const sender = {
      send: ({ text }: { readonly text: string }) => {
        sent.push(text);
        messageId += 1;
        return Promise.resolve(messageId);
      },
      edit: () => Promise.resolve('gone' as const),
    } as unknown as StatusSender;

    await testDb().update(batches).set({ statusMessageId: 499 }).where(eq(batches.id, batchId));

    const shown = await showStatus(
      { db: testDb(), sender },
      target(),
      'Перенесла срок на пятницу',
      { force: true },
    );

    expect(shown, 'реплика объявлена доставленной, а её не было').toBe(true);
    expect(sent, 'ответ не ушёл заново').toEqual(['Перенесла срок на пятницу']);

    // И новое сообщение запомнено: следующая правка пойдёт в него.
    const [row] = await testDb()
      .select({ statusMessageId: batches.statusMessageId, statusTaken: batches.statusTaken })
      .from(batches)
      .where(eq(batches.id, batchId));

    expect(row?.statusMessageId).toBe(501);
    expect(row?.statusTaken, 'слот не помечен занятым').toBe(true);
  });

  it('отказ правки не выдаётся за доставленную реплику', async () => {
    const sender = {
      send: () => Promise.resolve(600),
      edit: () => Promise.resolve('failed' as const),
    } as unknown as StatusSender;

    await testDb().update(batches).set({ statusMessageId: 599 }).where(eq(batches.id, batchId));

    const shown = await showStatus(
      { db: testDb(), sender },
      target(),
      'Перенесла срок на пятницу',
      { force: true },
    );

    expect(shown, 'ноль вместо «не смогли» — та же ложь').toBe(false);
  });

  it('но слот всё равно помечен занятым, и время правки записано', async () => {
    /**
     * `ECONNRESET` нарочно не повторяется — «он бывает и посреди
     * ответа», — значит есть достижимый случай, когда Telegram правку
     * применил, а ответ оборвался. Не пометь мы слот занятым, докладчик о
     * сбое стёр бы с экрана уже лежащий там ответ вместе с кнопкой
     * «Отменить» — ровно тот убыток, ради которого слот и заводили.
     */
    const sender = {
      send: () => Promise.resolve(700),
      edit: () => Promise.resolve('failed' as const),
    } as unknown as StatusSender;

    await testDb().update(batches).set({ statusMessageId: 699 }).where(eq(batches.id, batchId));

    await showStatus({ db: testDb(), sender }, target(), 'Перенесла срок на пятницу', {
      force: true,
    });

    const [row] = await testDb()
      .select({ statusTaken: batches.statusTaken, statusUpdatedAt: batches.statusUpdatedAt })
      .from(batches)
      .where(eq(batches.id, batchId));

    expect(row?.statusTaken).toBe(true);
    expect(row?.statusUpdatedAt).not.toBeNull();
  });
});
