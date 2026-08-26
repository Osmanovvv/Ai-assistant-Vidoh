import { callbackUpdate, postUpdate, textUpdate, updateIdOf } from '../e2e/updates.js';

/**
 * Отправка тестового апдейта в собственный вебхук (задача 1.24).
 *
 * Нужна сквозному тесту: настоящее сообщение может прислать только
 * настоящий человек из Telegram, а проверить путь «вебхук → база →
 * очередь → воркер → склейка» на боевом сервере надо до того, как этот
 * человек появится.
 *
 * Апдейт идёт тем же путём, что и настоящий: через HTTP с секретом в
 * заголовке. Внутренние функции напрямую не дёргаются — иначе тест
 * проверял бы не то, что работает в бою.
 *
 * Запуск внутри контейнера бота:
 *   node apps/bot/dist/scripts/send-test-update.js <chatId> <messageId> <текст>
 *   node apps/bot/dist/scripts/send-test-update.js <chatId> <messageId> --callback <данные>
 */

const [, , chatIdArg, messageIdArg, ...rest] = process.argv;

if (chatIdArg === undefined || messageIdArg === undefined || rest.length === 0) {
  process.stderr.write(
    'Использование: send-test-update <chatId> <messageId> <текст>\n' +
      '               send-test-update <chatId> <messageId> --callback <данные>\n',
  );
  process.exit(2);
}

const chatId = Number(chatIdArg);
const messageId = Number(messageIdArg);
const isCallback = rest[0] === '--callback';
const payload = (isCallback ? rest.slice(1) : rest).join(' ');

const secret = process.env['BOT_WEBHOOK_SECRET'];
if (secret === undefined) {
  process.stderr.write('Нет BOT_WEBHOOK_SECRET в окружении\n');
  process.exit(2);
}

const port = process.env['PORT'] ?? '3000';

const update = isCallback
  ? callbackUpdate({ chatId, messageId }, payload)
  : textUpdate({ chatId, messageId }, payload);

const status = await postUpdate({ baseUrl: `http://127.0.0.1:${port}`, secret }, update);

process.stdout.write(`апдейт ${String(updateIdOf(messageId))}: HTTP ${String(status)}
`);

// Ненулевой код возврата, чтобы сквозной тест не проглотил отказ.
if (status < 200 || status >= 300) process.exit(1);
