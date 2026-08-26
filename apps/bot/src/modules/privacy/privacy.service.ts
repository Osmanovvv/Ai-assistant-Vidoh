import { asc, eq } from 'drizzle-orm';

import {
  batches,
  items,
  messagesRaw,
  topics,
  userSettings,
  users,
  userState,
} from '../../db/schema.js';
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
 *
 * **Дополнено 26.08.2026: экспорт отдавал не всё.** Поля здесь
 * перечисляются по именам, а таблиц `items`, `topics` и `user_state` на
 * задаче 1.20 ещё не существовало — и человек по «Выгрузить мои данные»
 * получал сообщения и настройки, но не свои дела и не свои сферы жизни.
 * Ошибка тихая: экспорт работал, файл приходил, и что в нём чего-то нет,
 * заметить было неоткуда.
 *
 * Чтобы это не повторилось с каждой новой таблицей, есть отдельная
 * проверка: она сверяет колонки со списком решений «отдаём / не отдаём» и
 * падает на любой новой колонке, пока её не отнесут к одному из двух.
 * Забыть теперь нельзя — сборка не соберётся.
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
    readonly eveningOn: boolean;
    readonly quietHoursOn: boolean;
    readonly energyDefault: string;
    readonly textProfile: string;
    readonly onboardingDoneAt: string | null;
  } | null;
  /**
   * Сегодняшний уровень сил — вывод бота о человеке, а не его слова.
   * §16 требует отдавать и это: иначе выгрузка показывает не всё, что о
   * нём известно.
   */
  readonly state: {
    readonly energy: string;
    readonly energyAt: string;
  } | null;
  readonly topics: readonly {
    readonly name: string;
    readonly emoji: string | null;
    readonly isDefault: boolean;
    readonly isArchived: boolean;
    readonly createdAt: string;
  }[];
  readonly items: readonly {
    readonly text: string;
    readonly type: string | null;
    readonly priority: string | null;
    readonly topic: string | null;
    readonly status: string;
    readonly isProject: boolean;
    readonly assignee: string | null;
    readonly deadlineAt: string | null;
    readonly deadlineAccuracy: string | null;
    readonly isDraft: boolean;
    readonly draftReason: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  }[];
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

  const [state] = await db.select().from(userState).where(eq(userState.userId, userId)).limit(1);

  const ownTopics = await db
    .select()
    .from(topics)
    .where(eq(topics.userId, userId))
    .orderBy(asc(topics.sortOrder), asc(topics.name));

  const ownItems = await db
    .select()
    .from(items)
    .where(eq(items.userId, userId))
    .orderBy(asc(items.createdAt), asc(items.sourceOrder), asc(items.id));

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
          eveningOn: settings.eveningOn,
          quietHoursOn: settings.quietHoursOn,
          energyDefault: settings.energyDefault,
          textProfile: settings.textProfile,
          onboardingDoneAt: iso(settings.onboardingDoneAt),
        }
      : null,
    state: state ? { energy: state.energy, energyAt: state.energyAt.toISOString() } : null,
    topics: ownTopics.map((topic) => ({
      name: topic.name,
      emoji: topic.emoji,
      isDefault: topic.isDefault,
      isArchived: topic.isArchived,
      createdAt: topic.createdAt.toISOString(),
    })),
    items: ownItems.map((item) => ({
      text: item.text,
      type: item.type,
      priority: item.priority,
      topic: item.topic,
      status: item.status,
      isProject: item.isProject,
      assignee: item.assignee,
      deadlineAt: iso(item.deadlineAt),
      deadlineAccuracy: item.deadlineAccuracy,
      isDraft: item.isDraft,
      draftReason: item.draftReason,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    })),
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
