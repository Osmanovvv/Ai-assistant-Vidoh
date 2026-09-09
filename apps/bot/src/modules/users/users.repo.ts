import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Executor } from '../../infra/db.js';
import { userSettings, users, type User } from '../../db/schema.js';

export interface UpsertUserInput {
  readonly tgId: number;
  readonly username?: string | null;
  readonly firstName?: string | null;
  readonly languageCode?: string | null;
  /** §14 ТЗ: пишется только при первом запуске и дальше не перетирается. */
  readonly referralSource?: string | null;
}

/**
 * Идемпотентная регистрация пользователя (задача 1.9).
 *
 * Повторный /start обновляет имя и активность, но не сбрасывает источник
 * перехода и согласие на обработку данных: эти два поля описывают то, что
 * уже произошло однажды.
 */
export async function upsertUser(db: Executor, input: UpsertUserInput): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({
      tgId: input.tgId,
      username: input.username ?? null,
      firstName: input.firstName ?? null,
      languageCode: input.languageCode ?? null,
      referralSource: input.referralSource ?? null,
    })
    .onConflictDoUpdate({
      target: users.tgId,
      set: {
        username: input.username ?? null,
        firstName: input.firstName ?? null,
        languageCode: input.languageCode ?? null,
        lastActiveAt: sql`now()`,
        // Пользователь снова пишет — значит бот разблокирован.
        isBlocked: false,
        blockedAt: null,
        // COALESCE: источник проставляется, только если его ещё не было.
        referralSource: sql`coalesce(${users.referralSource}, ${input.referralSource ?? null})`,
      },
    })
    .returning();

  if (!user) {
    throw new Error('upsertUser не вернул строку');
  }

  await db.insert(userSettings).values({ userId: user.id }).onConflictDoNothing();

  return user;
}

/**
 * Пользователь заблокировал бота: планировщик обязан его пропускать.
 *
 * `blocked_at` — дата **начала** недоступности, и ставится она один раз
 * за период. COALESCE здесь по той же причине, по которой он стоит у
 * `referral_source` и условие — у `recordConsentIfAbsent`: поле отвечает
 * на вопрос «когда это случилось», а безусловная запись сдвигала бы
 * ответ при каждом новом наблюдении того же самого.
 *
 * Наблюдений много: 403 приходит на каждую попытку отправки — из
 * презентера, из рассылки, из оповещения об оплате, из апдейта о выходе
 * (`markBlocked` зовут четыре живых места). То есть у человека,
 * которому бот пишет ежедневно, дата блокировки вечно выглядела бы
 * «только что», и любое правило по её давности — от чистки до отчёта
 * «сколько людей потеряли» — считало бы не то. Прежняя запись
 * `now()` безусловно это и делала, а страж рядом
 * (`blocked.int.test.ts`) сверял `second >= first` и потому молчал.
 *
 * Про разблокировку: `upsertUser` ставит `blocked_at = null`, поэтому
 * новый период получает свою дату, а не застывшую прошлую.
 */
export async function markBlocked(db: Executor, tgId: number): Promise<void> {
  await db
    .update(users)
    .set({ isBlocked: true, blockedAt: sql`coalesce(${users.blockedAt}, now())` })
    .where(eq(users.tgId, tgId));
}

/*
  `recordConsent` убрана ревизией панели — вместе с `activeUserIds`.

  Она ставила `consent_at` безусловно, то есть была вторым способом
  сказать «человек согласился» — и способом неверным: §16 требует
  запомнить **первое** согласие, а безусловная запись сдвигала бы дату
  при каждом сообщении, и ответить «когда он согласился на самом деле»
  стало бы нечем. Живёт правило в `recordConsentIfAbsent`, у которого
  условие стоит в самом запросе.

  Вызывающих у неё не было ни одного, кроме собственной проверки. Связку
  теперь стережёт `broadcast/exports.test.ts`: этот файл добавлен в его
  список модулей.
*/

/**
 * Фиксирует согласие, если его ещё не было (§16 ТЗ).
 *
 * Согласием считается первое сообщение после экрана первого запуска, где
 * показана ссылка на политику. Отметка ставится один раз: повторные
 * сообщения не должны сдвигать дату, иначе непонятно, когда человек
 * согласился на самом деле.
 */
export async function recordConsentIfAbsent(db: Executor, userId: string): Promise<boolean> {
  const updated = await db
    .update(users)
    .set({ consentAt: sql`now()` })
    .where(and(eq(users.id, userId), isNull(users.consentAt)))
    .returning({ id: users.id });

  return updated.length > 0;
}

/*
  `activeUserIds` убрана ревизией панели.

  Её комментарий утверждал: «Пользователи, которым можно писать.
  Планировщик берёт адресатов только отсюда», — и это была неправда.
  Планировщик набирает людей своим запросом (scheduler.service.ts: связь
  с настройками и `is_blocked = false`), рассылка — своим
  (`recipientsOf`, который к тому же знает про сегменты). Вызывающих у
  функции не было ни одного, кроме её собственной проверки.

  То есть правило «кому можно писать» существовало в двух местах: живом и
  мёртвом. Мёртвое устаревает молча — про сегменты оно уже не знало, — и
  однажды по нему написали бы код. Заодно оно обещало сопровождающему,
  что менять правило надо здесь.

  Связку теперь стережёт `broadcast/exports.test.ts`: этот файл добавлен
  в его список модулей, и вернувшийся сюда экспорт без вызывающего
  покраснеет — даже если его имя останется в этом комментарии.
*/

export async function findByTgId(db: Executor, tgId: number): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.tgId, tgId)).limit(1);
  return user;
}
