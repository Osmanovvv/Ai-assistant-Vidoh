import { desc, eq } from 'drizzle-orm';

import { adminAccessLog, type AdminAccess } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';

/**
 * Журнал доступа к персональным данным (§16 ТЗ, задача 4.11).
 *
 * §16 дословно: «доступ к персональным данным в админ-панели
 * журналируется». Требование не про удобство разбора инцидентов. Человек
 * рассказывает боту о здоровье детей, о семейных обстоятельствах и о
 * деньгах; он вправе знать, что каждый взгляд на это оставляет след.
 *
 * **Запись делается до ответа, а не после, и это главное решение здесь.**
 * Если запись не удалась, данные **не отдаются**: незапротоколированный
 * доступ — это нарушение §16, а не мелкая неприятность. Цена честная и
 * названа: сбой базы делает панель недоступной. Но панель без журнала
 * хуже недоступной панели, потому что выглядит работающей.
 *
 * **Журнал ведётся по решению, принятому у каждого пути.** Не всякий
 * раздел показывает персональные данные: сводка по этапам — числа,
 * карточка человека — его слова. Решение принимает тот, кто объявляет
 * путь, и не принять его нельзя: тип требует поля. Забыть здесь значит
 * либо оставить доступ без следа, либо засорить журнал числами.
 */

/** Что показывает раздел панели. Решение обязательно у каждого пути. */
export type Exposure =
  /**
   * Персональные данные одного человека: его слова, переписка, платежи.
   * Каждое обращение попадает в журнал с указанием, на кого смотрели.
   *
   * `param` — имя параметра пути, в котором приезжает код человека.
   * Требуется типом: журнал «кто-то смотрел на кого-то» бесполезен.
   */
  | { readonly personal: true; readonly subjects: 'one'; readonly param: string }
  /**
   * Персональные данные многих сразу: список людей, сводка с именами.
   * В журнал попадает обращение и число людей в ответе.
   */
  | { readonly personal: true; readonly subjects: 'many' }
  /**
   * Только числа и сводки, по которым человека не узнать.
   *
   * Требует причины — строкой, которую прочтёт следующий: «почему это
   * не персональные данные» должно быть решением, а не умолчанием.
   */
  | { readonly personal: false; readonly why: string };

export interface AccessRecord {
  readonly login: string;
  readonly route: string;
  /** Чьи данные смотрели. Пусто — многих сразу. */
  readonly subjectUserId?: string | undefined;
  /** Сколько человек попало в ответ. */
  readonly subjects?: number | undefined;
}

/**
 * Записать обращение.
 *
 * Отказ пробрасывается наверх нарочно: решение «отдавать или нет»
 * принимает тот, кто позвал, — и по §16 он обязан не отдать.
 */
export async function recordAccess(db: Executor, record: AccessRecord): Promise<void> {
  await db.insert(adminAccessLog).values({
    login: record.login,
    route: record.route,
    subjectUserId: record.subjectUserId ?? null,
    subjects: record.subjects ?? 1,
  });
}

/** Последние обращения — для самой панели и для разбора инцидента. */
export async function recentAccess(db: Executor, limit = 100): Promise<AdminAccess[]> {
  return await db
    .select()
    .from(adminAccessLog)
    .orderBy(desc(adminAccessLog.at))
    .limit(Math.min(1000, Math.max(1, limit)));
}

/** Кто смотрел на данные этого человека. */
export async function accessTo(db: Executor, userId: string): Promise<AdminAccess[]> {
  return await db
    .select()
    .from(adminAccessLog)
    .where(eq(adminAccessLog.subjectUserId, userId))
    .orderBy(desc(adminAccessLog.at));
}
