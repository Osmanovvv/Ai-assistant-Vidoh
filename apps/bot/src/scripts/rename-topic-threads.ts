import { and, eq, isNotNull } from 'drizzle-orm';
import { GrammyError, Api } from 'grammy';

import { topics, users } from '../db/schema.js';
import { closeDb, getDb } from '../infra/db.js';
import { createLogger } from '../infra/logger.js';
import { createTopicGateway, retryAfterSeconds } from '../modules/topics/gateway.js';
import { refreshSummaries } from '../modules/topics/summary.service.js';
import { updateThreadName, type ThreadNameResult } from '../modules/topics/topics.service.js';
import { isBlockedError } from '../modules/users/blocked.js';
import { outputContextOf } from '../modules/users/state.repo.js';

/**
 * Готовые ветки — с заглавной, и заголовки сводок в них тоже (правка
 * заказчицы 30.09.2026: «Личное», «Дом», «Покупки»).
 *
 * Новые ветки так и создаются, а созданные до правки остались строчными:
 * имя вкладки ставится при создании, заголовок сводки — при её
 * обновлении. Разовый проход переименовывает вкладки и перечитывает
 * сводки (неизменённые не правятся). Бесплатно: вызовы Telegram, модели нет.
 *
 * Запуск (в контейнере бота):
 *   node dist/scripts/rename-topic-threads.js                    — только счёт
 *   node dist/scripts/rename-topic-threads.js --apply            — сделать
 *   … --user <uuid>                                              — одному человеку
 *
 * Печатает только числа: ни имён, ни названий, ни токена.
 */

const APPLY = process.argv.includes('--apply');
const userIndex = process.argv.indexOf('--user');
const onlyUser = userIndex === -1 ? undefined : process.argv[userIndex + 1];

const token = process.env['BOT_TOKEN'];
if (token === undefined || token === '') {
  process.stdout.write('Нет BOT_TOKEN в окружении.\n');
  process.exit(1);
}

const db = getDb();
const logger = createLogger({ level: 'warn' });
const gateway = createTopicGateway(new Api(token));
const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

try {
  const rows = await db
    .select({ topicId: topics.id, name: topics.name, userId: topics.userId, chatId: users.tgId })
    .from(topics)
    .innerJoin(users, eq(users.id, topics.userId))
    .where(
      and(
        isNotNull(topics.tgThreadId),
        ...(onlyUser === undefined ? [] : [eq(topics.userId, onlyUser)]),
      ),
    );

  const people = [...new Set(rows.map((row) => row.userId))];
  process.stdout.write(`Веток: ${String(rows.length)} у ${String(people.length)} человек.\n`);

  if (!APPLY) {
    process.stdout.write('Это только счёт. Чтобы переименовать, добавьте --apply.\n');
  } else {
    const counts = new Map<ThreadNameResult | 'blocked' | 'failed', number>();
    const count = (key: ThreadNameResult | 'blocked' | 'failed'): void => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    };

    for (const row of rows) {
      const once = (): Promise<ThreadNameResult> =>
        updateThreadName({ db, gateway, logger }, { topicId: row.topicId, chatId: row.chatId });

      try {
        const result = await once();
        count(result);
        if (result === 'same') continue;
      } catch (error) {
        const wait = retryAfterSeconds(error);
        if (wait !== undefined) {
          await pause(wait * 1000);
          try {
            count(await once());
          } catch {
            count('failed');
          }
        } else if (isBlockedError(error)) {
          count('blocked');
        } else {
          count('failed');
          const reason = error instanceof GrammyError ? error.description : 'не Telegram';
          process.stdout.write(`  отказ: ${reason}\n`);
        }
      }

      // Telegram не любит очередь правок подряд — пауза между ветками.
      await pause(200);
    }

    process.stdout.write(
      `Переименовано: ${String(counts.get('set') ?? 0)}; уже с заглавной: ${String(counts.get('same') ?? 0)}; ` +
        `ветки нет: ${String(counts.get('no-thread') ?? 0)}; ветку удалили: ${String(counts.get('gone') ?? 0)}; ` +
        `бот заблокирован: ${String(counts.get('blocked') ?? 0)}; отказ: ${String(counts.get('failed') ?? 0)}.\n`,
    );

    // Заголовки сводок — тем же проходом: неизменённые не правятся.
    let refreshed = 0;
    for (const userId of people) {
      const mine = rows.filter((row) => row.userId === userId);
      const chatId = mine[0]?.chatId;
      if (chatId === undefined) continue;
      const context = await outputContextOf(db, userId);
      try {
        refreshed += await refreshSummaries(
          { db, gateway, logger },
          {
            userId,
            chatId,
            topicNames: mine.map((row) => row.name),
            timeZone: context.timeZone,
            profile: context.textProfile,
          },
        );
      } catch {
        process.stdout.write('  сводки одного человека не обновились\n');
      }
    }
    process.stdout.write(`Сводок обновлено: ${String(refreshed)}.\n`);
  }
} finally {
  await closeDb();
}
