import { and, eq, isNotNull } from 'drizzle-orm';
import { GrammyError, Api } from 'grammy';

import { topics, users } from '../db/schema.js';
import { closeDb, getDb } from '../infra/db.js';
import { createLogger } from '../infra/logger.js';
import { createTopicGateway, retryAfterSeconds } from '../modules/topics/gateway.js';
import { normalizeTopicName } from '../modules/topics/topics.repo.js';
import { updateThreadIcon, type ThreadIconResult } from '../modules/topics/topics.service.js';
import { isBlockedError } from '../modules/users/blocked.js';

/**
 * Иконки уже созданных веток — по нынешней карте сфер (правка заказчицы
 * 30.09.2026: семья ❤️, личное ⭐️).
 *
 * Иконка ставится при создании ветки, и новая карта до созданных веток
 * сама не доходит. Разовый проход правит их правкой ветки. Бесплатно:
 * это вызовы Telegram, модели нет.
 *
 * Запуск (в контейнере бота):
 *   node dist/scripts/refresh-topic-icons.js --topics семья,личное            — только счёт
 *   node dist/scripts/refresh-topic-icons.js --topics семья,личное --apply    — поставить
 *   … --user <uuid>                                                           — одному человеку
 *
 * Печатает только числа: ни имён, ни названий, ни токена.
 */

const APPLY = process.argv.includes('--apply');

function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const topicNames = (argOf('--topics') ?? '')
  .split(',')
  .map((name) => normalizeTopicName(name))
  .filter((name) => name !== '');
const onlyUser = argOf('--user');

if (topicNames.length === 0) {
  process.stdout.write('Укажите сферы: --topics семья,личное\n');
  process.exit(1);
}

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

  const targets = rows.filter((row) => topicNames.includes(normalizeTopicName(row.name)));
  process.stdout.write(
    `Веток с такими сферами: ${String(targets.length)} у ${String(new Set(targets.map((row) => row.userId)).size)} человек.\n`,
  );

  if (!APPLY) {
    process.stdout.write('Это только счёт. Чтобы поставить иконки, добавьте --apply.\n');
  } else {
    const counts = new Map<ThreadIconResult | 'blocked' | 'failed', number>();
    const count = (key: ThreadIconResult | 'blocked' | 'failed'): void => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    };

    for (const row of targets) {
      const once = (): Promise<ThreadIconResult> =>
        updateThreadIcon({ db, gateway, logger }, { topicId: row.topicId, chatId: row.chatId });

      try {
        count(await once());
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
      `Поставлено: ${String(counts.get('set') ?? 0)}; ветки нет: ${String(counts.get('no-thread') ?? 0)}; ` +
        `ветку удалили: ${String(counts.get('gone') ?? 0)}; иконки нет в наборе: ${String(counts.get('no-icon') ?? 0)}; ` +
        `бот заблокирован: ${String(counts.get('blocked') ?? 0)}; отказ: ${String(counts.get('failed') ?? 0)}.\n`,
    );
  }
} finally {
  await closeDb();
}
