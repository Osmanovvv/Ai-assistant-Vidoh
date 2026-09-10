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

  /**
   * Правка статусного сообщения. Исход называется, а не глотается.
   *
   * `gone` — человек удалил сообщение руками (в личном чате Telegram это
   * разрешено). Тогда правка бьёт в пустоту, а итог разбора уходит ровно
   * этим путём: человек получает **ничего**.
   */
  edit(params: {
    readonly chatId: number;
    readonly messageId: number;
    readonly text: string;
    readonly buttons?: readonly StatusButton[] | undefined;
  }): Promise<'edited' | 'gone' | 'failed'>;
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
      statusTaken: batches.statusTaken,
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
      .set({
        statusMessageId: messageId,
        statusUpdatedAt: now,
        // Финальная правка — это и есть занятие слота: с этого мига в
        // сообщении лежит ответ по существу, и стирать его нельзя.
        ...(options.force === true ? { statusTaken: true } : {}),
      })
      .where(eq(batches.id, target.batchId));

    return true;
  }

  // Слишком частые правки Telegram отвергнет, а поток модели идёт токенами.
  // Финальный ответ проходит всегда: его терять нельзя.
  if (!options.force && batch.statusUpdatedAt !== null) {
    const elapsed = now.getTime() - batch.statusUpdatedAt.getTime();
    if (elapsed < minInterval) return false;
  }

  const edited = await deps.sender.edit({
    chatId: target.chatId,
    messageId: batch.statusMessageId,
    text,
    buttons: options.buttons,
  });

  /**
   * Сообщение удалил сам человек — шлём новое (ревизия этапов 1–2).
   *
   * Прежде отказ правки глотался внутри отправителя, и итог разбора
   * уходил в пустоту: человек получал **ничего**. Не ошибку, не «попробуй
   * ещё», а тишину, которую честно читает как поломку. Панель при этом
   * показывала выгрузку удавшейся — обработчик не бросил, значит `done`,
   * а раздел ошибок берёт только `failed`; перезапустить её было нечем.
   *
   * Тот же приём, что у сводки темы: «править нечего — отправить заново».
   */
  if (edited === 'gone') {
    const messageId = await deps.sender.send({
      chatId: target.chatId,
      threadId: target.threadId,
      text,
      buttons: options.buttons,
    });

    if (messageId === 0) return false;

    await deps.db
      .update(batches)
      .set({
        statusMessageId: messageId,
        statusUpdatedAt: now,
        ...(options.force === true ? { statusTaken: true } : {}),
      })
      .where(eq(batches.id, target.batchId));

    return true;
  }

  /**
   * Время правки и занятие слота пишутся **всегда**, даже когда правка
   * отказала.
   *
   * `ECONNRESET` нарочно не повторяется — «он бывает и посреди ответа», —
   * значит есть достижимый случай, когда Telegram правку применил, а
   * ответ оборвался. Не пометь мы слот занятым, докладчик о сбое стёр бы
   * с экрана уже лежащий там ответ вместе с кнопкой «Отменить». А не
   * обнови время — следующая правка пошла бы сразу после отказа по
   * частоте, то есть против того, ради чего заведено ограничение.
   */
  await deps.db
    .update(batches)
    .set({
      statusUpdatedAt: now,
      ...(options.force === true ? { statusTaken: true } : {}),
    })
    .where(eq(batches.id, target.batchId));

  /**
   * Отказ правки — не успех, и вызывающий обязан узнать.
   *
   * Прежде отсюда всегда возвращалось `true`: «реплика доставлена» на
   * недоставленную реплику. Ноль вместо «не смогли» — та же ложь.
   */
  if (edited === 'failed') return false;

  return true;
}

/**
 * Занят ли статусный слот ответом по существу.
 *
 * Спрашивают те, кто живёт вне обработчика выгрузки и потому не видит его
 * памяти, — прежде всего докладчик о сбое. Правка занятого слота стирает
 * и текст, и кнопки: так однажды исчезло подтверждение правки вместе с
 * кнопкой «Отменить», и вернуть его было нечем.
 */
export async function statusIsTaken(deps: StatusDeps, batchId: string): Promise<boolean> {
  const [batch] = await deps.db
    .select({ statusTaken: batches.statusTaken })
    .from(batches)
    .where(eq(batches.id, batchId))
    .limit(1);

  return batch?.statusTaken ?? false;
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
