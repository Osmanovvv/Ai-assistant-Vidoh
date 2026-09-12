import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, items } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { RETURNING_ACTION } from '../../modules/returning/returning-actions.js';
import { toShortId } from '../../modules/shared/short-id.js';
import { upsertUser } from '../../modules/users/users.repo.js';
import { testDb } from '../../test/db.js';
import { defaultTexts } from '../../texts/index.js';
import { registerReturningHandlers } from './returning.js';

/**
 * «Начать с чистого листа» через настоящий обработчик (§13.6 ТЗ).
 *
 * **Служба проверена одиннадцатью тестами, обработчик — ни одним, до
 * 05.09.2026.** Ровно этот разрыв в тот же день стоил боту кнопки «Да,
 * запомни»: служба работала, а в обработчике ей передавалось пустое, и
 * правило не выставлялось ни разу (задача 3.75).
 *
 * Кнопка называется так, что человек ждёт удаления, — и §13.6 требует,
 * чтобы удаления не было: записи уходят в фон и остаются в бэклоге.
 * Поэтому здесь проверяется и то, что она делает, и то, чего не делает.
 */

const logger = createLogger({ level: 'silent' });
const TG_ID = 7171;

let userId = '';
let seq = 0;

interface ApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

function createTestBot(): { bot: Bot; calls: ApiCall[] } {
  const botInfo = {
    id: 1,
    is_bot: true,
    first_name: 'ВЫДОХ',
    username: 'vydoh_test_bot',
  } as unknown as UserFromGetMe;

  const bot = new Bot('123456789:TESTTESTTESTTESTTESTTESTTESTTEST', { botInfo });
  const calls: ApiCall[] = [];

  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload });

    const result =
      method === 'answerCallbackQuery'
        ? true
        : { message_id: calls.length, date: 0, chat: { id: TG_ID, type: 'private' } };

    return Promise.resolve({ ok: true, result } as never);
  });

  registerReturningHandlers(bot, testDb(), logger);
  return { bot, calls };
}

function callbackUpdate(data: string): Update {
  seq++;

  return {
    update_id: 900_000 + seq,
    callback_query: {
      id: String(seq),
      from: { id: TG_ID, is_bot: false, first_name: 'Аня' },
      chat_instance: 'test',
      data,
      message: { message_id: 1, date: 0, chat: { id: TG_ID, type: 'private' } },
    },
  } as unknown as Update;
}

function edits(calls: readonly ApiCall[]): string[] {
  return calls
    .filter((call) => call.method === 'editMessageText')
    .map((call) => String(call.payload['text']));
}

const DAY = 24 * 60 * 60_000;

/** Старые дела — сказанные задолго до возвращения. */
async function sow(count: number, ageDays = 20): Promise<string[]> {
  const ids: string[] = [];

  for (let index = 0; index < count; index++) {
    const [row] = await testDb()
      .insert(items)
      .values({
        userId,
        text: `Дело номер ${String(index + 1)}`,
        type: 'TASK',
        priority: 'SOON',
        topic: 'дом',
        createdAt: new Date(Date.now() - ageDays * DAY),
      })
      .returning({ id: items.id });

    ids.push(row?.id ?? '');
  }

  return ids;
}

beforeEach(async () => {
  seq++;
  userId = (await upsertUser(testDb(), { tgId: TG_ID, firstName: 'Аня' })).id;
});

describe('кнопка «Начать с чистого листа»', () => {
  it('уносит открытые записи в фон и называет число', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();
    await sow(3);

    await bot.handleUpdate(callbackUpdate(RETURNING_ACTION.fresh));

    const all = await testDb().select().from(items).where(eq(items.userId, userId));
    expect(all).toHaveLength(3);
    expect(all.every((one) => one.backgroundedAt !== null)).toBe(true);

    expect(edits(calls)).toEqual([defaultTexts.returning.moved(3)]);
  });

  it('ничего не удаляет — §13.6 требует этого прямо', async () => {
    /**
     * Здесь вся цена проверки. Человек нажимает кнопку с названием, от
     * которого ждёт удаления; §13.6 обещает обратное — записи уходят из
     * выдачи и остаются доступны через бэклог. Удали их обработчик — и
     * бот отнял бы то, чего человек не отдавал, а обещание в тексте
     * осталось бы прежним.
     */
    const { bot } = createTestBot();
    await bot.init();
    await sow(2);

    await bot.handleUpdate(callbackUpdate(RETURNING_ACTION.fresh));

    const all = await testDb().select().from(items).where(eq(items.userId, userId));
    expect(all).toHaveLength(2);
    // Статус не тронут: человек не отменял эти дела и не выполнял их.
    expect(all.every((one) => one.status === 'new')).toBe(true);
    expect(all.every((one) => one.text.startsWith('Дело номер'))).toBe(true);
  });

  it('сказанное при возвращении остаётся: кнопка знает свою выгрузку (ревизия этапа 3, H1)', async () => {
    /**
     * Приветствие уходит в начале разбора той самой выгрузки, а её дела
     * сохраняются секундами позже. Кнопка несёт код выгрузки, и «старое»
     * — это созданное до того, как она открылась.
     */
    const { bot, calls } = createTestBot();
    await bot.init();
    const [old] = await sow(1, 20);

    const [batch] = await testDb()
      .insert(batches)
      .values({ userId, status: 'done', openedAt: new Date(Date.now() - 60_000) })
      .returning({ id: batches.id });
    const [fresh] = await sow(1, 0);

    await bot.handleUpdate(
      callbackUpdate(`${RETURNING_ACTION.fresh}:${toShortId(batch?.id ?? '')}`),
    );

    const rows = await testDb().select().from(items).where(eq(items.userId, userId));
    expect(rows.find((one) => one.id === old)?.backgroundedAt).not.toBeNull();
    expect(rows.find((one) => one.id === fresh)?.backgroundedAt).toBeNull();
    expect(edits(calls)).toEqual([defaultTexts.returning.moved(1)]);
  });

  it('старая кнопка без кода выгрузки не уносит сказанное за последние две недели', async () => {
    // Кнопки прежней формы остаются в чатах; для них граница — пауза
    // §13.6: моложе неё «старым» быть не может.
    const { bot } = createTestBot();
    await bot.init();
    const [old] = await sow(1, 20);
    const [recent] = await sow(1, 3);

    await bot.handleUpdate(callbackUpdate(RETURNING_ACTION.fresh));

    const rows = await testDb().select().from(items).where(eq(items.userId, userId));
    expect(rows.find((one) => one.id === old)?.backgroundedAt).not.toBeNull();
    expect(rows.find((one) => one.id === recent)?.backgroundedAt).toBeNull();
  });

  it('уносить нечего — так и говорит, а не молчит', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(RETURNING_ACTION.fresh));

    expect(edits(calls)).toEqual([defaultTexts.returning.nothingToMove]);
  });

  it('второе нажатие по той же кнопке не роняет обработчик', async () => {
    // Сообщение с кнопкой остаётся в переписке, и нажать её можно снова.
    const { bot, calls } = createTestBot();
    await bot.init();
    await sow(1);

    await bot.handleUpdate(callbackUpdate(RETURNING_ACTION.fresh));
    await bot.handleUpdate(callbackUpdate(RETURNING_ACTION.fresh));

    expect(calls.filter((call) => call.method === 'answerCallbackQuery')).toHaveLength(2);
    expect(edits(calls)).toEqual([
      defaultTexts.returning.moved(1),
      defaultTexts.returning.nothingToMove,
    ]);
  });

  it('чужой человек своей кнопкой чужие записи не уносит', async () => {
    /**
     * Обработчик находит человека по идентификатору Telegram, и записи
     * берутся его. Проверка держит это свойство: перепутай он владельца —
     * и нажатие у одного убрало бы дела у другого.
     */
    const { bot } = createTestBot();
    await bot.init();
    await sow(2);

    const stranger = await upsertUser(testDb(), { tgId: TG_ID + 1, firstName: 'Пётр' });
    await testDb().insert(items).values({
      userId: stranger.id,
      text: 'Чужое дело',
      type: 'TASK',
      priority: 'SOON',
      topic: 'дом',
    });

    await bot.handleUpdate(callbackUpdate(RETURNING_ACTION.fresh));

    const [alien] = await testDb().select().from(items).where(eq(items.userId, stranger.id));
    expect(alien?.backgroundedAt).toBeNull();
  });
});
