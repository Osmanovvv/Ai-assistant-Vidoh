import { WEBHOOK_PATH } from '../config/env.js';

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

// Идентификатор апдейта выводится из идентификатора сообщения: повторный
// запуск с тем же номером должен отсечься дедупликацией.
const updateId = 900_000_000 + messageId;
const from = { id: chatId, is_bot: false, first_name: 'Сквозной тест' };
const chat = { id: chatId, type: 'private', first_name: 'Сквозной тест' };

/**
 * Команду Telegram помечает служебной разметкой bot_command, и grammY
 * ищет именно её. Без разметки обработчик команды не сработает — на этом
 * однажды уже споткнулся тест.
 */
function commandEntities(text: string) {
  // Разметку Telegram ставит не на всё, что начинается со слэша:
  // «/ надо бы разобраться» — это текст, а не команда.
  if (!/^\/[A-Za-z0-9_]{1,64}(?:@[A-Za-z0-9_]+)?(?:$|\s)/u.test(text)) return undefined;
  const word = text.split(' ')[0] ?? text;
  return [{ type: 'bot_command', offset: 0, length: word.length }];
}

const update = isCallback
  ? {
      update_id: updateId,
      callback_query: {
        id: String(messageId),
        from,
        chat_instance: 'test',
        data: payload,
        message: { message_id: messageId, date: Math.floor(Date.now() / 1000), chat },
      },
    }
  : {
      update_id: updateId,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat,
        from,
        text: payload,
        ...(() => {
          const entities = commandEntities(payload);
          return entities === undefined ? {} : { entities };
        })(),
      },
    };

const response = await fetch(`http://127.0.0.1:${port}${WEBHOOK_PATH}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-telegram-bot-api-secret-token': secret,
  },
  body: JSON.stringify(update),
});

process.stdout.write(`апдейт ${String(updateId)}: HTTP ${String(response.status)}\n`);

// Ненулевой код возврата, чтобы сквозной тест не проглотил отказ.
if (!response.ok) process.exit(1);
