import type { RequestHandler } from 'express';
import { webhookCallback, type Bot } from 'grammy';

/**
 * Обработчик вебхука (задача 1.7).
 *
 * §16 ТЗ требует проверять подлинность вебхука. Telegram присылает секрет
 * в заголовке X-Telegram-Bot-Api-Secret-Token; grammY сверяет его сам и
 * отвечает 401 на чужие запросы, не доводя их до обработчиков.
 *
 * Ответ Telegram отдаётся сразу: конвейер разбора работает асинхронно,
 * а долгий ответ означал бы переотправку апдейта (§9 ТЗ).
 */
export function createWebhookHandler(bot: Bot, secretToken: string): RequestHandler {
  return webhookCallback(bot, 'express', {
    secretToken,
    // Telegram ждёт ответ ограниченное время. Отдаём раньше, чем он устанет,
    // иначе получим повторную доставку того же апдейта.
    timeoutMilliseconds: 8_000,
  });
}
