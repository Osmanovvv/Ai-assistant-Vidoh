import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BotError } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { describe, expect, it } from 'vitest';

import { createBot } from './bot.js';

/**
 * Где на самом деле стоит рубеж от сбоя обработки апдейта.
 *
 * **Что было.** В `index.ts` стоял обработчик ошибок бота со строкой
 * «Ошибка в обработчике апдейта» — и не срабатывал никогда. grammY зовёт
 * его из одного места: разбора пачки апдейтов при длинных опросах. Мы
 * работаем вебхуком, `webhookCallback` зовёт `handleUpdate`, а тот
 * перебрасывает отказ наружу обёрнутым в `BotError`.
 *
 * Мнимый рубеж хуже отсутствующего: за пропавшей ошибкой апдейта человек
 * пошёл бы искать туда, где никогда ничего не писалось, — и не нашёл бы
 * ни строки, ни причины. Проверки на него не было вовсе: убрать его или
 * выпотрошить можно было, не покраснев нигде.
 *
 * Здесь два стража. Первый мерит поведение библиотеки — то самое, из-за
 * которого рубеж мнимый; он же покраснеет, если новая версия grammY
 * начнёт водить отказы вебхука через обработчик бота, и тогда решение
 * можно будет пересмотреть со числами в руках. Второй смотрит в исходник
 * `index.ts`: мнимый рубеж не должен вернуться молча, а живой приёмник
 * `onError` — исчезнуть.
 */

/** Заведомо ненастоящий токен: репозиторий публичный. */
const FAKE_TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** botInfo задан вручную, поэтому bot.init() не ходит в сеть. */
const BOT_INFO: UserFromGetMe = {
  id: 123_456_789,
  is_bot: true,
  first_name: 'Выдох',
  username: 'aividoh_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: true,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

const UPDATE: Update = {
  update_id: 77,
  message: {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 5, type: 'private', first_name: 'Аня' },
    from: { id: 5, is_bot: false, first_name: 'Аня' },
    text: 'мысль, на которой обработчик отказал',
  },
};

/** Перевод строки кодом: обратный слеш по пути сюда теряется. */
const NEWLINE = String.fromCharCode(10);

/**
 * Исходник без комментариев.
 *
 * Страж по исходнику обязан отличать код от объяснения: в `index.ts`
 * снятый обработчик назван и разобран дословно — иначе следующий не
 * поймёт, почему его там нет. Проверка, которая краснеет на объяснении,
 * учит убирать объяснения.
 *
 * Разбор без регулярных выражений и построчного «начинается со звёздочки»:
 * объяснение в `index.ts` — блочный комментарий, чьи строки начинаются с
 * обычных слов, и такой фильтр его не увидел бы.
 */
function withoutComments(source: string): string {
  const kept: string[] = [];
  let rest = source;

  for (;;) {
    const open = rest.indexOf('/*');

    if (open < 0) {
      kept.push(rest);
      break;
    }

    kept.push(rest.slice(0, open));
    const close = rest.indexOf('*/', open + 2);

    if (close < 0) break;

    rest = rest.slice(close + 2);
  }

  return kept
    .join('')
    .split(NEWLINE)
    .map((line) => {
      const at = line.indexOf('//');

      // Двоеточие перед двумя косыми — это адрес вида https://, а не
      // комментарий.
      return at < 0 || line[at - 1] === ':' ? line : line.slice(0, at);
    })
    .join(NEWLINE);
}

function startupCode(): string {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../index.ts');

  return withoutComments(readFileSync(path, 'utf8'));
}

describe('рубеж от сбоя обработки апдейта', () => {
  it('в режиме вебхука отказ обработчика не доходит до обработчика ошибок бота', async () => {
    const bot = createBot(FAKE_TOKEN, { botInfo: BOT_INFO });

    let handled = 0;
    const handler = (): void => {
      handled += 1;
    };

    bot.catch(handler);
    bot.on('message:text', () => {
      throw new Error('обработка отказала');
    });
    await bot.init();

    /**
     * `handleUpdate` — именно то, что зовёт `webhookCallback`. Отказ
     * уходит наружу, до обработчика ошибок express, и там его ждёт
     * `onError`: журнал и доля ошибок §18.
     */
    await expect(bot.handleUpdate(UPDATE)).rejects.toBeInstanceOf(BotError);

    expect(
      handled,
      'grammY повёл отказ вебхука через обработчик ошибок бота: поведение изменилось, ' +
        'решение «рубеж живёт в http/server.ts» надо пересмотреть заново',
    ).toBe(0);

    // Обработчик при этом установлен и ждёт — просто зовут его только с
    // пути длинных опросов, которого у нас нет.
    expect(bot.errorHandler).toBe(handler);
  });

  it('мнимый рубеж не вернулся в боевую сборку', () => {
    expect(
      startupCode().includes('bot.catch('),
      'в src/index.ts снова стоит обработчик ошибок бота. В режиме вебхука он не ' +
        'срабатывает ни разу (замер 09.09.2026 на grammY 1.45.1: обработчик звали = 0), ' +
        'и его строка в журнале обещает рубеж, которого нет. Отказ обработки апдейта ' +
        'ловит обработчик ошибок express и отдаёт в onError',
    ).toBe(false);
  });

  it('живой приёмник сбоя обработки апдейта на месте и считает его в §18', () => {
    /**
     * Убрать мнимый рубеж и заодно потерять настоящий — ровно то, чего
     * нельзя допустить. Настоящий — `onError` в аргументах `createServer`:
     * из него идёт и строка в журнал, и провал в долю ошибок §18, ради
     * которой §18 вообще шлёт оповещения.
     *
     * Окно в двести знаков после сообщения, а не разбор скобок: так
     * проверка терпит переформатирование, но не терпит приёмник, который
     * пишет в журнал и молчит мониторингу.
     */
    const code = startupCode();
    const at = code.indexOf('Сбой обработки апдейта');

    expect(
      at,
      'в src/index.ts нет приёмника сбоя обработки апдейта: express ответит Telegram ' +
        'пятисотым, а мы о сбое не узнаем ни из журнала, ни из доли ошибок §18',
    ).toBeGreaterThan(-1);

    expect(
      code.slice(at, at + 200).includes('recordOutcome(false)'),
      'сбой обработки апдейта больше не считается в долю ошибок §18: оповещение по §18 ' +
        'перестанет приходить о том, ради чего написано',
    ).toBe(true);
  });
});
