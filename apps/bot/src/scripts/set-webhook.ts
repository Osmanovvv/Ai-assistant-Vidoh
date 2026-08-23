import { ALLOWED_UPDATES, createBot } from '../bot/bot.js';
import { getEnv, webhookUrl } from '../config/env.js';

/**
 * Регистрация вебхука отдельной командой (задача 1.7).
 *
 * Нужна, когда BOT_SET_WEBHOOK_ON_BOOT выключен: при нескольких репликах
 * регистрировать вебхук должна одна, а не каждая при старте.
 */

const env = getEnv();
const bot = createBot(env.BOT_TOKEN);
const url = webhookUrl(env);

await bot.api.setWebhook(url, {
  secret_token: env.BOT_WEBHOOK_SECRET,
  drop_pending_updates: false,
  allowed_updates: [...ALLOWED_UPDATES],
});

const info = await bot.api.getWebhookInfo();
process.stdout.write(`Вебхук зарегистрирован: ${url}\n${JSON.stringify(info, null, 2)}\n`);
