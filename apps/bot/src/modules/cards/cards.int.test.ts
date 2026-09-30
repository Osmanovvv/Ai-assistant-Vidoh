import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { GrammyError, InputFile, type Api } from 'grammy';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { appSettings } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { CARD_FILES, cardsDir, createCardSender, type CardName } from './cards.js';

/**
 * Бренд-карточки (ТЗ по визуалам, проджект 18.09.2026).
 *
 * Картинка уходит в Telegram один раз — дальше по `file_id`, который
 * Telegram вернул: слать 270 КБ на каждое «доброе утро» незачем. Отказ
 * отправки не роняет сценарий: карточка — украшение, суть идёт текстом.
 */

const logger = createLogger({ level: 'silent' });
const CHAT = 4242;

interface Sent {
  readonly photo: unknown;
  readonly options: Record<string, unknown> | undefined;
}

function fakeApi(
  behave: (sent: Sent, calls: number) => Promise<unknown> = (_sent, calls) =>
    Promise.resolve({
      message_id: 100 + calls,
      photo: [{ file_id: 'small' }, { file_id: `big-${String(calls)}` }],
    }),
): { api: Api; sent: Sent[] } {
  const sent: Sent[] = [];
  const api = {
    sendPhoto: vi.fn(async (_chatId: number, photo: unknown, options?: Record<string, unknown>) => {
      const one = { photo, options };
      sent.push(one);
      return await behave(one, sent.length);
    }),
  } as unknown as Api;

  return { api, sent };
}

async function cachedId(card: CardName): Promise<string | undefined> {
  const [row] = await testDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, `card.file_id.${card}`));
  return row?.value;
}

beforeEach(async () => {
  await testDb().delete(appSettings);
});

describe('файлы карточек на месте', () => {
  it('все шесть лежат в папке ресурсов бота', () => {
    for (const name of Object.keys(CARD_FILES) as CardName[]) {
      expect(existsSync(join(cardsDir(), CARD_FILES[name])), name).toBe(true);
    }
  });
});

describe('отправка карточки', () => {
  it('первый раз — файлом, и file_id из ответа запоминается', async () => {
    const { api, sent } = fakeApi();
    const cards = createCardSender({ api, db: testDb(), logger });

    const messageId = await cards.send({ chatId: CHAT, card: 'start', caption: 'Просто напиши.' });

    expect(messageId).toBe(101);
    expect(sent[0]?.photo).toBeInstanceOf(InputFile);
    expect(sent[0]?.options?.['caption']).toBe('Просто напиши.');
    expect(await cachedId('start')).toBe('big-1');
  });

  it('пустая подпись — картинка без текста, поля подписи нет вовсе (30.09.2026)', async () => {
    const { api, sent } = fakeApi();
    const cards = createCardSender({ api, db: testDb(), logger });

    await cards.send({ chatId: CHAT, card: 'start', caption: '' });

    expect(sent[0]?.options).not.toHaveProperty('caption');
  });

  it('второй раз — по запомненному file_id, без файла', async () => {
    const { api, sent } = fakeApi();
    const cards = createCardSender({ api, db: testDb(), logger });

    await cards.send({ chatId: CHAT, card: 'week', caption: 'Неделя.' });
    await cards.send({ chatId: CHAT, card: 'week', caption: 'Неделя.' });

    expect(sent[1]?.photo).toBe('big-1');
  });

  it('Telegram отверг запомненный file_id — повтор файлом, запомненное заменяется', async () => {
    const { api, sent } = fakeApi((one, calls) =>
      typeof one.photo === 'string'
        ? Promise.reject(
            new GrammyError(
              'sendPhoto',
              {
                ok: false,
                error_code: 400,
                description: 'Bad Request: wrong file identifier/HTTP URL specified',
              },
              'sendPhoto',
              {},
            ),
          )
        : Promise.resolve({
            message_id: 200 + calls,
            photo: [{ file_id: `fresh-${String(calls)}` }],
          }),
    );
    const cards = createCardSender({ api, db: testDb(), logger });
    await testDb().insert(appSettings).values({ key: 'card.file_id.evening', value: 'stale' });

    const messageId = await cards.send({
      chatId: CHAT,
      card: 'evening',
      caption: 'На сегодня всё 🤍',
    });

    expect(sent.map((one) => (typeof one.photo === 'string' ? one.photo : 'file'))).toEqual([
      'stale',
      'file',
    ]);
    expect(messageId).toBe(202);
    expect(await cachedId('evening')).toBe('fresh-2');
  });

  it('кнопки и ветка уходят вместе с фото', async () => {
    const { api, sent } = fakeApi();
    const cards = createCardSender({ api, db: testDb(), logger });

    await cards.send({
      chatId: CHAT,
      threadId: 7,
      card: 'week',
      caption: 'Неделя.',
      buttons: [
        { label: 'Выбрать главное', action: 'a:pick' },
        { label: 'Мои дела', action: 'menu:all' },
      ],
    });

    const options = sent[0]?.options ?? {};
    expect(options['message_thread_id']).toBe(7);
    const markup = options['reply_markup'] as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    expect(markup.inline_keyboard.flat().map((button) => button.text)).toEqual([
      'Выбрать главное',
      'Мои дела',
    ]);
  });

  it('отправка не удалась — ноль, без исключения; ничего не запоминается', async () => {
    const { api } = fakeApi(() => Promise.reject(new Error('сеть')));
    const cards = createCardSender({ api, db: testDb(), logger });

    await expect(cards.send({ chatId: CHAT, card: 'start', caption: 'x' })).resolves.toBe(0);
    expect(await cachedId('start')).toBeUndefined();
  });
});
