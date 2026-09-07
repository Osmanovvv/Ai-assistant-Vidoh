import { eq } from 'drizzle-orm';
import type { Api } from 'grammy';
import type { Logger } from 'pino';

import { users } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { isBlockedError } from '../users/blocked.js';
import { outputContextOf } from '../users/state.repo.js';
import { markBlocked } from '../users/users.repo.js';
import { textsFor } from '../../texts/index.js';
import type { TextProfile } from '../../texts/types.js';
import { untilText } from './checkout.service.js';

/**
 * Сказать человеку про его деньги (§14 ТЗ, задача 4.2).
 *
 * Отдельным модулем, потому что зовут его двое и с разных сторон:
 * уведомление Робокассы приходит в HTTP, а неудачное продление находит
 * суточный проход. Оба знают только наш `userId` — до чата отсюда ещё
 * один запрос, и делать его дважды в двух местах значило бы однажды
 * разойтись в том, что человек услышит.
 *
 * **Оплата звёздами сюда не идёт.** Она приходит апдейтом в тот же чат,
 * где человек нажал кнопку, и отвечать ей надо туда же — иначе
 * подтверждение уедет в другую ветку, а не под сам платёж.
 *
 * Отказ здесь никогда не поднимается наверх: и продлению, и ответу
 * Робокассе он безразличен. Молчаливое продление хуже громкого, но
 * несостоявшееся продление хуже обоих.
 */

export interface NotifierDeps {
  readonly api: Pick<Api, 'sendMessage'>;
  readonly db: Executor;
  readonly logger: Logger;
}

export interface PaymentNotifier {
  /** Оплата прошла: до какого числа теперь оплачено. */
  paid(params: { readonly userId: string; readonly paidUntil: Date }): Promise<void>;
  /** Продление не прошло: доступ пока есть, но кончится. */
  renewalFailed(params: { readonly userId: string; readonly paidUntil: Date }): Promise<void>;
}

async function chatOf(db: Executor, userId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ tgId: users.tgId, blockedAt: users.blockedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // Заблокировавшему бота не пишем: отправка всё равно отобьётся, а
  // счётчик отказов в мониторинге вырастет на пустом месте.
  return row?.blockedAt == null ? row?.tgId : undefined;
}

export function createPaymentNotifier(deps: NotifierDeps): PaymentNotifier {
  /** Отправка одной репликой: чат, профиль текста, отказ. */
  const say = async (
    userId: string,
    pick: (texts: TextProfile, until: string) => string,
    until: Date,
  ) => {
    const chatId = await chatOf(deps.db, userId);
    if (chatId === undefined) return;

    const context = await outputContextOf(deps.db, userId);
    const texts = textsFor(context.textProfile);

    try {
      await deps.api.sendMessage(chatId, pick(texts, untilText(until)));
    } catch (error) {
      if (isBlockedError(error)) {
        deps.logger.info({ userId }, 'Оплативший заблокировал бота, помечаю');
        await markBlocked(deps.db, chatId);
        return;
      }

      deps.logger.error({ err: error, userId }, 'Не удалось сказать человеку про оплату');
    }
  };

  return {
    async paid(params) {
      await say(params.userId, (texts, until) => texts.billing.paid(until), params.paidUntil);
    },

    async renewalFailed(params) {
      await say(
        params.userId,
        (texts, until) => texts.billing.renewalFailed(until),
        params.paidUntil,
      );
    },
  };
}
