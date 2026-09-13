import { Api } from 'grammy';

import { parseEnv } from '../config/env.js';
import { closeDb, getDb } from '../infra/db.js';
import { createLogger } from '../infra/logger.js';
import { createQuestionSender } from '../modules/presenter/telegram-sender.js';
import { composeMorning } from '../modules/scheduler/scheduler.service.js';
import { SettingsRegistry } from '../modules/settings/settings.repo.js';
import { textProfileOf } from '../modules/users/settings.repo.js';
import { findByTgId } from '../modules/users/users.repo.js';
import { textsFor } from '../texts/index.js';

/**
 * Прислать утреннее одному человеку прямо сейчас (запрос на изменение
 * №4, 13.09.2026).
 *
 * Зачем: утреннее уходит раз в сутки, и посмотреть глазами, как выглядит
 * разбор вчерашнего с кнопками, иначе можно только назавтра — один цикл
 * «поправил — посмотрел» стоил бы сутки. Скрипт собирает то же
 * сообщение тем же кодом (`composeMorning`) и отправляет его сразу.
 *
 * Что он делает с данными — ровно то же, что настоящее утреннее: ставит
 * отметки «показано в разборе» и «предложено», нетронутое с прошлого
 * разбора уносит в «Позже». Напоминание в базе не заводится: это не
 * «утро случилось», частота и серия молчания не сдвигаются.
 *
 * Запускается руками внутри контейнера бота, на тестовом аккаунте:
 *   node apps/bot/dist/scripts/send-morning.js <tgId>
 */

const [, , tgIdArg] = process.argv;

if (tgIdArg === undefined || !/^\d+$/u.test(tgIdArg)) {
  process.stderr.write('Использование: send-morning <tgId>\n');
  process.exit(2);
}

const env = parseEnv(process.env);
const db = getDb();
const logger = createLogger({ level: 'warn' });

try {
  const user = await findByTgId(db, Number(tgIdArg));
  if (user === undefined) {
    process.stderr.write(`Человека с tgId ${tgIdArg} нет\n`);
    process.exit(1);
  }

  const api = new Api(env.BOT_TOKEN);
  const sender = createQuestionSender({ api, db, logger });
  const settings = new SettingsRegistry({ db, logger });
  const texts = textsFor(await textProfileOf(db, user.id));

  const message = await composeMorning({ db, sender, logger, settings }, texts, {
    userId: user.id,
    now: new Date(),
  });

  const messageId = await sender.ask({
    chatId: user.tgId,
    text: message.text,
    rows: [...(message.rows ?? []), ...(message.buttons.length === 0 ? [] : [message.buttons])],
  });

  if (messageId === 0) {
    await message.undoIfUnsent?.();
    process.stderr.write('Сообщение не ушло: отметки сняты\n');
    process.exit(1);
  }

  process.stdout.write(`Утреннее ушло, сообщение ${String(messageId)}:\n\n${message.text}\n`);
} finally {
  await closeDb();
}
