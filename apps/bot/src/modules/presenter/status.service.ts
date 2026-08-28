import { eq } from 'drizzle-orm';

import { batches } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';

/**
 * Статусное сообщение выгрузки (задача 1.17).
 *
 * §9.2 ТЗ: пока идёт ожидание тишины, бот молчит и не отвечает на каждое
 * голосовое отдельно. §10.2: подтверждение приёма отправляется сразу, не
 * дожидаясь разбора, и потом правится на результат.
 *
 * Совмещается это так: на первом сообщении выгрузки уходит одно статусное
 * сообщение, дальше оно только правится. Серия из пяти голосовых порождает
 * ровно одну реплику бота.
 */

/** Отправка отделена от логики: тесты считают вызовы, а не шлют в Telegram. */
/**
 * Кнопка под сообщением. Та же форма, что у `ReplyButton` представления:
 * отправитель не должен знать, кто и зачем её построил.
 */
export interface StatusButton {
  readonly label: string;
  readonly action: string;
}

export interface StatusSender {
  send(params: {
    readonly chatId: number;
    readonly threadId?: number | undefined;
    readonly text: string;
    readonly buttons?: readonly StatusButton[] | undefined;
  }): Promise<number>;

  edit(params: {
    readonly chatId: number;
    readonly messageId: number;
    readonly text: string;
    readonly buttons?: readonly StatusButton[] | undefined;
  }): Promise<void>;
}

export interface StatusDeps {
  readonly db: Database;
  readonly sender: StatusSender;
  /**
   * Минимальный промежуток между правками. Telegram ограничивает частоту
   * обращений к чату, и поток токенов модели нельзя слать построчно.
   */
  readonly minEditIntervalMs?: number;
  readonly now?: () => Date;
}

const DEFAULT_MIN_EDIT_INTERVAL_MS = 1_000;

export interface StatusTarget {
  readonly batchId: string;
  readonly chatId: number;
  readonly threadId?: number | undefined;
}

/**
 * Показывает статус: отправляет сообщение при первом вызове, дальше правит.
 * Возвращает true, если сообщение действительно ушло или изменилось.
 */
export async function showStatus(
  deps: StatusDeps,
  target: StatusTarget,
  text: string,
  options: { readonly force?: boolean; readonly buttons?: readonly StatusButton[] } = {},
): Promise<boolean> {
  const now = (deps.now ?? (() => new Date()))();
  const minInterval = deps.minEditIntervalMs ?? DEFAULT_MIN_EDIT_INTERVAL_MS;

  const [batch] = await deps.db
    .select({
      statusMessageId: batches.statusMessageId,
      statusUpdatedAt: batches.statusUpdatedAt,
    })
    .from(batches)
    .where(eq(batches.id, target.batchId))
    .limit(1);

  if (!batch) {
    throw new Error(`Выгрузка ${target.batchId} не найдена`);
  }

  if (batch.statusMessageId === null) {
    const messageId = await deps.sender.send({
      chatId: target.chatId,
      threadId: target.threadId,
      text,
      buttons: options.buttons,
    });

    // Ноль означает, что отправка не удалась — например, человек
    // заблокировал бота. Запоминать несуществующее сообщение нельзя:
    // следующая правка ушла бы в пустоту, а так следующий вызов
    // попробует отправить заново.
    if (messageId === 0) return false;

    await deps.db
      .update(batches)
      .set({ statusMessageId: messageId, statusUpdatedAt: now })
      .where(eq(batches.id, target.batchId));

    return true;
  }

  // Слишком частые правки Telegram отвергнет, а поток модели идёт токенами.
  // Финальный ответ проходит всегда: его терять нельзя.
  if (!options.force && batch.statusUpdatedAt !== null) {
    const elapsed = now.getTime() - batch.statusUpdatedAt.getTime();
    if (elapsed < minInterval) return false;
  }

  await deps.sender.edit({
    chatId: target.chatId,
    messageId: batch.statusMessageId,
    text,
    buttons: options.buttons,
  });

  await deps.db.update(batches).set({ statusUpdatedAt: now }).where(eq(batches.id, target.batchId));

  return true;
}

/** Финальный ответ: правка проходит независимо от ограничения частоты. */
export async function finishStatus(
  deps: StatusDeps,
  target: StatusTarget,
  text: string,
  buttons?: readonly StatusButton[],
): Promise<boolean> {
  return await showStatus(deps, target, text, {
    force: true,
    ...(buttons === undefined ? {} : { buttons }),
  });
}
