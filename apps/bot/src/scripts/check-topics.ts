import { Api } from 'grammy';

import { createLogger } from '../infra/logger.js';
import {
  createTopicGateway,
  isThreadGone,
  isTopicsUnavailable,
} from '../modules/topics/gateway.js';

/**
 * Живая проверка веток личного чата (задачи 2.15–2.17).
 *
 * Проба 0.3 проверяла сам API Telegram. Здесь проверяется наш шлюз: тот
 * же путь, которым пойдёт продукт, — создать ветку с иконкой, отправить
 * сводку, закрепить, поправить, убрать за собой.
 *
 * Запуск:
 *   BOT_TOKEN=… CHAT_ID=… npx tsx src/scripts/check-topics.ts
 *
 * Скрипт создаёт настоящую ветку в настоящем чате и удаляет её в конце.
 * Если он упал посреди, ветку надо убрать руками — её имя видно в выводе.
 */

const token = process.env['BOT_TOKEN'];
const chatIdRaw = process.env['CHAT_ID'];

if (token === undefined || chatIdRaw === undefined) {
  process.stderr.write('Нужны BOT_TOKEN и CHAT_ID\n');
  process.exit(2);
}

const chatId = Number(chatIdRaw);
if (!Number.isFinite(chatId)) {
  process.stderr.write('CHAT_ID должен быть числом\n');
  process.exit(2);
}

// Читаемый вывод — только в терминале человека: в контейнере
// без `pino-pretty` он не нужен и раньше ронял скрипт.
const logger = createLogger({ level: 'info', pretty: process.stdout.isTTY === true });
const api = new Api(token);
const gateway = createTopicGateway(api);

/** Имя с отметкой: если скрипт упадёт, ветку будет видно в чате. */
const NAME = 'Проба тем';

try {
  logger.info('Запрашиваю набор допустимых иконок');
  const icons = await gateway.allowedIcons();
  logger.info({ количество: icons.size }, 'Иконки получены');

  // Тот же символ, что стоит у темы «здоровье» в коде продукта.
  const icon = icons.get('💊');
  if (icon === undefined) {
    logger.warn('Символа 💊 в наборе нет — ветка будет без иконки, это допустимо');
  }

  logger.info('Создаю ветку');
  const threadId = await gateway.createThread({
    chatId,
    name: NAME,
    ...(icon === undefined ? {} : { iconEmojiId: icon }),
  });
  logger.info({ threadId }, 'Ветка создана');

  logger.info('Отправляю сводку в ветку');
  const messageId = await gateway.send({
    chatId,
    threadId,
    text: 'Проба сводки — что здесь есть:\n\n— первая строка',
  });

  logger.info('Закрепляю сводку');
  await gateway.pin({ chatId, messageId });

  logger.info('Правлю сводку тем же способом, что и продукт');
  await gateway.edit({
    chatId,
    messageId,
    text: 'Проба сводки — что здесь есть:\n\n— первая строка\n— вторая строка',
  });

  logger.info('Проверяю, что правка тем же текстом не считается сбоем');
  try {
    await gateway.edit({
      chatId,
      messageId,
      text: 'Проба сводки — что здесь есть:\n\n— первая строка\n— вторая строка',
    });
    logger.warn('Telegram принял правку без изменений — поведение отличается от ожидаемого');
  } catch (error) {
    const description = error instanceof Error ? error.message : String(error);
    logger.info({ описание: description }, 'Отказ получен, как и ожидалось');
  }

  logger.info('Убираю ветку за собой');
  await api.deleteForumTopic(chatId, threadId);

  logger.info('Проверяю, что отправка в удалённую ветку опознаётся');
  try {
    await gateway.send({ chatId, threadId, text: 'этого никто не увидит' });
    logger.error('Отправка в удалённую ветку прошла — значит опознать её потерю нельзя');
  } catch (error) {
    logger.info(
      { опознано: isThreadGone(error), режимТемВыключен: isTopicsUnavailable(error) },
      'Потеря ветки опознана',
    );
  }

  logger.info('Готово, чат чистый');
} catch (error) {
  logger.error(
    { err: error, режимТемВыключен: isTopicsUnavailable(error) },
    `Проверка не прошла. Если ветка «${NAME}» осталась в чате — удалите её руками`,
  );
  process.exit(1);
}
