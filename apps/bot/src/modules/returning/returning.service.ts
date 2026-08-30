import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';

import { batches, items } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { OPEN_STATUSES } from '../items/items.repo.js';

/**
 * Возвращение после паузы (§13.6 ТЗ).
 *
 * «Если женщина не заходила дольше заданного срока, бот встречает её мягче
 * обычного и даёт выбор, вместо того чтобы вываливать накопившееся.»
 *
 * **Пауза считается по прошлой выгрузке, а не по `last_active_at`.**
 * Второе выглядит естественнее и не работает: это поле обновляется на
 * каждом входящем сообщении, то есть уже на том самом, ради которого мы
 * пришли считать. К моменту разбора паузы в нём не видно.
 *
 * **Экран показывается один раз само собой.** Признак — время прошлой
 * выгрузки; после этой прошлой станет уже она, и следующая проверка
 * увидит свежую. Никакого «показано ли» хранить не нужно, а значит нечему
 * и разъехаться.
 */

/**
 * Через сколько дней молчания встречаем этим экраном.
 *
 * §13.6 говорит «задаётся в настройках». Настройки — четвёртый этап;
 * здесь число живёт в коде и названо, а не спрятано в выражении.
 * Две недели: неделя — это отпуск, после которого продукт помнят; месяц
 * — это уже возвращение к незнакомому.
 */
export const RETURN_AFTER_DAYS = 14;

const DAY_MS = 24 * 60 * 60_000;

/**
 * Была ли пауза перед этой выгрузкой.
 *
 * `batchId` — текущая выгрузка, её саму не считаем.
 */
export async function returningAfterPause(
  db: Executor,
  params: { readonly userId: string; readonly batchId: string; readonly now: Date },
): Promise<boolean> {
  const [previous] = await db
    .select({ openedAt: batches.openedAt })
    .from(batches)
    .where(and(eq(batches.userId, params.userId), ne(batches.id, params.batchId)))
    .orderBy(desc(batches.openedAt))
    .limit(1);

  // Первая выгрузка в жизни — это не возвращение, а знакомство.
  if (!previous) return false;

  return params.now.getTime() - previous.openedAt.getTime() >= RETURN_AFTER_DAYS * DAY_MS;
}

/**
 * Убирает открытые записи в фон («начать с чистого листа»).
 *
 * §13.6 дословно: «не удаляет данные. Старые записи уходят в фон и
 * остаются доступны через бэклог. Физическое удаление возможно только
 * через отдельный пункт меню».
 *
 * Поэтому не `delete` и не статус «отменено»: человек не передумал делать
 * эти дела, он решил не держать их перед глазами. Отмена сказала бы про
 * него неправду, а удаление отняло бы то, чего он не отдавал.
 */
export async function moveToBackground(
  db: Executor,
  params: { readonly userId: string; readonly now?: Date | undefined },
): Promise<number> {
  const moved = await db
    .update(items)
    .set({ backgroundedAt: params.now ?? new Date() })
    .where(
      and(
        eq(items.userId, params.userId),
        eq(items.isDraft, false),
        isNull(items.backgroundedAt),
        // Закрытые и отменённые убирать незачем: их и так не видно.
        // Список тот же, что у «записи в работе», иначе смыслы разойдутся.
        inArray(items.status, [...OPEN_STATUSES]),
      ),
    )
    .returning({ id: items.id });

  return moved.length;
}
