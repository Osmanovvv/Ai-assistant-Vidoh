import type { Bot } from 'grammy';
import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import { isBlockingStatus } from '../../modules/users/blocked.js';
import { markBlocked, upsertUser } from '../../modules/users/users.repo.js';

/**
 * Смена статуса бота у пользователя (задача 1.19).
 *
 * Telegram присылает my_chat_member сразу, как только человек нажал
 * «Заблокировать» или «Разблокировать». Это точнее, чем ждать 403 при
 * следующей отправке: пометка ставится до того, как планировщик впустую
 * дёрнет API.
 */
export function registerMembershipHandlers(bot: Bot, db: Database, logger: Logger): void {
  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember;
    if (update.chat.type !== 'private') return;

    const status = update.new_chat_member.status;
    const tgId = update.from.id;

    if (isBlockingStatus(status)) {
      await markBlocked(db, tgId);
      logger.info({ tgId, status }, 'Пользователь заблокировал бота');
      return;
    }

    // Разблокировка: снимаем пометку, чтобы напоминания вернулись.
    await upsertUser(db, {
      tgId,
      username: update.from.username ?? null,
      firstName: update.from.first_name,
      languageCode: update.from.language_code ?? null,
    });
    logger.info({ tgId, status }, 'Пользователь разблокировал бота');
  });
}
