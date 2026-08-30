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
  /**
   * Вечернее напоминание отдельным выключателем (задача 2.13).
   *
   * В §11 ТЗ выключатель один, общий. Этого мало: на онбординге человек
   * может сказать «не надо вечером», и выключать ему заодно утренние —
   * значит понять его неверно. Одна колонка сейчас дешевле, чем
   * недоумение «я же просила только вечером не писать».
   */
  eveningOn: boolean('evening_on').notNull().default(true),
  quietHoursOn: boolean('quiet_hours_on').notNull().default(true),
  /**
   * Границы тишины (задача 3.17). Через полночь — это норма, а не ошибка.
   *
   * Выключатель `quiet_hours_on` существовал с задачи 2.13 и до сих пор
   * ничего не выключал: часов, которые он мог бы погасить, не было. §11
   * требует «режим тишины» в настройках, а режим без границ — это флаг,
   * который ничего не делает.
   */
  quietFrom: time('quiet_from').notNull().default('22:00'),
  quietTo: time('quiet_to').notNull().default('08:00'),

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

  /**
   * Шаг онбординга (§12.2 ТЗ, задача 2.13). Ноль — не начинался.
   *
   * §12.2 требует, чтобы онбординг шёл после первой выгрузки, а не до
   * неё, поэтому состояние нужно хранить: спросить сразу нельзя, а
   * забывать, на чём остановились, нельзя тем более.
   */
  onboardingStep: integer('onboarding_step').notNull().default(0),
  onboardingDoneAt: timestamp('onboarding_done_at', { withTimezone: true }),

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
 * Каким из четырёх способов появилась регулярность (запрос на изменение
 * №1, задача 2.18а).
 *
 * Отдельная колонка, а не признак «регулярное», потому что способы надо
 * мерить по отдельности: если предложения бота отклоняются в девяти
 * случаях из десяти, их надо выключить, а узнать это можно только считая
 * по источнику.
 */
export const recurrenceSource = pgEnum('recurrence_source', [
  'stated',
  'asked',
  'noticed',
  'history',
]);

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

    /**
     * Подробности, которые человек добавил к делу позже (§7.4 ТЗ).
     *
     * «Записать сына к врачу» — заголовок. «А ещё туда надо взять карту
     * прививок» — подробность: она не заменяет дело и не меняет срок, но
     * потерять её нельзя.
     *
     * Отдельным полем, а не дописыванием в заголовок: заголовок человек
     * читает в списке из десяти строк, и «Записать сына к врачу, а ещё
     * туда надо взять карту прививок, и не забыть полис» перестанет
     * читаться на третьей подробности.
     */
    body: text('body'),

    /** У черновика типа нет: см. проверку ниже. */
    type: itemType('type'),
    priority: itemPriority('priority'),

    /**
     * Тема записи — ссылкой, а не названием (§5 ТЗ).
     *
     * Названием она хранилась с тех пор, когда таблицы тем ещё не
     * существовало: комментарий здесь так и говорил «пока строкой, таблица
     * появится на 2.15». Таблица появилась, колонка осталась прежней —
     * нашлось сверкой с ТЗ 28.08.2026.
     *
     * Разница не формальная. Переименуй человек тему — записи с прежним
     * названием выпали бы и из списка темы, и из закреплённой сводки.
     * Молча: ошибки нет, дела просто исчезают из вида.
     *
     * `set null`, а не `restrict`: удаление человека по §16 идёт каскадом
     * и по темам, и по записям, а `restrict` заблокировал бы само
     * удаление его данных.
     */
    topicId: uuid('topic_id').references(() => topics.id, { onDelete: 'set null' }),

    /**
     * Название темы рядом со ссылкой — намеренно.
     *
     * Истина — `topic_id`: он и держит целостность. Название лежит рядом
     * как кэш для показа, чтобы список темы и карточка не требовали
     * соединения в двенадцати местах чтения.
     *
     * **Кто меняет тему, обязан менять оба поля в одной транзакции.** Пока
     * переименования тем в продукте нет (экран настроек — этап 3), и
     * писатель один — сохранение разбора. Когда переименование появится,
     * оно правит и `topics.name`, и это поле; ссылка при этом гарантирует,
     * что записи не осиротеют, даже если кэш отстанет.
     *
     * Расхождение проверяется тестом: два источника истины расходятся
     * молча, и заметить это без проверки нельзя.
     */
    topic: text('topic'),

    status: itemStatus('status').notNull().default('new'),

    /**
     * Когда дело закрыли (§5 ТЗ).
     *
     * Карточка помечала «сделано» с задачи 2.18, а *когда* — не
     * сохранялось: статус менялся, и всё. Понадобится и напоминаниям, и
     * разговору о качестве.
     */
    completedAt: timestamp('completed_at', { withTimezone: true }),

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
     * Правило повторения (задача 2.18а). §5.1: регулярность — поле у
     * `TASK`, а не отдельный тип, как проект и делегируемость. Так разовое
     * дело становится регулярным без миграции сущности.
     */
    recurrenceRule: jsonb('recurrence_rule'),
    /** Как человек это сказал: «каждый вторник». Живёт и без правила. */
    recurrenceText: text('recurrence_text'),
    recurrenceSource: recurrenceSource('recurrence_source'),

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
    /**
     * Правило повторения бывает только у задачи (§5.1), и любая
     * регулярность обязана знать свой источник — иначе способы 3 и 4 из
     * запроса на изменение нечем будет мерить.
     */
    check(
      'items_recurrence_task_only',
      sql`${table.recurrenceRule} is null or ${table.type} = 'TASK'`,
    ),
    check(
      'items_recurrence_has_source',
      sql`(${table.recurrenceRule} is null and ${table.recurrenceText} is null) or ${table.recurrenceSource} is not null`,
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

    /**
     * Версия модели, которой ответил провайдер (хвост 9).
     *
     * `latest` — это ветка, а не модель: за ней стоит поколение, которое
     * однажды поменяется. От поколения зависят и цена, и качество
     * разбора, а порог качества мерился на конкретном. Без этой колонки
     * смена поколения выглядела бы как «бот вдруг стал хуже» и как
     * расхождение расхода со счётом, и связать одно с другим было бы нечем.
     */
    modelVersion: text('model_version'),
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

/**
 * Кто изменил запись (§7.3 ТЗ, задача 3.3).
 *
 * В §5 справочник не задан — значения выбраны здесь и перечислены в
 * плане. Различать источник обязательно: «бот поменял сам» и «я сама
 * поменяла» — разные события и для человека, и для разбора жалобы.
 */
export const changedBy = pgEnum('changed_by', ['user', 'resolver', 'scheduler', 'admin']);

/**
 * История изменений записи (инвариант 7, §7.3 ТЗ).
 *
 * «Каждое применение изменения пишется в историю ревизий вместе со
 * снимком записи до изменения. Кнопка отмены откатывает последнюю
 * ревизию.»
 *
 * **Снимок целиком, а не список полей.** Перечислять изменённые поля
 * дешевле по месту, но откат по такому списку восстановит ровно то, что
 * мы догадались в него положить. Снимок переживает и добавление полей в
 * схему, и ошибку в самом применении.
 *
 * Хранится и «до», и «после»: по одному «до» видно, что было, но не
 * видно, что стало, — а следующая правка перепишет запись, и сравнить
 * будет уже не с чем.
 */
export const itemRevisions = pgTable(
  'item_revisions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),

    /**
     * Владелец — рядом, а не только через запись.
     *
     * §16 требует стирать данные человека целиком, и удаление обязано
     * доставать ревизии по прямой связи, не полагаясь на то, что каскад
     * дойдёт сюда через записи.
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    changedBy: changedBy('changed_by').notNull(),
    /** Почему изменено: строка решения резолвера, для разбора жалоб. */
    reason: text('reason'),

    /** Полный снимок строки записи до изменения и после него. */
    before: jsonb('before').notNull(),
    after: jsonb('after').notNull(),

    /** Сообщение, из-за которого случилось изменение. */
    sourceMessageId: uuid('source_message_id').references(() => messagesRaw.id, {
      onDelete: 'set null',
    }),

    /** Проставляется откатом. Пустое — ревизия ещё в силе. */
    revertedAt: timestamp('reverted_at', { withTimezone: true }),

    createdAt: createdAt(),
  },
  (table) => [
    // Откат берёт последнюю ревизию записи — по этому индексу.
    index('item_revisions_item_created_idx').on(table.itemId, table.createdAt),
    index('item_revisions_user_idx').on(table.userId),
  ],
);

/**
 * Чем кончился уточняющий вопрос (§7.3 ТЗ, задача 3.5).
 *
 * Три последних значения — не «ошибки», а нормальные исходы. §7.3:
 * «продукт не имеет права превращаться в допрос», и вопрос без ответа
 * должен уметь тихо закончиться.
 */
export const questionOutcome = pgEnum('question_outcome', [
  /** Человек выбрал «Добавить к прошлой». */
  'attached',
  /** Человек выбрал «Это новое». */
  'separate',
  /** Шесть часов прошло. */
  'timeout',
  /** Пришла новая выгрузка, и вопрос снят. */
  'superseded',
]);

/**
 * Открытый уточняющий вопрос (§7.3 ТЗ, задача 3.5).
 *
 * «Пока вопрос не отвечен, сегмент хранится в таблице открытых вопросов
 * и не теряется.»
 *
 * Одновременно у человека висит не более одного вопроса — за этим следит
 * частичный уникальный индекс, а не только код: два открытых вопроса
 * означали бы допрос, которого §7.3 не допускает.
 */
export const pendingQuestions = pgTable(
  'pending_questions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * Запись, о которой спрашиваем.
     *
     * Исчезнет запись — исчезнет и вопрос: спрашивать «это про неё?» про
     * то, чего нет, бессмысленно.
     */
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),

    /**
     * Выгрузка, из которой родился вопрос.
     *
     * Нужна не для истории: если человек ответит «это новое» или не
     * ответит вовсе, сегмент станет записью — и запись эта принадлежит
     * той же выгрузке, что и остальные её дела.
     */
    batchId: uuid('batch_id')
      .notNull()
      .references(() => batches.id, { onDelete: 'cascade' }),

    /** Сказанное человеком: то, что не должно потеряться. */
    segment: text('segment').notNull(),
    /** Что применить, если человек ответит «добавить к прошлой». */
    action: text('action').notNull(),
    changes: jsonb('changes').notNull(),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    /** Пусто — вопрос открыт. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    outcome: questionOutcome('outcome'),

    createdAt: createdAt(),
  },
  (table) => [
    /**
     * Один открытый вопрос на человека.
     *
     * Частичный индекс, а не проверка в коде: гонка двух выгрузок
     * обошла бы проверку и оставила бы человека с двумя вопросами.
     */
    uniqueIndex('pending_questions_open_uq')
      .on(table.userId)
      .where(sql`${table.resolvedAt} is null`),
    index('pending_questions_expires_idx').on(table.expiresAt),
  ],
);

/** Чем кончилось предложение запомнить регулярность (задача 3.8в). */
export const suggestionOutcome = pgEnum('suggestion_outcome', [
  /** Человек согласился: правило выставлено. */
  'accepted',
  /** Человек отказался. Больше этой связке не предлагаем — никогда. */
  'declined',
  /** Предложили и не дождались ответа. */
  'ignored',
]);

/**
 * Предложения запомнить регулярность (задача 3.8в).
 *
 * **Отказ запоминается навсегда — это половина задачи.** Функция,
 * которая раз в неделю переспрашивает одно и то же, становится
 * ненавистной за месяц. Поэтому отклонённая связка записывается сюда и
 * больше не предлагается никогда.
 *
 * Связка хранится списком записей, а не текстом: «оплатить садик»,
 * «садик оплатить» и «заплатить за садик» — одно дело, и текстом их не
 * сопоставить. Пересечение по записям точнее любой нормализации.
 */
export const recurrenceSuggestions = pgTable(
  'recurrence_suggestions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** Запись, о которой спрашивали: самая свежая из связки. */
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),

    /** Вся связка целиком: по ней узнаётся уже отклонённое. */
    itemIds: jsonb('item_ids').notNull(),

    kind: text('kind').notNull(),
    interval: integer('interval').notNull(),

    outcome: suggestionOutcome('outcome'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    createdAt: createdAt(),
  },
  (table) => [
    // Недельный предел ищется по последнему предложению человека.
    index('recurrence_suggestions_user_created_idx').on(table.userId, table.createdAt),
  ],
);

/**
 * Шаги большой составной цели (§5 ТЗ, задача 3.12).
 *
 * «День рождения сына» — это не задача, а проект: внутри десяток дел, и
 * человек думает о нём как об одном. §13.2 требует урезать большую цель
 * до посильного первого шага, поэтому **наружу выдаётся только шаг с
 * признаком `is_next`**, а не список из десяти пунктов. Десять пунктов в
 * ответ на «что сегодня» — это не помощь, а та же гора, только в профиль.
 *
 * Шаги живут отдельной таблицей, а не записями: у них нет ни темы, ни
 * приоритета, ни срока, и попав в общий список дел они удвоили бы его.
 */
export const projectSteps = pgTable(
  'project_steps',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    /** Запись-проект, к которой относятся шаги. */
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    text: text('text').notNull(),
    /** Порядок, в котором шаги имеют смысл. */
    position: integer('position').notNull(),

    doneAt: timestamp('done_at', { withTimezone: true }),

    createdAt: createdAt(),
  },
  (table) => [
    /**
     * Порядок шагов внутри проекта уникален.
     *
     * Два шага с номером три — это два «ближайших», и выдача начнёт
     * показывать то один, то другой в зависимости от порядка строк.
     */
    uniqueIndex('project_steps_item_position_uq').on(table.itemId, table.position),
    index('project_steps_user_idx').on(table.userId),
  ],
);

/**
 * Поставленные напоминания (§11 ТЗ, задача 3.14).
 *
 * **Задание, а не отправка.** Планировщик просыпается часто и раскладывает
 * будущее по строкам; отправка потом только читает готовое. Разделение
 * нужно ради двух вещей: ключа, исключающего дубли, и распределения
 * отправки во времени — Telegram не даёт разослать всё разом.
 *
 * `item_id` необязателен: у утреннего и вечернего напоминания записи нет,
 * определяющим является `kind`.
 */
export const reminderKind = pgEnum('reminder_kind', [
  /** Приглашение выгрузить мысли и дела на сегодня (3.15). */
  'morning',
  /** Короткий итог дня (3.15). */
  'evening',
  /** Накануне вечером о завтрашнем сроке (3.16). */
  'deadline_eve',
  /** Утром в день срока (3.16). */
  'deadline_day',
  /** Вопрос про ближайший шаг застрявшего проекта (3.13). */
  'project',
]);

export const reminders = pgTable(
  'reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Пусто у утренних и вечерних: они про день, а не про запись. */
    itemId: uuid('item_id').references(() => items.id, { onDelete: 'cascade' }),
    kind: reminderKind('kind').notNull(),

    /** Момент отправки в UTC. Местное время человека уже учтено. */
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),

    /**
     * Ключ, исключающий дубли при повторном запуске планировщика.
     *
     * Собирается из вида, местной даты и записи: «morning:2026-08-30».
     * Планировщик может проснуться дважды, упасть посередине и подняться
     * снова — вторая строка с тем же ключом просто не вставится.
     *
     * Уникальность в базе, а не проверкой перед вставкой: между «проверил»
     * и «вставил» помещается второй экземпляр процесса.
     */
    dedupeKey: text('dedupe_key').notNull(),

    /** Пусто — ещё не отправлено. Заполнено — отправлять больше не нужно. */
    sentAt: timestamp('sent_at', { withTimezone: true }),

    /**
     * Почему не отправили: 'quiet', 'off', 'gone', 'rare'.
     *
     * Отменённое напоминание не удаляется, а помечается. Иначе счётчик
     * игнорирований (3.17) не отличит «человек не ответил» от «мы сами
     * не отправили», и тишина в настройках начнёт снижать частоту.
     */
    skippedReason: text('skipped_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('reminders_user_key_uq').on(table.userId, table.dedupeKey),
    /** Выборка «что пора отправить» — самый частый запрос планировщика. */
    index('reminders_pending_idx').on(table.dueAt),
    index('reminders_user_kind_idx').on(table.userId, table.kind),
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
export type ItemRevision = typeof itemRevisions.$inferSelect;
export type NewItemRevision = typeof itemRevisions.$inferInsert;
export type ChangedBy = (typeof changedBy.enumValues)[number];
export type PendingQuestion = typeof pendingQuestions.$inferSelect;
export type NewPendingQuestion = typeof pendingQuestions.$inferInsert;
export type QuestionOutcome = (typeof questionOutcome.enumValues)[number];
export type RecurrenceSuggestion = typeof recurrenceSuggestions.$inferSelect;
export type SuggestionOutcome = (typeof suggestionOutcome.enumValues)[number];
export type ProjectStep = typeof projectSteps.$inferSelect;
export type NewProjectStep = typeof projectSteps.$inferInsert;
export type DeadlineAccuracyValue = (typeof deadlineAccuracy.enumValues)[number];
export type Reminder = typeof reminders.$inferSelect;
export type NewReminder = typeof reminders.$inferInsert;
export type ReminderKindValue = (typeof reminderKind.enumValues)[number];
export type Topic = typeof topics.$inferSelect;
export type NewTopic = typeof topics.$inferInsert;
