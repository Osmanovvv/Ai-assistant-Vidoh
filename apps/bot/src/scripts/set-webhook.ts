import { createBot } from '../bot/bot.js';
import { registerWebhook } from '../bot/register-webhook.js';
import { getEnv } from '../config/env.js';

/**
 * Регистрация вебхука отдельной командой (задача 1.7).
 *
 * Нужна, когда BOT_SET_WEBHOOK_ON_BOOT выключен: при нескольких репликах
 * регистрировать вебхук должна одна, а не каждая при старте.
 */

const env = getEnv();
const bot = createBot(env.BOT_TOKEN);

const url = await registerWebhook(bot.api, env);

process.stdout.write(`Вебхук зарегистрирован: ${url}
`);
