import { type Bot } from 'grammy';
import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import { RETURNING_ACTION } from '../../modules/returning/returning-actions.js';
import { moveToBackground } from '../../modules/returning/returning.service.js';
import { outputContextOf } from '../../modules/users/state.repo.js';
import { findByTgId } from '../../modules/users/users.repo.js';
import { textsFor } from '../../texts/index.js';

/**
 * «Начать с чистого листа» с экрана возвращения (§13.6 ТЗ).
 *
 * **Ничего не удаляет**, и это главное, что человек должен почувствовать,
 * нажимая кнопку с таким названием. §13.6 говорит прямо: старые записи
 * уходят в фон и остаются доступны через бэклог, физическое удаление —
 * только через отдельный пункт меню.
 *
 * Ответ называет число, чтобы было видно, что произошло, но не
 * перечисляет: перечисление вернуло бы на глаза ровно то, что человек
 * убрал.
 *
 * Вторая кнопка, «Продолжить старое», живёт в `menu.ts` рядом со списком
 * «Сегодня» — она ведёт туда же, и своего экрана ей не нужно.
 */
export function registerReturningHandlers(bot: Bot, db: Database, logger: Logger): void {
  bot.callbackQuery(RETURNING_ACTION.fresh, async (ctx) => {
    await ctx.answerCallbackQuery();

    const user = await findByTgId(db, ctx.from.id);
    if (!user) return;

    const context = await outputContextOf(db, user.id);
    const texts = textsFor(context.textProfile);
    const moved = await moveToBackground(db, { userId: user.id });

    logger.info({ userId: user.id, moved }, 'Человек начал с чистого листа');

    await ctx.editMessageText(
      moved === 0 ? texts.returning.nothingToMove : texts.returning.moved(moved),
    );
  });
}
