import type { Update } from 'grammy/types';

import type { Database } from '../../infra/db.js';
import { upsertUser } from '../users/users.repo.js';
import { claimUpdate } from './updates.repo.js';
import { saveRawMessage } from './messages.repo.js';
import {
  describeMessage,
  describeUser,
  extractMessage,
  extractReferralSource,
} from './message-mapper.js';

/**
 * Приём входящего апдейта (задачи 1.8 и 1.9).
 *
 * Два требования ТЗ сходятся здесь:
 *   §9.1 — сначала сохраняем, потом думаем;
 *   §17  — повторная доставка не должна порождать вторую запись.
 *
 * Заявка на апдейт и сохранение сообщения выполняются в одной транзакции.
 * Иначе возможен худший из исходов: апдейт помечен обработанным, а
 * сообщение не сохранено — тогда повтор от Telegram будет отброшен как
 * дубль, и текст пользователя пропадёт.
 */

export type GatewayOutcome =
  | { readonly status: 'duplicate'; readonly updateId: number }
  | { readonly status: 'ignored'; readonly updateId: number; readonly reason: string }
  | {
      readonly status: 'saved';
      readonly updateId: number;
      readonly userId: string;
      readonly messageId: string;
    };

export async function acceptUpdate(db: Database, update: Update): Promise<GatewayOutcome> {
  const updateId = update.update_id;

  return await db.transaction(async (tx): Promise<GatewayOutcome> => {
    const isFresh = await claimUpdate(tx, updateId);
    if (!isFresh) {
      return { status: 'duplicate', updateId };
    }

    const message = extractMessage(update);
    if (!message) {
      // Нажатие кнопки или смена статуса чата: сохранять нечего, но апдейт
      // всё равно помечен обработанным, чтобы повтор не задвоил реакцию.
      return { status: 'ignored', updateId, reason: 'апдейт без сообщения' };
    }

    const from = message.from;
    if (!from || from.is_bot) {
      return { status: 'ignored', updateId, reason: 'сообщение не от человека' };
    }

    const incomingUser = describeUser(from);
    const user = await upsertUser(tx, {
      tgId: incomingUser.tgId,
      username: incomingUser.username,
      firstName: incomingUser.firstName,
      languageCode: incomingUser.languageCode,
      referralSource: extractReferralSource(message),
    });

    const described = describeMessage(message);
    const saved = await saveRawMessage(tx, {
      userId: user.id,
      updateId,
      tgChatId: described.tgChatId,
      tgMessageId: described.tgMessageId,
      tgThreadId: described.tgThreadId,
      kind: described.kind,
      text: described.text,
      fileId: described.fileId,
      audioDurationSec: described.audioDurationSec,
    });

    if (!saved) {
      return { status: 'ignored', updateId, reason: 'сообщение уже сохранено' };
    }

    return { status: 'saved', updateId, userId: user.id, messageId: saved.id };
  });
}
