import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, messagesRaw } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { finishStatus, showStatus, type StatusSender } from '../presenter/status.service.js';
import { upsertUser } from '../users/users.repo.js';
import { createFailureReporter } from './failure-notice.js';

/**
 * Сообщение о сбое не затирает уже сказанное (§9.2; ревизия этапа 1).
 *
 * **Что было.** Статусное сообщение у выгрузки одно. Обработчик выгрузки
 * это знает и держит признак «слот занят» у себя в памяти: первая реплика
 * забирает сообщение, каждая следующая уходит своим. Докладчик о сбое
 * живёт вне обработчика и признака не видел — он правил слот напрямую.
 *
 * Обстановка боя: человек отвечает на открытый вопрос, правка
 * применяется, он получает подтверждение с кнопкой «Отменить». Дальше в
 * той же выгрузке срывается извлечение — и подтверждение исчезает вместе
 * с кнопкой. На повторном заходе оно не вернётся: вопрос уже закрыт, и
 * ветка, которая его печатала, больше не сработает. Правка в базе есть,
 * человек о ней не знает, откатить нечем.
 *
 * Проверка идёт против настоящей базы, потому что признак живёт в строке
 * выгрузки: подделать её значило бы проверить свою же выдумку.
 */

interface Sent {
  readonly kind: 'send' | 'edit';
  readonly text: string;
  readonly buttons: number;
}

function recorder(): { readonly sender: StatusSender; readonly sent: Sent[] } {
  const sent: Sent[] = [];
  let nextId = 100;

  return {
    sent,
    sender: {
      send: (params) => {
        sent.push({ kind: 'send', text: params.text, buttons: params.buttons?.length ?? 0 });
        nextId += 1;
        return Promise.resolve(nextId);
      },
      edit: (params) => {
        sent.push({ kind: 'edit', text: params.text, buttons: params.buttons?.length ?? 0 });
        return Promise.resolve('edited' as const);
      },
    },
  };
}

let userId = '';
let batchId = '';

beforeEach(async () => {
  const user = await upsertUser(testDb(), { tgId: 5001, firstName: 'Аня' });

  userId = user.id;

  const [batch] = await testDb()
    .insert(batches)
    .values({ userId, status: 'processing' })
    .returning({ id: batches.id });

  batchId = batch?.id ?? '';

  // Цель статуса берётся из первого сообщения выгрузки.
  await testDb().insert(messagesRaw).values({
    userId,
    updateId: 900_001,
    tgChatId: 777,
    tgMessageId: 1,
    kind: 'text',
    text: 'перенеси зубного на пятницу',
    batchId,
  });
});

async function report(sender: StatusSender): Promise<void> {
  const reporter = createFailureReporter({ db: testDb(), sender });

  await reporter(testDb(), (await batchOf())!, {
    retryable: true,
    error: new Error('модель молчит'),
  });
}

async function batchOf() {
  const [row] = await testDb().select().from(batches).where(eq(batches.id, batchId)).limit(1);

  return row;
}

describe('докладчик о сбое и занятый статусный слот', () => {
  it('слот свободен — правит статусное сообщение, второго не шлёт', async () => {
    const { sender, sent } = recorder();

    // «Секунду, слушаю запись» — обычная правка, слот не занимает.
    await showStatus({ db: testDb(), sender }, { batchId, chatId: 777 }, 'Секунду, слушаю запись');
    sent.length = 0;

    await report(sender);

    expect(sent.map((one) => one.kind)).toEqual(['edit']);
  });

  it('слот занят ответом по существу — говорит своим сообщением', async () => {
    /**
     * Главная проверка. Подтверждение правки с кнопкой «Отменить» — это
     * и есть занятый слот; стереть его значит отнять у человека и
     * новость, и откат.
     */
    const { sender, sent } = recorder();

    await finishStatus(
      { db: testDb(), sender },
      { batchId, chatId: 777 },
      'Перенесла срок на пятницу',
      [{ label: 'Отменить', action: 'undo:1' }],
    );

    expect(sent).toHaveLength(1);
    sent.length = 0;

    await report(sender);

    // Ни одной правки: чужое сообщение осталось нетронутым.
    expect(sent.map((one) => one.kind)).toEqual(['send']);
    expect(sent[0]?.text).not.toContain('Перенесла');
  });

  it('признак занятости переживает чтение из базы, а не живёт в памяти', async () => {
    // Докладчик живёт в другом модуле и другого вызова: признак обязан
    // лежать в строке выгрузки, иначе он его не увидит.
    const { sender } = recorder();

    await finishStatus({ db: testDb(), sender }, { batchId, chatId: 777 }, 'Готово.');

    const [row] = await testDb()
      .select({ taken: batches.statusTaken })
      .from(batches)
      .where(eq(batches.id, batchId))
      .limit(1);

    expect(row?.taken).toBe(true);
  });

  it('обычная правка слот не занимает: иначе сбой всегда уходил бы вторым', async () => {
    // Обратная сторона. Объяви слот занятым от «Слушаю» — и у каждой
    // сорвавшейся выгрузки человек получал бы два сообщения вместо
    // одного, а §9.2 просит одну реплику.
    const { sender } = recorder();

    await showStatus({ db: testDb(), sender }, { batchId, chatId: 777 }, 'Секунду, слушаю запись');

    const [row] = await testDb()
      .select({ taken: batches.statusTaken })
      .from(batches)
      .where(eq(batches.id, batchId))
      .limit(1);

    expect(row?.taken).toBe(false);
  });
});
