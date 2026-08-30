import { asc, eq } from 'drizzle-orm';

import {
  batches,
  items,
  messagesRaw,
  topics,
  userSettings,
  users,
  userState,
  itemRevisions,
  pendingQuestions,
  projectSteps,
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
    readonly quietFrom: string;
    readonly quietTo: string;
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
    /** §7.4: подробности, дописанные к делу позже. */
    readonly body: string | null;
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
    /**
     * Регулярность (задача 2.18а): фраза человека, каким способом она
     * появилась и правило, которое из неё вышло. Источник и правило — это
     * вывод бота о человеке, и §16 требует отдавать их так же, как его
     * собственные слова.
     */
    readonly recurrenceText: string | null;
    readonly recurrenceSource: string | null;
    readonly recurrenceRule: unknown;
    readonly createdAt: string;
    readonly updatedAt: string;
    /** §5: когда дело закрыли. */
    readonly completedAt: string | null;
    /** §13.6: запись убрана «с чистого листа», но не удалена. */
    readonly backgroundedAt: string | null;
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
  /**
   * История автоматических изменений (§7.3, инвариант 7).
   *
   * Человеку отдаётся не ради полноты: это перечень того, что бот
   * сделал с его записями сам. Без него человек знает только нынешнее
   * состояние и не может проверить, откуда оно взялось.
   */
  readonly revisions: readonly {
    readonly at: string;
    readonly changedBy: string;
    readonly was: string | null;
    readonly became: string | null;
    readonly undoneAt: string | null;
  }[];
  /**
   * Шаги больших целей (§5, задача 3.12).
   *
   * Разложил их бот, но живут они как часть цели человека, и он их
   * закрывал. Отдать запись «спланировать годовщину» без шагов значило бы
   * отдать половину.
   */
  readonly projectSteps: readonly {
    readonly project: string;
    readonly text: string;
    readonly doneAt: string | null;
  }[];
  /** Незакрытые уточняющие вопросы: в них лежат слова человека. */
  readonly questions: readonly {
    readonly askedAt: string;
    readonly segment: string;
    readonly outcome: string | null;
  }[];
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

/** Заголовок записи из снимка ревизии. */
function titleOf(snapshot: unknown): string | null {
  const text = (snapshot as { readonly text?: unknown } | null)?.text;
  return typeof text === 'string' ? text : null;
}

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

  const revisions = await db
    .select({
      createdAt: itemRevisions.createdAt,
      changedBy: itemRevisions.changedBy,
      before: itemRevisions.before,
      after: itemRevisions.after,
      revertedAt: itemRevisions.revertedAt,
    })
    .from(itemRevisions)
    .where(eq(itemRevisions.userId, userId))
    .orderBy(asc(itemRevisions.createdAt));

  const steps = await db
    .select({
      project: items.text,
      text: projectSteps.text,
      position: projectSteps.position,
      doneAt: projectSteps.doneAt,
    })
    .from(projectSteps)
    .innerJoin(items, eq(items.id, projectSteps.itemId))
    .where(eq(projectSteps.userId, userId))
    .orderBy(asc(items.createdAt), asc(projectSteps.position));

  const questions = await db
    .select({
      createdAt: pendingQuestions.createdAt,
      segment: pendingQuestions.segment,
      outcome: pendingQuestions.outcome,
    })
    .from(pendingQuestions)
    .where(eq(pendingQuestions.userId, userId))
    .orderBy(asc(pendingQuestions.createdAt));

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
          quietFrom: settings.quietFrom,
          quietTo: settings.quietTo,
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
      body: item.body,
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
      recurrenceText: item.recurrenceText,
      recurrenceSource: item.recurrenceSource,
      recurrenceRule: item.recurrenceRule,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      completedAt: iso(item.completedAt),
      backgroundedAt: iso(item.backgroundedAt),
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
    /**
     * Из снимка берётся заголовок, а не строка целиком.
     *
     * Сама запись уже отдана выше со всеми полями; повторять её здесь
     * дважды на каждое изменение значило бы раздуть файл втрое и
     * спрятать в нём главное — что именно поменялось.
     */
    revisions: revisions.map((revision) => ({
      at: revision.createdAt.toISOString(),
      changedBy: revision.changedBy,
      was: titleOf(revision.before),
      became: titleOf(revision.after),
      undoneAt: iso(revision.revertedAt),
    })),
    projectSteps: steps.map((step) => ({
      project: step.project,
      text: step.text,
      doneAt: iso(step.doneAt),
    })),
    questions: questions.map((question) => ({
      askedAt: question.createdAt.toISOString(),
      segment: question.segment,
      outcome: question.outcome,
    })),
  };
}

export interface DeletionReport {
  readonly deleted: boolean;
  readonly messages: number;
  readonly dumps: number;
  /**
   * Ветки Telegram, созданные ботом под темы человека.
   *
   * Возвращаются наружу, потому что чистит их вызывающая сторона: у неё
   * есть чат и шлюз, а у службы — только база. Читаются до удаления,
   * после каскада читать будет негде.
   */
  readonly threadIds: readonly number[];
}

/**
 * Физическое удаление всех данных пользователя (§16 ТЗ, критерий 13).
 *
 * **Чата это не касается, и об этом надо помнить.** База чистится
 * каскадом целиком, но ветки тем, закреплённые сводки и голосовые живут
 * в Telegram. Ветки удаляет вызывающая сторона по возвращённым здесь
 * идентификаторам — иначе человек нажимает «удалить мои данные» и
 * продолжает видеть свои дела в закрепах. Найдено ручной проверкой
 * 29.08.2026.
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
      return { deleted: false, messages: 0, dumps: 0, threadIds: [] };
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

    // Ветки тоже до удаления: строки тем уйдут вместе с человеком.
    const threads = await tx
      .select({ threadId: topics.tgThreadId })
      .from(topics)
      .where(eq(topics.userId, userId));

    // Каскад по внешним ключам убирает настройки, сообщения и выгрузки.
    await tx.delete(users).where(eq(users.id, userId));

    return {
      deleted: true,
      messages: messages.length,
      dumps: dumps.length,
      threadIds: threads
        .map((row) => row.threadId)
        .filter((threadId): threadId is number => threadId !== null),
    };
  });
}
