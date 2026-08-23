import { eq } from 'drizzle-orm';

import { batches, messagesRaw, userSettings, users } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';

/**
 * Приватность: экспорт и удаление данных (задача 1.20).
 *
 * §16 ТЗ: кнопка удаления убирает все записи, расшифровки и профиль,
 * подтверждение в два шага. Экспорт — в машиночитаемом формате.
 *
 * Делается на первом этапе, а не на последнем: хранилище строится здесь,
 * и прикручивать удаление к готовой системе с десятком связанных таблиц
 * дороже, чем поддерживать его с самого начала.
 */

export interface ExportedData {
  readonly exportedAt: string;
  readonly profile: {
    readonly tgId: number;
    readonly username: string | null;
    readonly firstName: string | null;
    readonly timezone: string;
    readonly referralSource: string | null;
    readonly consentAt: string | null;
    readonly createdAt: string;
  };
  readonly settings: {
    readonly morningTime: string;
    readonly eveningTime: string;
    readonly notificationsOn: boolean;
    readonly quietHoursOn: boolean;
    readonly energyDefault: string;
  } | null;
  readonly dumps: readonly {
    readonly openedAt: string;
    readonly status: string;
    readonly combinedText: string | null;
  }[];
  readonly messages: readonly {
    readonly receivedAt: string;
    readonly kind: string;
    readonly text: string | null;
    readonly transcript: string | null;
  }[];
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

/**
 * Выгрузка всех данных пользователя.
 *
 * Служебные идентификаторы наружу не отдаются: человеку нужны его тексты
 * и настройки, а не наши первичные ключи.
 */
export async function exportUserData(db: Database, userId: string): Promise<ExportedData | null> {
  const [profile] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!profile) return null;

  const [settings] = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);

  const dumps = await db
    .select()
    .from(batches)
    .where(eq(batches.userId, userId))
    .orderBy(batches.openedAt);

  const messages = await db
    .select()
    .from(messagesRaw)
    .where(eq(messagesRaw.userId, userId))
    .orderBy(messagesRaw.receivedAt);

  return {
    exportedAt: new Date().toISOString(),
    profile: {
      tgId: profile.tgId,
      username: profile.username,
      firstName: profile.firstName,
      timezone: profile.timezone,
      referralSource: profile.referralSource,
      consentAt: iso(profile.consentAt),
      createdAt: profile.createdAt.toISOString(),
    },
    settings: settings
      ? {
          morningTime: settings.morningTime,
          eveningTime: settings.eveningTime,
          notificationsOn: settings.notificationsOn,
          quietHoursOn: settings.quietHoursOn,
          energyDefault: settings.energyDefault,
        }
      : null,
    dumps: dumps.map((dump) => ({
      openedAt: dump.openedAt.toISOString(),
      status: dump.status,
      combinedText: dump.combinedText,
    })),
    messages: messages.map((message) => ({
      receivedAt: message.receivedAt.toISOString(),
      kind: message.kind,
      text: message.text,
      transcript: message.transcript,
    })),
  };
}

export interface DeletionReport {
  readonly deleted: boolean;
  readonly messages: number;
  readonly dumps: number;
}

/**
 * Физическое удаление всех данных пользователя (§16 ТЗ, критерий 13).
 *
 * Записи учёта расхода не удаляются, а обезличиваются: внешний ключ
 * настроен на set null. В них нет ни строчки пользовательского текста —
 * только этап, модель, токены и стоимость, — а без них рассыпется
 * история себестоимости, по которой считается цена подписки.
 */
export async function deleteUserData(db: Database, userId: string): Promise<DeletionReport> {
  return await db.transaction(async (tx): Promise<DeletionReport> => {
    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!existing) {
      return { deleted: false, messages: 0, dumps: 0 };
    }

    // Считаем до удаления: после каскада считать будет нечего.
    const messages = await tx
      .select({ id: messagesRaw.id })
      .from(messagesRaw)
      .where(eq(messagesRaw.userId, userId));
    const dumps = await tx
      .select({ id: batches.id })
      .from(batches)
      .where(eq(batches.userId, userId));

    // Каскад по внешним ключам убирает настройки, сообщения и выгрузки.
    await tx.delete(users).where(eq(users.id, userId));

    return { deleted: true, messages: messages.length, dumps: dumps.length };
  });
}
