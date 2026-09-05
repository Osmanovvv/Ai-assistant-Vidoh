import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { items, type Item } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { recordOffer } from '../../modules/recurrence/suggestions.repo.js';
import { SUGGEST_ACTION, rhythmInWords } from '../../modules/recurrence/suggest-text.js';
import { toShortId } from '../../modules/shared/short-id.js';
import { setTimezone } from '../../modules/onboarding/onboarding.service.js';
import { upsertUser } from '../../modules/users/users.repo.js';
import { testDb } from '../../test/db.js';
import { defaultTexts } from '../../texts/index.js';
import { registerSuggestHandlers } from './suggest.js';

/**
 * Кнопка «Да, запомни» под замеченной регулярностью (задача 3.8в).
 *
 * **Обработчик не проверялся ни одним тестом до 05.09.2026** — а он
 * записывает человеку правило на всё будущее: из якоря берутся день
 * недели и число месяца, и промах в один день сдвигает **каждое**
 * следующее напоминание.
 *
 * Разрыв «служба работает, а в боте не вызывается» этот проект уже ловил
 * на статусном сообщении, поэтому связка проверяется целиком: нажатие →
 * запись в базе.
 */

const logger = createLogger({ level: 'silent' });
const TG_ID = 6161;

/** Четверг 03.09.2026 в поясе человека — и среда 02.09 по Гринвичу. */
const THURSDAY_IN_OMSK = new Date('2026-09-02T18:00:00.000Z');
const THURSDAY_IN_MOSCOW = new Date('2026-09-02T21:00:00.000Z');

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

  registerSuggestHandlers(bot, testDb(), logger);
  return { bot, calls };
}

function callbackUpdate(data: string): Update {
  seq++;

  return {
    update_id: 800_000 + seq,
    callback_query: {
      id: String(seq),
      from: { id: TG_ID, is_bot: false, first_name: 'Аня' },
      chat_instance: 'test',
      data,
      message: { message_id: 1, date: 0, chat: { id: TG_ID, type: 'private' } },
    },
  } as unknown as Update;
}

/** Дело со сроком в четверг и предложение запомнить недельный ритм. */
async function offered(deadlineAt: Date | null): Promise<{ item: Item; action: string }> {
  const [item] = await testDb()
    .insert(items)
    .values({
      userId,
      text: 'Отвезти сына на плавание',
      type: 'TASK',
      priority: 'SOON',
      topic: 'дети',
      ...(deadlineAt === null ? {} : { deadlineAt, deadlineAccuracy: 'day' as const }),
    })
    .returning();

  if (!item) throw new Error('запись не создалась');

  const offer = await recordOffer(testDb(), {
    userId,
    itemId: item.id,
    itemIds: [item.id],
    rhythm: { kind: 'weekly', interval: 1, medianDays: 7 },
  });

  return { item, action: `${SUGGEST_ACTION.accept}${toShortId(offer.id)}` };
}

async function reread(id: string): Promise<Item> {
  const [row] = await testDb().select().from(items).where(eq(items.id, id));
  if (!row) throw new Error('запись пропала');
  return row;
}

beforeEach(async () => {
  seq++;
  userId = (await upsertUser(testDb(), { tgId: TG_ID, firstName: 'Аня' })).id;
});

describe('«Да, запомни» под замеченной регулярностью', () => {
  it('выставляет правило и оставляет одну запись', async () => {
    const { bot } = createTestBot();
    await bot.init();
    const { item, action } = await offered(THURSDAY_IN_MOSCOW);

    await bot.handleUpdate(callbackUpdate(action));

    const after = await reread(item.id);
    expect((after.recurrenceRule as { kind: string } | null)?.kind).toBe('weekly');

    const all = await testDb().select().from(items).where(eq(items.userId, userId));
    expect(all).toHaveLength(1);
  });

  it('якорь правила — день человека, а не дата по Гринвичу', async () => {
    /**
     * **Задача 3.74, и это самое дорогое здесь.** Схема правила требует
     * дату в поясе человека, а бралась она из `toISOString()`. Четверг
     * у москвича — это среда 21:00 по UTC, у омича — среда 18:00.
     *
     * Правило «каждый четверг» становилось правилом «каждую среду» —
     * навсегда, и человек об этом ниоткуда бы не узнал: в карточке он
     * увидел бы свои же слова «каждый четверг».
     */
    for (const [zone, deadline] of [
      ['Europe/Moscow', THURSDAY_IN_MOSCOW],
      ['Asia/Omsk', THURSDAY_IN_OMSK],
    ] as const) {
      await setTimezone(testDb(), userId, zone);

      const { bot } = createTestBot();
      await bot.init();
      const { item, action } = await offered(deadline);

      await bot.handleUpdate(callbackUpdate(action));

      const rule = (await reread(item.id)).recurrenceRule as { anchor: string } | null;
      expect(rule?.anchor, zone).toBe('2026-09-03');

      await testDb().delete(items).where(eq(items.userId, userId));
    }
  });

  it('у дела без срока якорем становится сегодня, и запись остаётся целой', async () => {
    /**
     * Здесь `new Date()` — настоящее «сейчас», и проверять число нельзя:
     * тест покраснел бы сам по себе. Проверяется то, что от этого
     * зависит: правило выставилось, а не пропало из-за пустого якоря.
     */
    const { bot } = createTestBot();
    await bot.init();
    const { item, action } = await offered(null);

    await bot.handleUpdate(callbackUpdate(action));

    const after = await reread(item.id);
    expect((after.recurrenceRule as { kind: string } | null)?.kind).toBe('weekly');
    expect(after.text).toBe('Отвезти сына на плавание');
  });

  it('фраза правила — та, что человек видел в вопросе', async () => {
    /**
     * **Задача 3.75.** Здесь передавалась пустая фраза, а проверка
     * правила отвергает вид без фразы: «показывать человеку
     * „регулярное“ без того, что он сказал, нельзя». Правило не
     * выставлялось **ни разу** — при том что бот отвечал «Запомнила».
     *
     * Фраза берётся оттуда же, откуда её взял вопрос, — иначе человек
     * в карточке увидел бы не то, на что согласился.
     */
    const { bot } = createTestBot();
    await bot.init();
    const { item, action } = await offered(THURSDAY_IN_MOSCOW);

    await bot.handleUpdate(callbackUpdate(action));

    const after = await reread(item.id);
    expect(after.recurrenceText).toBe(rhythmInWords({ kind: 'weekly', interval: 1 }));
    expect(after.recurrenceText).toBe('каждую неделю');
  });

  it('в базе видно, что правило заметил бот, а не назвал человек', async () => {
    /**
     * Способ 3 запроса на изменение №1 — «бот сам замечает
     * повторяемость». Ляг такое правило источником `stated`, и его стало
     * бы нечем отличить от правила, названного человеком: в карточке
     * видна фраза, а фраза здесь наша.
     */
    const { bot } = createTestBot();
    await bot.init();
    const { item, action } = await offered(THURSDAY_IN_MOSCOW);

    await bot.handleUpdate(callbackUpdate(action));

    expect((await reread(item.id)).recurrenceSource).toBe('noticed');
  });

  it('под ответом есть кнопка отката', async () => {
    // Правило пишется на всё будущее, и §7.3 требует один тап назад.
    const { bot, calls } = createTestBot();
    await bot.init();
    const { action } = await offered(THURSDAY_IN_MOSCOW);

    await bot.handleUpdate(callbackUpdate(action));

    const edit = calls.findLast((call) => call.method === 'editMessageText');
    const markup = edit?.payload['reply_markup'] as
      { inline_keyboard: { text: string }[][] } | undefined;

    expect(markup?.inline_keyboard[0]?.[0]?.text).toBe(defaultTexts.resolver.buttonUndo);
  });

  it('нажатие по вчерашней кнопке не роняет обработчик', async () => {
    // Предложение закрыто, а сообщение с кнопками осталось в переписке.
    const { bot, calls } = createTestBot();
    await bot.init();
    const { action } = await offered(THURSDAY_IN_MOSCOW);

    await bot.handleUpdate(callbackUpdate(action));
    await bot.handleUpdate(callbackUpdate(action));

    // Человеку ответили оба раза: молчание кнопки читается как поломка.
    expect(calls.filter((call) => call.method === 'answerCallbackQuery')).toHaveLength(2);
  });
});
