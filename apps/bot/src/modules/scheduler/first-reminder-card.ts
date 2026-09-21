import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import { userSettings } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import type { CardSender } from '../cards/cards.js';
import type { TextProfile } from '../../texts/types.js';
import { reminderButtons } from './reminder-actions.js';

/**
 * Карточка 04 «Записала. Напомню в нужный момент.» (ТЗ по визуалам
 * 18.09.2026): при **первом** деле с часом — картинка с кнопками
 * «Изменить время · Все напоминания»; дальше без картинки. Правило
 * визуалов — редко: отметка `reminder_card_at` держит «один раз».
 *
 * Своим сообщением после ответа на выгрузку, а не вместо него: ответ
 * несёт счёт дел и кнопки «Оставить как есть / Выбрать главное», их
 * терять нельзя. Отказ отправки разбор не роняет — картинка удобство.
 */
export async function showFirstReminderCard(
  deps: { readonly db: Database; readonly cards: CardSender; readonly logger?: Logger | undefined },
  params: {
    readonly userId: string;
    readonly chatId: number;
    readonly threadId?: number | undefined;
    /** Дело с часом, к которому ведёт «Изменить время». */
    readonly itemId: string;
    readonly texts: TextProfile;
    readonly now: Date;
  },
): Promise<boolean> {
  const [row] = await deps.db
    .select({ at: userSettings.reminderCardAt })
    .from(userSettings)
    .where(eq(userSettings.userId, params.userId))
    .limit(1);
  if (row?.at !== null) return false;

  const messageId = await deps.cards.send({
    chatId: params.chatId,
    threadId: params.threadId,
    card: 'reminder',
    caption: params.texts.cards.reminder,
    buttons: reminderButtons(params.itemId, params.texts),
  });
  if (messageId === 0) {
    deps.logger?.warn({ userId: params.userId }, 'Карточка первого напоминания не ушла');
    return false;
  }

  await deps.db
    .update(userSettings)
    .set({ reminderCardAt: params.now })
    .where(eq(userSettings.userId, params.userId));

  return true;
}
