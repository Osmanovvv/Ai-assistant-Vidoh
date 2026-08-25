import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

/**
 * Схема базы (задача 1.5 и далее).
 *
 * Таблицы добавляются вместе с модулями, которые ими пользуются, чтобы
 * схема не расходилась с кодом. Здесь пока пользователь, его настройки,
 * журнал апдейтов Telegram и сырые входящие сообщения.
 *
 * Идентификаторы Telegram хранятся как bigint, но читаются как обычное
 * число: платформа гарантирует, что они укладываются в 52 значащих бита,
 * то есть безопасны для JS-числа. BigInt здесь дал бы только неудобство.
 */

const tgId = (name: string) => bigint(name, { mode: 'number' });

const createdAt = (name = 'created_at') =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();

/** §5.1 ТЗ, справочник energy. */
export const energyLevel = pgEnum('energy_level', ['empty', 'low', 'normal', 'high']);

/** Вид входящего сообщения. Расширяется по мере появления новых типов. */
export const messageKind = pgEnum('message_kind', ['text', 'voice', 'audio', 'other']);

export const users = pgTable(
  'users',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    tgId: tgId('tg_id').notNull().unique(),
    username: text('username'),
    firstName: text('first_name'),
    languageCode: text('language_code'),

    /**
     * Пояс спрашивается на онбординге (§11 ТЗ), а онбординг идёт после
     * первой выгрузки (§12.2). До ответа действует значение по умолчанию,
     * и сроки первой выгрузки пересчитываются задачей 2.14.
     */
    timezone: text('timezone').notNull().default('Europe/Moscow'),
    timezoneConfirmed: boolean('timezone_confirmed').notNull().default(false),

    /**
     * §8.2 ТЗ: доступен ли этому пользователю режим тем или он работает
     * в плоском чате. Общий признак бота приходит из getMe() как
     * User.has_topics_enabled и включается в @BotFather; здесь фиксируется
     * результат для конкретного чата.
     */
    hasTopicsEnabled: boolean('has_topics_enabled').notNull().default(false),

    /** §14 ТЗ: параметр реферальной ссылки, пишется только при первом запуске. */
    referralSource: text('referral_source'),

    /** §16 ТЗ: факт согласия на обработку данных. */
    consentAt: timestamp('consent_at', { withTimezone: true }),

    /**
     * Пользователь заблокировал бота. Планировщик обязан это учитывать,
     * иначе будет бесконечно ретраить 403 (в §17 ТЗ сценария нет).
     */
    isBlocked: boolean('is_blocked').notNull().default(false),
    blockedAt: timestamp('blocked_at', { withTimezone: true }),

    createdAt: createdAt(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Частичный индекс: планировщик рассылает только незаблокированным,
    // и заблокированные не должны раздувать индекс.
    index('users_active_last_seen_idx')
      .on(table.lastActiveAt)
      .where(sql`${table.isBlocked} = false`),
  ],
);

export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),

  /** Локальное время суток в поясе пользователя (§11 ТЗ). */
  morningTime: time('morning_time').notNull().default('08:30'),
  eveningTime: time('evening_time').notNull().default('21:00'),

  notificationsOn: boolean('notifications_on').notNull().default(true),
  quietHoursOn: boolean('quiet_hours_on').notNull().default(true),

  energyDefault: energyLevel('energy_default').notNull().default('normal'),

  /**
   * Профиль текстов (§13.8 ТЗ, задача 2.11). В первой версии значение
   * одно — `reserved`.
   *
   * Текстом, а не перечислением: перечисление в базе означало бы, что
   * второй профиль требует миграции, то есть правки вне папки `texts`,
   * а условие готовности задачи 2.11 говорит обратное. Неизвестное имя
   * не роняет ответ — берётся профиль по умолчанию.
   */
  textProfile: text('text_profile').notNull().default('reserved'),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Журнал обработанных апдейтов (задача 1.8).
 *
 * Telegram переотправляет апдейт, если не получил ответ вовремя. Без этого
 * журнала повторная доставка создала бы второе сообщение и второй разбор.
 * В §9 ТЗ есть «ничего не теряем», но нет «ничего не задваиваем».
 *
 * Отдельная таблица, а не поле у сообщения: апдейтом может быть нажатие
 * кнопки или изменение статуса чата, где сообщения нет вовсе.
 */
export const telegramUpdates = pgTable(
  'telegram_updates',
  {
    updateId: tgId('update_id').primaryKey(),
    receivedAt: createdAt('received_at'),
  },
  (table) => [index('telegram_updates_received_at_idx').on(table.receivedAt)],
);

/**
 * Сырые входящие сообщения (задача 1.9).
 *
 * Инвариант §9.1: запись сюда происходит до расшифровки и до любого
 * обращения к модели. Если дальше что-то упадёт, сообщение не потеряно.
 *
 * Аудиофайл не хранится (§16 ТЗ), но file_id держим до закрытия выгрузки:
 * он позволяет переспросить расшифровку при сбое, а сам файл всё равно
 * лежит у Telegram независимо от нашего решения.
 */
export const messagesRaw = pgTable(
  'messages_raw',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    updateId: tgId('update_id').notNull(),
    tgChatId: tgId('tg_chat_id').notNull(),
    tgMessageId: tgId('tg_message_id').notNull(),
    /** Ветка в личном чате, если сообщение пришло внутри темы (§8 ТЗ). */
    tgThreadId: tgId('tg_thread_id'),

    kind: messageKind('kind').notNull(),
    text: text('text'),

    /** Ссылка Telegram на аудио. Очищается при закрытии выгрузки. */
    fileId: text('file_id'),
    audioDurationSec: bigint('audio_duration_sec', { mode: 'number' }),

    /** Заполняется модулем speech на задаче 1.15. */
    transcript: text('transcript'),

    /** Заполняется буфером на задаче 1.12. */
    batchId: uuid('batch_id'),

    receivedAt: createdAt('received_at'),
  },
  (table) => [
    // Идентификатор сообщения уникален в пределах чата: вторая вставка
    // того же сообщения невозможна даже при гонке двух воркеров.
    uniqueIndex('messages_raw_chat_message_uq').on(table.tgChatId, table.tgMessageId),
    index('messages_raw_user_received_idx').on(table.userId, table.receivedAt),
    index('messages_raw_batch_idx').on(table.batchId),
  ],
);

/** §5.1 ТЗ, справочник batch.status. */
export const batchStatus = pgEnum('batch_status', [
  'open',
  'queued',
  'processing',
  'awaiting_answer',
  'done',
  'failed',
]);

/**
 * Выгрузка: склейка нескольких сообщений в одну мысль (задачи 1.12, 1.13).
 *
 * §9.1 правило 2 ТЗ: сообщения копятся в открытую выгрузку, она закрывается,
 * когда пользователь замолчал на заданное время. Несколько голосовых подряд
 * дают один разбор и один ответ.
 */
export const batches = pgTable(
  'batches',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    status: batchStatus('status').notNull().default('open'),

    /** Склейка расшифровок и текстов в порядке получения (задача 1.13). */
    combinedText: text('combined_text'),

    /** Счётчик нужен для жёсткого потолка выгрузки в 15 сообщений. */
    messageCount: integer('message_count').notNull().default(0),

    /**
     * Сколько раз обработка этой выгрузки срывалась. Нужен, чтобы
     * временный сбой можно было повторить, но не бесконечно.
     */
    attempts: integer('attempts').notNull().default(0),

    /**
     * Одно статусное сообщение на выгрузку (задача 1.17): бот отправляет
     * его один раз и дальше правит, а не шлёт новое на каждое голосовое.
     */
    statusMessageId: bigint('status_message_id', { mode: 'number' }),
    statusUpdatedAt: timestamp('status_updated_at', { withTimezone: true }),

    openedAt: createdAt('opened_at'),
    /** От этой отметки отсчитывается окно тишины. */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    processedAt: timestamp('processed_at', { withTimezone: true }),

    error: text('error'),
  },
  (table) => [
    /**
     * Не более одной открытой выгрузки на пользователя — гарантия базы,
     * а не проверка в коде. Два воркера, одновременно принявшие сообщения
     * одного пользователя, иначе создали бы две выгрузки, и §9.1 сломался бы.
     */
    uniqueIndex('batches_one_open_per_user_uq')
      .on(table.userId)
      .where(sql`${table.status} = 'open'`),

    // Выборка выгрузок, ждущих обработки, и поиск зависших при перезапуске.
    index('batches_status_opened_idx').on(table.status, table.openedAt),
    index('batches_user_opened_idx').on(table.userId, table.openedAt),
  ],
);

/** Этапы обращения к моделям (§10.1 ТЗ плюс embedder из разбора). */
export const aiStage = pgEnum('ai_stage', [
  'speech',
  'router',
  'extractor',
  'classifier',
  'resolver',
  'presenter',
  'decomposer',
  'embedder',
]);

/**
 * Версии промптов (задачи 2.1 и 2.2).
 *
 * Источник истины — эта таблица, а не файлы в репозитории. Причина не в
 * удобстве: репозиторий публичный, а промпты и есть основное ноу-хау
 * продукта — не код решает, насколько хорошо бот разбирает кашу в голове.
 *
 * §10.4 требует версионирования, §15 — правки без выкладки. Таблица даёт
 * и то и другое: активную версию можно переключить одним запросом, а на
 * этапе 4 её правит админка.
 *
 * Схема ответа хранится рядом с промптом намеренно. Откат промпта без
 * откката схемы ломает разбор ответа, и обнаружить это надо при загрузке,
 * а не в середине обработки чужого голосового.
 */
export const promptVersions = pgTable(
  'prompt_versions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    stage: aiStage('stage').notNull(),
    /** Читаемая метка версии: extractor@3. Уникальна внутри этапа. */
    version: text('version').notNull(),

    prompt: text('prompt').notNull(),

    /**
     * Имя Zod-схемы в коде. По нему регистр находит валидатор: сам
     * валидатор в базе не сохранить, а без него ответ модели проверять
     * нечем.
     */
    schemaName: text('schema_name').notNull(),

    /**
     * JSON Schema, которую отправляем модели. Хранится не для красоты:
     * при загрузке она сверяется с тем, что порождает Zod-схема из кода,
     * и расхождение означает, что промпт откатили, а схему нет.
     */
    schemaJson: jsonb('schema_json').notNull(),

    /** Зачем эта версия появилась. Пригодится через полгода. */
    note: text('note'),

    isActive: boolean('is_active').notNull().default(false),

    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('prompt_versions_stage_version_uq').on(table.stage, table.version),
    // Ровно одна активная версия на этап. Две активные — это разбор,
    // который ведёт себя по-разному от вызова к вызову, и найти такое
    // потом почти невозможно.
    uniqueIndex('prompt_versions_one_active_per_stage_uq')
      .on(table.stage)
      .where(sql`${table.isActive}`),
  ],
);

/** §5.1 ТЗ, справочник type. */
export const itemType = pgEnum('item_type', ['TASK', 'DESIRE', 'IDEA', 'INFO', 'EMOTION']);

/** §5.1 ТЗ, справочник status. */
export const itemStatus = pgEnum('item_status', [
  'new',
  'active',
  'in_progress',
  'waiting',
  'delegated',
  'done',
  'snoozed',
  'cancelled',
]);

/** §5.1 ТЗ, справочник priority. */
export const itemPriority = pgEnum('item_priority', ['NOW', 'SOON', 'LATER', 'NONE']);

/**
 * Точность срока (задача 2.7). «В четверг» — день, «на следующей неделе» —
 * неделя. Без точности напоминание про неделю сработало бы в конкретный
 * день и не в тот.
 */
export const deadlineAccuracy = pgEnum('deadline_accuracy', ['day', 'week', 'month']);

/**
 * Записи — то, во что превращается поток мыслей (задачи 2.6 и 2.8).
 *
 * §5 ТЗ плюс `source_batch_id`: запись рождается из выгрузки, то есть из
 * склейки нескольких сообщений, а не из одного сообщения.
 *
 * §5.1 ТЗ, важное правило: **проект — это поле у записи типа TASK, а не
 * отдельный тип**. Так задача может дорасти до проекта по мере накопления
 * контекста, без миграции сущности. Делегируемость — тоже поле, а не тип.
 *
 * Черновик — запись, которую не удалось разобрать (§17 ТЗ, задача 2.3).
 * У него нет ни типа, ни приоритета, ни темы: модель дважды ответила не
 * по схеме, и выдумывать за неё нельзя. Зато текст сохранён, а значит
 * человек ничего не потерял, и разобрать это можно руками из админки.
 */
export const items = pgTable(
  'items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * Выгрузка, из которой родилась запись. При удалении выгрузки запись
     * остаётся: она уже живёт своей жизнью, а связь нужна только для
     * разбора жалоб.
     */
    sourceBatchId: uuid('source_batch_id').references(() => batches.id, { onDelete: 'set null' }),

    text: text('text').notNull(),

    /** У черновика типа нет: см. проверку ниже. */
    type: itemType('type'),
    priority: itemPriority('priority'),

    /**
     * Название темы. Пока строкой: темы у каждого человека свои и
     * создаются на онбординге (§6.4), а таблица тем появится на задаче
     * 2.15 вместе с ветками в личном чате.
     */
    topic: text('topic'),

    status: itemStatus('status').notNull().default('new'),

    /** §5.1: проект — поле у TASK, а не отдельный тип. */
    isProject: boolean('is_project').notNull().default(false),

    /**
     * Кому можно передать дело. §6.3 учитывает делегируемость при расчёте
     * приоритета, но сценария делегирования в ТЗ нет — поэтому пока это
     * поле-заметка, без механики.
     */
    assignee: text('assignee'),

    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    deadlineAccuracy: deadlineAccuracy('deadline_accuracy'),

    /**
     * Смысловое представление текста записи (задача 2.9).
     *
     * Ровно 256 измерений: столько отдаёт Yandex. В плане изначально
     * стояло 1536 от OpenAI — с такой колонкой ничего бы не сошлось,
     * и выяснилось бы это на первой же записи.
     *
     * Считается моделью `text-search-doc`, а искать надо вектором от
     * `text-search-query`: у Яндекса это разные модели, и перепутать их
     * означает получить вектора из разных пространств. Поиск при этом не
     * упадёт, а будет тихо возвращать случайное.
     */
    embedding: vector('embedding', { dimensions: 256 }),

    /**
     * Место записи внутри своей выгрузки: первое сказанное — ноль.
     *
     * Нужно выдаче. Записи одной выгрузки создаются одной вставкой, то
     * есть с одинаковым `created_at`, и без этого поля порядок равных по
     * важности дел определялся бы идентификатором, то есть случайно. Из
     * трёх названных дел человек увидел бы произвольные два — и не понял,
     * почему пропало то, что он сказал первым.
     */
    sourceOrder: integer('source_order'),

    /** Разобрать не удалось, запись ждёт ручного разбора. */
    isDraft: boolean('is_draft').notNull().default(false),
    /** Чем именно не удалось: текст ошибки и сырой ответ модели. */
    draftReason: text('draft_reason'),

    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * Разобранная запись обязана иметь тип, приоритет и тему, черновик —
     * не иметь. Проверка живёт в базе, а не только в коде: запись без типа
     * ломает и выдачу, и напоминания, и найти такое потом почти
     * невозможно — она просто тихо не показывается.
     */
    check(
      'items_draft_or_classified',
      sql`(${table.isDraft} = true) or (${table.type} is not null and ${table.priority} is not null and ${table.topic} is not null)`,
    ),
    /** Срок без точности и точность без срока одинаково бесполезны. */
    check(
      'items_deadline_with_accuracy',
      sql`(${table.deadlineAt} is null) = (${table.deadlineAccuracy} is null)`,
    ),
    // Выдача берёт активные записи пользователя по приоритету (задача 2.10).
    index('items_user_status_priority_idx').on(table.userId, table.status, table.priority),
    // Напоминания ищут по сроку (этап 3).
    index('items_user_deadline_idx').on(table.userId, table.deadlineAt),
    index('items_source_batch_idx').on(table.sourceBatchId),
    // Черновиков мало, а разбирать их надо отдельно: частичный индекс.
    index('items_drafts_idx')
      .on(table.createdAt)
      .where(sql`${table.isDraft} = true`),
    /**
     * Индекса по вектору здесь намеренно нет.
     *
     * HNSW проверен на десяти тысячах записей 25.08.2026 и оказался не
     * просто бесполезен, а **неверен** для нашего поиска. Он ищет
     * ближайших по всей таблице, а `user_id` применяется фильтром после:
     * в опыте индекс просмотрел 9928 чужих записей, отбросил все и вернул
     * ноль — при том что у человека подходящая запись была. Настройка
     * `hnsw.iterative_scan` этого не исправляет, она тоже останавливается.
     *
     * Точный поиск в пределах одного человека при этом занял 9 мс на тех
     * же десяти тысячах: сортировка по расстоянию с фильтром по
     * пользователю идёт через индекс `items_user_status_priority_idx`.
     *
     * Смысл искать по всей таблице у нас и не появится: §16 запрещает
     * смешивать данные людей. А если у одного человека когда-нибудь
     * станет сто тысяч записей, правильный ответ — секционирование по
     * пользователю, а не общий приблизительный индекс.
     */
  ],
);

/**
 * Изменчивое состояние человека (задача 2.10).
 *
 * Уровень сил — не настройка, а сегодняшнее самочувствие: от него зависит,
 * сколько дел показать. В §5 ТЗ такого поля нет, есть только значение по
 * умолчанию в настройках, и этого мало: «я на нуле» сказанное утром не
 * должно действовать вечно.
 *
 * Поэтому уровень живёт до конца суток человека, а потом выдача снова
 * берёт значение по умолчанию из настроек. Смена суток считается по его
 * часовому поясу, а не по нашему.
 */
export const userState = pgTable('user_state', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),

  energy: energyLevel('energy').notNull(),

  /**
   * Когда уровень был назван. По этой отметке и часовому поясу человека
   * решается, действует ли он ещё.
   */
  energyAt: timestamp('energy_at', { withTimezone: true }).notNull().defaultNow(),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Темы — сферы жизни человека (§5, §6.4 ТЗ).
 *
 * В плане таблица стояла на задаче 2.15 вместе с ветками в личном чате,
 * но рождаются темы раньше: на онбординге (2.13), по ответам человека о
 * том, какие сферы жизни для него важны. Без списка тем не работает
 * классификация, поэтому таблица приходит здесь, а 2.15 добавит к ней
 * только связь с веткой Telegram.
 *
 * `tg_thread_id` заведён сразу и пустым: заводить его отдельной миграцией
 * через две задачи — работа ради работы. Наружу он не показывается.
 */
export const topics = pgTable(
  'topics',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    /** §12.4: эмодзи как маркер темы, не как украшение. */
    emoji: text('emoji'),
    sortOrder: integer('sort_order').notNull().default(0),

    /** Ветка личного чата. Появится на 2.15, до тех пор пусто. */
    tgThreadId: integer('tg_thread_id'),
    /** Закреплённая сводка темы (2.16). */
    summaryMessageId: integer('summary_message_id'),

    /** §6.4: запись, не попавшая ни в одну тему, уходит в тему по умолчанию. */
    isDefault: boolean('is_default').notNull().default(false),
    isArchived: boolean('is_archived').notNull().default(false),

    createdAt: createdAt(),
  },
  (table) => [
    /**
     * Одно название темы на человека. Две «Работы» у одного человека —
     * это не гибкость, а хаос, который продукт должен убирать (§6.4).
     */
    uniqueIndex('topics_user_name_uq').on(table.userId, table.name),
    /** §8 ТЗ: пара пользователь–ветка уникальна. Пустые не мешают. */
    uniqueIndex('topics_user_thread_uq')
      .on(table.userId, table.tgThreadId)
      .where(sql`${table.tgThreadId} is not null`),
    index('topics_user_sort_idx').on(table.userId, table.sortOrder),
  ],
);

/**
 * Валюта расхода. Приводить к одной нельзя: OpenAI выставляет счёт в
 * долларах, Yandex Cloud в рублях, а курс на дату вызова задним числом
 * не восстановить.
 */
export const currency = pgEnum('currency', ['usd', 'rub']);

/**
 * Учёт обращений к моделям (задача 1.16).
 *
 * §10.5 ТЗ: таблица заполняется на каждом вызове, включая неуспешные, и
 * входит в первую версию, а не в доработки. Без неё невозможно посчитать
 * себестоимость пользователя и назначить цену подписки.
 *
 * Стоимость хранится в микроединицах валюты целым числом, а не дробью:
 * сложение тысяч мелких сумм в плавающей точке накапливает ошибку, а
 * деньги должны сходиться. null означает «цена модели неизвестна» — это
 * видно в отчёте, в отличие от молчаливого нуля.
 */
export const aiCalls = pgTable(
  'ai_calls',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    batchId: uuid('batch_id').references(() => batches.id, { onDelete: 'set null' }),

    stage: aiStage('stage').notNull(),
    model: text('model').notNull(),
    /** Версия промпта, чтобы связать жалобу с конкретной версией (§10.3 ТЗ). */
    promptVersion: text('prompt_version'),

    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    audioSeconds: integer('audio_seconds'),

    costMicros: bigint('cost_micros', { mode: 'number' }),
    /** Заполняется вместе со стоимостью: сумма без валюты бессмысленна. */
    costCurrency: currency('cost_currency'),

    latencyMs: integer('latency_ms').notNull(),
    ok: boolean('ok').notNull(),
    error: text('error'),

    createdAt: createdAt(),
  },
  (table) => [
    index('ai_calls_user_created_idx').on(table.userId, table.createdAt),
    index('ai_calls_batch_idx').on(table.batchId),
    index('ai_calls_stage_created_idx').on(table.stage, table.createdAt),
    // Отдельный индекс по сбоям: журнал ошибок §15 ТЗ листается по нему.
    index('ai_calls_failed_idx')
      .on(table.createdAt)
      .where(sql`${table.ok} = false`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserSettings = typeof userSettings.$inferSelect;
export type MessageRaw = typeof messagesRaw.$inferSelect;
export type NewMessageRaw = typeof messagesRaw.$inferInsert;
export type MessageKind = (typeof messageKind.enumValues)[number];
export type Batch = typeof batches.$inferSelect;
export type BatchStatus = (typeof batchStatus.enumValues)[number];
export type AiCall = typeof aiCalls.$inferSelect;
export type NewAiCall = typeof aiCalls.$inferInsert;
export type AiStage = (typeof aiStage.enumValues)[number];
export type UserState = typeof userState.$inferSelect;
export type EnergyLevelValue = (typeof energyLevel.enumValues)[number];
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type ItemTypeValue = (typeof itemType.enumValues)[number];
export type ItemStatusValue = (typeof itemStatus.enumValues)[number];
export type ItemPriorityValue = (typeof itemPriority.enumValues)[number];
export type PromptVersion = typeof promptVersions.$inferSelect;
export type NewPromptVersion = typeof promptVersions.$inferInsert;
export type Topic = typeof topics.$inferSelect;
export type NewTopic = typeof topics.$inferInsert;
