import { and, asc, count, eq, exists, isNull, lt, not, sql } from 'drizzle-orm';

import { messagesRaw, users } from '../../db/schema.js';
import type { Database, Executor } from '../../infra/db.js';
import { attachMessageToBatch } from '../buffer/buffer.service.js';

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

/** Сколько сирот подбирается за проход: уборщик не должен пахать час. */
const ADOPT_LIMIT = 20;

/**
 * Намеренно оставшиеся без выгрузки: команда и служебное сообщение.
 *
 * Команду видно по тексту: `kind` их не различает, а `bot_command` живёт
 * только в самом апдейте и в базу не едет. Служебное — по отсутствию и
 * текста, и расшифровки.
 */
function deliberate(): ReturnType<typeof sql> {
  /**
   * `coalesce` — не украшение: у голосового текста нет, а `null like …`
   * даёт `null`, и всё «или» становилось `null`. `not null` — тоже
   * `null`, и строка молча выпадала из счёта сирот. Так голосовое, на
   * котором сорвалось распознавание, не попадало даже в предупреждение
   * (бой 18.09.2026, найдено 22.09).
   */
  return sql`(
    coalesce(${messagesRaw.text}, '') like '/%'
    -- Голос без расшифровки — потерянное слово, а не «нарочно без
    -- выгрузки» (бой 18.09.2026, найдено 22.09): именно так выглядит
    -- сорвавшееся распознавание, и такие сообщения надо подбирать.
    or (${messagesRaw.kind} <> 'voice' and ${messagesRaw.text} is null and ${messagesRaw.transcript} is null)
    -- Съеденное как ответ на вопрос бота — обработано, не сирота
    -- (найдено на бою 12.09.2026: «7:30» из опроса считалось неделю).
    or ${messagesRaw.consumedAt} is not null
    -- Остановленное гейтом доступа или суточным потолком — нарочно без
    -- выгрузки, причина записана (13.09.2026).
    or ${messagesRaw.refusedReason} is not null
  )`;
}

/** Почему разбор по сообщению не заведён: причины гейта доступа и потолок. */
export type RefusedReason = 'trial' | 'expired' | 'renewalFailed' | 'dumpLimit';

/**
 * Сообщение сохранено, а выгрузка по нему не заведена нарочно (§14 —
 * доступа нет; §10.5 — потолок). Отметка нужна счётчику сирот и панели:
 * без неё строка через час считалась бы потерей.
 */
export async function markRefused(
  db: Executor,
  messageId: string,
  reason: RefusedReason,
): Promise<void> {
  await db.update(messagesRaw).set({ refusedReason: reason }).where(eq(messagesRaw.id, messageId));
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

/**
 * Человек нажал «Согласна». Без этого его сообщения не сироты, а ждущие
 * (§16, решение заказчицы 12.09.2026): выгрузка по ним не заводится
 * нарочно, и после нажатия их подхватит `releaseHeldMessages`.
 */
function consentConfirmed(): ReturnType<typeof exists> {
  return exists(
    sql`(select 1 from ${users} where ${users.id} = ${messagesRaw.userId} and ${users.consentConfirmedAt} is not null)`,
  );
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
    .where(
      and(
        isNull(messagesRaw.batchId),
        lt(messagesRaw.receivedAt, older),
        not(deliberate()),
        consentConfirmed(),
      ),
    );

  return row?.total ?? 0;
}

/**
 * Сообщения человека, которые ждут нажатия «Согласна»: без выгрузки и
 * без причины ею не быть, в порядке получения. После нажатия каждое
 * уходит в буфер, как только что присланное.
 *
 * Отдельной отметки «ждёт согласия» нет, и это не пробел: до нажатия у
 * человека других сообщений без выгрузки не бывает. Гейт согласия в
 * приёме стоит **раньше** потолка выгрузок и пробного периода — то есть
 * единственные, кто останавливает сообщение без выгрузки после согласия,
 * до согласия не срабатывают; ответы на вопросы бота помечены
 * `consumed_at`, команды и служебные — видны по тексту (`deliberate`).
 * Появится ещё один способ оставить сообщение без выгрузки до согласия —
 * понадобится отметка.
 */
export async function heldMessagesOf(
  db: Executor,
  userId: string,
): Promise<
  readonly { readonly id: string; readonly threadId: number | null; readonly text: string | null }[]
> {
  return await db
    // Текст — чтобы вопрос, написанный до «Согласна», разобрался сразу.
    .select({ id: messagesRaw.id, threadId: messagesRaw.tgThreadId, text: messagesRaw.text })
    .from(messagesRaw)
    .where(orphanedOnly(userId))
    .orderBy(asc(messagesRaw.receivedAt));
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

/**
 * Подобрать сирот: завести им выгрузку, чтобы разбор случился сам
 * (22.09.2026).
 *
 * Прежде уборщик их только считал и писал в журнал — журнал никто не
 * читает, и голосовое, на котором сорвался SpeechKit, пропадало молча.
 * Теперь сообщение возвращается в обычный путь: выгрузка, очередь,
 * ответ человеку. Повторно подобранное не подбирается — выгрузка у него
 * уже есть; сорвётся и она — за ней придёт восстановление зависших.
 */
export async function adoptOrphanedMessages(
  db: Database,
  params: { readonly now?: Date; readonly olderThanMs?: number; readonly limit?: number } = {},
): Promise<{ readonly messages: number; readonly users: readonly string[] }> {
  const now = params.now ?? new Date();
  const older = new Date(now.getTime() - (params.olderThanMs ?? ORPHAN_AFTER_MS));

  const rows = await db
    .select({ id: messagesRaw.id, userId: messagesRaw.userId })
    .from(messagesRaw)
    .where(
      and(
        isNull(messagesRaw.batchId),
        lt(messagesRaw.receivedAt, older),
        not(deliberate()),
        consentConfirmed(),
      ),
    )
    .orderBy(asc(messagesRaw.receivedAt))
    .limit(params.limit ?? ADOPT_LIMIT);

  const users = new Set<string>();
  let adopted = 0;
  for (const row of rows) {
    await attachMessageToBatch(db, { userId: row.userId, messageId: row.id, now });
    users.add(row.userId);
    adopted += 1;
  }

  return { messages: adopted, users: [...users] };
}
