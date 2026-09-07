import { count, desc, eq, gte } from 'drizzle-orm';

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
   *
   * `rows` — имя поля ответа, в котором лежит по строке на человека.
   * Названо — и журнал получает **настоящее** число людей, снятое с
   * ответа после того, как он собран. Не названо — в журнале останется
   * «не установлено», и это честнее выдуманной единицы: раздел вроде
   * «запустить рассылку» никого не показывает вовсе, а число людей,
   * которых он коснётся, ответом не измеряется.
   */
  | { readonly personal: true; readonly subjects: 'many'; readonly rows?: string | undefined }
  /**
   * Только числа и сводки, по которым человека не узнать.
   *
   * Требует причины — строкой, которую прочтёт следующий: «почему это
   * не персональные данные» должно быть решением, а не умолчанием.
   */
  | { readonly personal: false; readonly why: string };

/**
 * Сверить имя параметра с путём — на сборке, а не в бою.
 *
 * `subjects: 'one'` обещает журналу «смотрели на этого человека», а код
 * человека берётся из `req.params[param]`. Опечатка в имени даёт
 * `undefined`, и запись тихо превращается в «смотрели на многих» — то
 * есть в журнале остаётся обращение без того, кого оно касалось. Тип
 * этого не поймает: там строка.
 *
 * Отдельной функцией, чтобы её мог позвать не только роутер, но и
 * проверка: страж, который нельзя вызвать, — не страж.
 */
export function checkParam(path: string, exposure: Exposure): void {
  if (!exposure.personal || exposure.subjects !== 'one') return;

  if (!path.includes(`:${exposure.param}`)) {
    throw new Error(
      `Путь ${path} объявлен персональным по параметру «${exposure.param}», а такого параметра в пути нет`,
    );
  }
}

export interface AccessRecord {
  readonly login: string;
  readonly route: string;
  /** Чьи данные смотрели. Пусто — многих сразу. */
  readonly subjectUserId?: string | undefined;
  /** Сколько человек попало в ответ. */
  readonly subjects?: number | undefined;
}

/**
 * Записать обращение. Возвращает номер записи — его потом уточняют.
 *
 * Отказ пробрасывается наверх нарочно: решение «отдавать или нет»
 * принимает тот, кто позвал, — и по §16 он обязан не отдать.
 *
 * **`subjects` больше не подставляется.** Прежде здесь стояло
 * `?? 1`, а вызывающий его не передавал никогда: журнал утверждал «в
 * ответ попал один человек» про каждую страницу списка. Не знаем —
 * пишем пусто; узнаем после ответа — уточняем `noteSubjects`.
 */
export async function recordAccess(
  db: Executor,
  record: AccessRecord,
): Promise<{ readonly id: string | undefined }> {
  const [row] = await db
    .insert(adminAccessLog)
    .values({
      login: record.login,
      route: record.route,
      subjectUserId: record.subjectUserId ?? null,
      subjects: record.subjects ?? null,
    })
    .returning({ id: adminAccessLog.id });

  return { id: row?.id };
}

/**
 * Уточнить число людей в ответе — после того, как ответ собран.
 *
 * Отдельным запросом, а не полем при вставке, потому что порядок задан
 * §16: запись идёт **до** выдачи данных. Число людей до выдачи неизвестно
 * — значит уточняется после, и неудача уточнения оставляет «не
 * установлено», а не ложную единицу.
 */
export async function noteSubjects(
  db: Executor,
  params: { readonly id: string; readonly subjects: number },
): Promise<void> {
  await db
    .update(adminAccessLog)
    .set({ subjects: params.subjects })
    .where(eq(adminAccessLog.id, params.id));
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

/** Строка журнала доступа для панели. */
export interface AccessRow {
  readonly at: string;
  readonly login: string;
  readonly route: string;
  /** На кого смотрели. Пусто — на многих сразу либо человек удалён. */
  readonly subjectUserId: string | null;
  /** Сколько человек в ответе. Пусто — **не установлено**, не «один». */
  readonly subjects: number | null;
}

export interface AccessView {
  readonly days: number;
  readonly rows: readonly AccessRow[];
  /** Всего обращений за период: список обрезан, и это должно быть видно. */
  readonly total: number;
}

/**
 * Журнал доступа как раздел панели (§16, задача 4.10).
 *
 * **Обещание задачи 4.10, которое ревизия нашла неисполненным.** План
 * сказал дословно: «И сам журнал как раздел панели (§15 не просит его
 * показывать, но разбирать инцидент по SQL неудобно) — это 4.10, где
 * живут журналы». Задачу закрыли, раздел не появился, а `recentAccess` и
 * `accessTo` остались без вызывающих вне тестов. Журнал, который никто
 * не читает, §16 исполняет лишь на бумаге: он отвечает на вопрос «кто
 * смотрел на этого человека» только тому, у кого есть доступ к SQL
 * боевой базы.
 *
 * Имён людей здесь нет нарочно: раздел про **обращения**, а не про
 * людей. Покажи мы имена — и журнал доступа сам стал бы вторым списком
 * людей, то есть новой утечкой вместо защиты. Код человека показан: по
 * нему открывается карточка, и это обращение тоже попадёт в журнал.
 */
export async function accessView(
  db: Executor,
  params: { readonly days: number; readonly limit?: number | undefined },
): Promise<AccessView> {
  const from = new Date(Date.now() - params.days * 24 * 3_600_000);
  const limit = Math.min(500, Math.max(1, params.limit ?? 100));

  const rows = await db
    .select({
      at: adminAccessLog.at,
      login: adminAccessLog.login,
      route: adminAccessLog.route,
      subjectUserId: adminAccessLog.subjectUserId,
      subjects: adminAccessLog.subjects,
    })
    .from(adminAccessLog)
    .where(gte(adminAccessLog.at, from))
    .orderBy(desc(adminAccessLog.at))
    .limit(limit);

  const [counted] = await db
    .select({ total: count() })
    .from(adminAccessLog)
    .where(gte(adminAccessLog.at, from));

  return {
    days: params.days,
    rows: rows.map((row) => ({
      at: row.at.toISOString(),
      login: row.login,
      route: row.route,
      subjectUserId: row.subjectUserId,
      subjects: row.subjects,
    })),
    total: counted?.total ?? 0,
  };
}
