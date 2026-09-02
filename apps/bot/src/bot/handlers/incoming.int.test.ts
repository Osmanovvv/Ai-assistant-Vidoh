import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, messagesRaw } from '../../db/schema.js';
import type { PipelineJob } from '../../infra/queue.js';
import { upsertUser } from '../../modules/users/users.repo.js';
import { testDb } from '../../test/db.js';
import { defaultTexts } from '../../texts/index.js';
import { incomingMiddleware } from './incoming.js';

/**
 * Потолок выгрузок за сутки через настоящий обработчик (задача 1.12).
 *
 * Условие готовности задачи звучит так: «31-я выгрузка за сутки **вежливо**
 * отклоняется». Проверено было только слово «отклоняется» — тесты на
 * `isOverDumpLimit` считают выгрузки и возвращают да/нет. А «вежливо» —
 * то есть человек получает ответ, а не тишину, и его сообщение при этом
 * не пропадает — не проверял никто.
 *
 * Разрыв ровно того же вида, на котором уже попадалось статусное
 * сообщение: модуль есть, тест на модуль зелёный, а в боте связка не
 * работает.
 */

const TG_ID = 7373;

interface ApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

const stubQueue = {
  getJob: () => Promise.resolve(undefined),
  add: () => Promise.resolve({}),
} as unknown as Queue<PipelineJob>;

let seq = 0;
let userId: string;

function createTestBot(): { bot: Bot; calls: ApiCall[] } {
  const botInfo = {
    id: 1,
    is_bot: true,
    first_name: 'ВЫДОХ',
    username: 'vydoh_test_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  } as unknown as UserFromGetMe;

  const bot = new Bot('123456789:TESTTESTTESTTESTTESTTESTTESTTEST', { botInfo });
  const calls: ApiCall[] = [];

  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload });

    return Promise.resolve({
      ok: true,
      result: { message_id: calls.length, date: 0, chat: { id: TG_ID, type: 'private' } },
    } as never);
  });

  bot.use(incomingMiddleware({ db: testDb(), queue: stubQueue }));

  return { bot, calls };
}

function textUpdate(text: string): Update {
  seq++;

  return {
    update_id: 700_000 + seq,
    message: {
      message_id: seq,
      date: Math.floor(Date.UTC(2026, 7, 27) / 1000),
      chat: { id: TG_ID, type: 'private', first_name: 'Аня' },
      from: { id: TG_ID, is_bot: false, first_name: 'Аня' },
      text,
    },
  } as unknown as Update;
}

/**
 * Команда — то же сообщение, но с разметкой сущности.
 *
 * Без `entities` grammY считает это обычным текстом, и проверка «команды
 * потолок пропускает» проверяла бы не то.
 */
function commandUpdate(command: string): Update {
  const update = textUpdate(command) as Update & {
    message: { entities?: unknown[] };
  };

  update.message.entities = [{ type: 'bot_command', offset: 0, length: command.length }];

  return update;
}

/** Уже состоявшиеся выгрузки этих суток. */
async function seedDumps(count: number): Promise<void> {
  if (count === 0) return;

  await testDb()
    .insert(batches)
    .values(
      Array.from({ length: count }, () => ({
        userId,
        status: 'done' as const,
        closedAt: new Date(),
        processedAt: new Date(),
      })),
    );
}

async function dumpCount(): Promise<number> {
  const rows = await testDb()
    .select({ id: batches.id })
    .from(batches)
    .where(eq(batches.userId, userId));
  return rows.length;
}

beforeEach(async () => {
  seq = 0;
  const user = await upsertUser(testDb(), { tgId: TG_ID, firstName: 'Аня' });
  userId = user.id;
});

describe('потолок выгрузок за сутки', () => {
  it('31-я выгрузка отклоняется, и человеку это сказано словами', async () => {
    await seedDumps(30);

    const { bot, calls } = createTestBot();
    await bot.handleUpdate(textUpdate('купить продукты'));

    const replies = calls.filter((call) => call.method === 'sendMessage');
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload['text']).toBe(defaultTexts.limits.tooManyDumps);
  });

  it('отклонённое сообщение не теряется: сначала сохраняем, потом думаем', async () => {
    // §9.1 ТЗ. Потолок — причина не заводить разбор, а не причина
    // выбросить слова человека.
    await seedDumps(30);

    const { bot } = createTestBot();
    await bot.handleUpdate(textUpdate('записать сына к врачу'));

    const saved = await testDb().select().from(messagesRaw).where(eq(messagesRaw.userId, userId));
    expect(saved).toHaveLength(1);
    expect(saved[0]?.text).toBe('записать сына к врачу');
  });

  it('новая выгрузка при этом не заводится', async () => {
    await seedDumps(30);

    const { bot } = createTestBot();
    await bot.handleUpdate(textUpdate('купить продукты'));

    expect(await dumpCount()).toBe(30);
  });

  it('команды потолок пропускает — путь к записям не закрыт', async () => {
    /**
     * Реплика о потолке говорит человеку: «посмотреть можно через
     * /menu». Если бы потолок глушил и команды, эта фраза была бы
     * ложью, а человек — заперт от собственных записей до утра.
     *
     * Найдено живым прогоном 03.09.2026: на вопрос «что у меня на
     * сегодня?» бот ответил про потолок. Вопрос действительно упирается
     * в потолок — проверка стоит до разбора, — но записи при этом
     * доступны, и реплика обязана на них указать.
     */
    await seedDumps(30);

    const { bot, calls } = createTestBot();
    await bot.handleUpdate(commandUpdate('/menu'));

    const refusals = calls.filter(
      (call) => call.payload['text'] === defaultTexts.limits.tooManyDumps,
    );
    expect(refusals).toHaveLength(0);
  });

  it('реплика о потолке называет путь к записям', () => {
    // Иначе она тупик: человек не знает, что его дела на месте и видны.
    expect(defaultTexts.limits.tooManyDumps).toContain('/menu');
  });

  it('тридцатая ещё принимается: граница там, где написано', async () => {
    // Проверка самой границы, а не только того, что она где-то есть.
    // Ошибка на единицу здесь означала бы отказ человеку, у которого
    // право ещё было.
    await seedDumps(29);

    const { bot, calls } = createTestBot();
    await bot.handleUpdate(textUpdate('купить продукты'));

    const refusals = calls.filter(
      (call) => call.payload['text'] === defaultTexts.limits.tooManyDumps,
    );
    expect(refusals).toHaveLength(0);
    expect(await dumpCount()).toBe(30);
  });
});
