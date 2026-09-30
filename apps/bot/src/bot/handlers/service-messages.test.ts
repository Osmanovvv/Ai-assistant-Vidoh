import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { describe, expect, it } from 'vitest';

import { createLogger } from '../../infra/logger.js';
import { registerServiceMessageHandlers } from './service-messages.js';

/**
 * Служебные сообщения Telegram о наших же действиях — прочь (заказчица,
 * 16.09.2026).
 *
 * На видео после первой выгрузки чат заполнили «„семья" создана» — по
 * одной на каждую сферу. Её слова: «технические уведомления вообще
 * убрать, чтобы женщина раз увидела — папочки созданы, всё супер». Ветку
 * создаёт бот, значит и служебная строка о ней — его: в личном чате бот
 * вправе удалить сообщение, и он это делает. Не вышло — не беда, строка
 * останется. Закрепов бот с того же дня не делает вовсе.
 */
const TG_ID = 4242;
const logger = createLogger({ level: 'silent' });

interface ApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

function createTestBot(options: { readonly deleteFails?: boolean } = {}) {
  const botInfo = {
    id: 1,
    is_bot: true,
    first_name: 'Тест',
    username: 'vydoh_test_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  } as unknown as UserFromGetMe;

  const bot = new Bot('123456789:TESTTESTTESTTESTTESTTESTTESTTEST', { botInfo });
  const calls: ApiCall[] = [];

  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload });
    if (method === 'deleteMessage' && options.deleteFails === true) {
      return Promise.resolve({
        ok: false,
        error_code: 400,
        description: 'Bad Request: message can’t be deleted',
      } as never);
    }
    return Promise.resolve({ ok: true, result: true } as never);
  });

  registerServiceMessageHandlers(bot, logger);

  return { bot, calls };
}

let seq = 0;

function serviceUpdate(
  extra: Record<string, unknown>,
  chat: Record<string, unknown> = { id: TG_ID, type: 'private', first_name: 'Аня' },
): Update {
  seq++;
  return {
    update_id: 800_000 + seq,
    message: {
      message_id: 100 + seq,
      date: 0,
      chat,
      from: { id: 1, is_bot: true, first_name: 'Тест' },
      ...extra,
    },
  } as unknown as Update;
}

describe('служебные сообщения о ветках и закреплении', () => {
  it('«ветка создана» в личном чате удаляется', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    const update = serviceUpdate({ forum_topic_created: { name: 'семья', icon_color: 0 } });
    await bot.handleUpdate(update);

    const removed = calls.find((call) => call.method === 'deleteMessage');
    expect(removed?.payload).toEqual({ chat_id: TG_ID, message_id: 100 + seq });
  });

  it('«закрепил сообщение» не трогается: бот больше не закрепляет, а чужой закреп — дело человека', async () => {
    // С 16.09.2026 сводки не закрепляются (заказчица: «отдельные
    // закрепления — не показывать»); строка о закрепе может быть только
    // её собственной, и удалять её — стирать её действие.
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(
      serviceUpdate({
        pinned_message: { message_id: 5, date: 0, text: 'семья — что здесь есть:' },
      }),
    );

    expect(calls).toEqual([]);
  });

  it('не в личном чате не трогает', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(
      serviceUpdate(
        { forum_topic_created: { name: 'семья', icon_color: 0 } },
        { id: -100_500, type: 'supergroup', title: 'Группа', is_forum: true },
      ),
    );

    expect(calls).toEqual([]);
  });

  describe('«тема изменена» — удаляется, если изменил сам бот (30.09.2026)', () => {
    /**
     * Смена иконок и переименование веток 30.09.2026 оставили в ветках
     * «название темы изменено» — то же техническое уведомление, что
     * «ветка создана». Только своё: если вкладку переименовала сама
     * женщина, строка — её действие, и стирать его нельзя.
     */
    it('изменил бот — строка удаляется', async () => {
      const { bot, calls } = createTestBot();
      await bot.init();

      await bot.handleUpdate(serviceUpdate({ forum_topic_edited: { name: 'Семья' } }));

      const removed = calls.find((call) => call.method === 'deleteMessage');
      expect(removed?.payload).toEqual({ chat_id: TG_ID, message_id: 100 + seq });
    });

    it('иконку сменил бот — тоже удаляется', async () => {
      const { bot, calls } = createTestBot();
      await bot.init();

      await bot.handleUpdate(
        serviceUpdate({ forum_topic_edited: { icon_custom_emoji_id: '5312241539987020022' } }),
      );

      expect(calls.map((call) => call.method)).toEqual(['deleteMessage']);
    });

    it('изменила сама женщина — не трогается', async () => {
      const { bot, calls } = createTestBot();
      await bot.init();

      await bot.handleUpdate(
        serviceUpdate({
          forum_topic_edited: { name: 'Моя семья' },
          from: { id: TG_ID, is_bot: false, first_name: 'Аня' },
        }),
      );

      expect(calls).toEqual([]);
    });

    it('не в личном чате не трогает', async () => {
      const { bot, calls } = createTestBot();
      await bot.init();

      await bot.handleUpdate(
        serviceUpdate(
          { forum_topic_edited: { name: 'Семья' } },
          { id: -100_500, type: 'supergroup', title: 'Группа', is_forum: true },
        ),
      );

      expect(calls).toEqual([]);
    });

    it('отказ Telegram удалить — не ошибка обработчика', async () => {
      const { bot } = createTestBot({ deleteFails: true });
      await bot.init();

      await expect(
        bot.handleUpdate(serviceUpdate({ forum_topic_edited: { name: 'Семья' } })),
      ).resolves.toBeUndefined();
    });
  });

  it('отказ Telegram удалить — не ошибка обработчика', async () => {
    const { bot, calls } = createTestBot({ deleteFails: true });
    await bot.init();

    await expect(
      bot.handleUpdate(serviceUpdate({ forum_topic_created: { name: 'семья', icon_color: 0 } })),
    ).resolves.toBeUndefined();

    expect(calls.map((call) => call.method)).toEqual(['deleteMessage']);
  });
});
