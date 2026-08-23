import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
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

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserSettings = typeof userSettings.$inferSelect;
export type MessageRaw = typeof messagesRaw.$inferSelect;
export type NewMessageRaw = typeof messagesRaw.$inferInsert;
export type MessageKind = (typeof messageKind.enumValues)[number];
