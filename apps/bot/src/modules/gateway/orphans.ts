import { and, count, eq, isNull, lt, not, sql } from 'drizzle-orm';

import { messagesRaw } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';

/**
 * Сообщение сохранено, а к выгрузке не привязано (ревизия этапов 1–2).
 *
 * **Тихая потеря мысли при сохранённых словах.** Разбор читает сообщения
 * строго по выгрузке, и осиротевшая фраза не склеится ни с чем: человек
 * не получает ни «Слушаю», ни разбора, и сказанное им не попадёт даже в
 * следующую выгрузку. Досмотр слеп по устройству — он смотрит в выгрузки,
 * а у сироты выгрузки нет вовсе.
 *
 * **Часть таких сообщений — намеренные.** Команда сохраняется и дальше
 * буфера не идёт нарочно: иначе бот отвечает «Слушаю.» на
 * `/delete_my_data` и потом зачитывает её обратно расшифровкой. То же со
 * служебными сообщениями Telegram и с ответами на вопросы опроса. Но в
 * панели они лежали вперемешку с настоящими сиротами под подписью «так
 * бывает после отказа гейта» — намеренное и случайное неразличимы, то
 * есть колонка читается как факт, которым не является.
 *
 * **Подбирать их молча нельзя, и это решение, а не лень.** Подбор завёл
 * бы выгрузку мимо суточного потолка §10.5, заплатил бы за расшифровку
 * голосового у человека без доступа и гонялся бы с живым приёмом за то
 * же сообщение. Поэтому здесь только счёт и имя: узнать — наша работа,
 * решать — человека.
 */

/**
 * Сколько ждать, прежде чем считать сообщение осиротевшим.
 *
 * Приём сохраняет сообщение раньше, чем привязывает его к выгрузке, и
 * между этими двумя шагами лежит живая работа. Срок обработчика вебхука
 * снят нарочно, поэтому «ещё в пути» может длиться минутами: час —
 * заведомо больше самого долгого честного пути и меньше любого срока, за
 * который жалоба успеет дойти до разбирающего.
 */
export const ORPHAN_AFTER_MS = 60 * 60_000;

/**
 * Намеренно оставшиеся без выгрузки: команда и служебное сообщение.
 *
 * Команду видно по тексту: `kind` их не различает, а `bot_command` живёт
 * только в самом апдейте и в базу не едет. Служебное — по отсутствию и
 * текста, и расшифровки.
 */
function deliberate(): ReturnType<typeof sql> {
  return sql`(
    ${messagesRaw.text} like '/%'
    or (${messagesRaw.text} is null and ${messagesRaw.transcript} is null)
    -- Съеденное как ответ на вопрос бота — обработано, не сирота
    -- (найдено на бою 12.09.2026: «7:30» из опроса считалось неделю).
    or ${messagesRaw.consumedAt} is not null
  )`;
}

/**
 * Сообщение съедено как ответ на вопрос бота — имя, время, город,
 * промокод — и в разбор не пойдёт. Отметка нужна счётчику сирот и панели.
 */
export async function markConsumed(
  db: Executor,
  messageId: string,
  now = new Date(),
): Promise<void> {
  await db.update(messagesRaw).set({ consumedAt: now }).where(eq(messagesRaw.id, messageId));
}

/** Настоящие сироты: ни выгрузки, ни причины ею не быть. */
export async function countOrphanedMessages(
  db: Executor,
  params: { readonly now?: Date; readonly olderThanMs?: number } = {},
): Promise<number> {
  const now = params.now ?? new Date();
  const older = new Date(now.getTime() - (params.olderThanMs ?? ORPHAN_AFTER_MS));

  const [row] = await db
    .select({ total: count() })
    .from(messagesRaw)
    .where(and(isNull(messagesRaw.batchId), lt(messagesRaw.receivedAt, older), not(deliberate())));

  return row?.total ?? 0;
}

/**
 * Условие для панели: показывать только неслучайные.
 *
 * Без него список «без выгрузки» состоял бы наполовину из команд, а его
 * подпись обещает совсем другое.
 */
export function orphanedOnly(userId: string): ReturnType<typeof and> {
  return and(eq(messagesRaw.userId, userId), isNull(messagesRaw.batchId), not(deliberate()));
}
