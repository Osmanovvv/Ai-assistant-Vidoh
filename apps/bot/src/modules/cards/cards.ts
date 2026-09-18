import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq, sql } from 'drizzle-orm';
import { GrammyError, InputFile, type Api } from 'grammy';
import type { Logger } from 'pino';

import { appSettings } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { fitKeyboard } from '../presenter/keyboard.js';
import type { StatusButton } from '../presenter/status.service.js';
import { isBlockedError } from '../users/blocked.js';
import { markBlocked } from '../users/users.repo.js';

/**
 * Бренд-карточки (ТЗ по визуалам, проджект 18.09.2026).
 *
 * Шесть утверждённых картинок — «использовать именно эти версии» — лежат
 * в `assets/cards` и едут в образ вместе с кодом. Правило размещения —
 * редко: старт, первое утро, неделя, первое напоминание, всё накопившееся,
 * закрытие дня. Ключевая информация остаётся текстом рядом (ТЗ 4.3):
 * подпись к фото — до 1024 знаков, длинные списки идут своим сообщением.
 *
 * **Картинка уходит в Telegram один раз.** В ответ он отдаёт `file_id`,
 * и дальше карточка шлётся по нему — 270 КБ на каждое «доброе утро»
 * незачем. Идентификатор запоминается в `app_settings` под ключом
 * `card.file_id.<имя>`; отвергнутый Telegram'ом (файл перезалит, другой
 * бот) заменяется свежим со второй попытки файлом.
 *
 * Отказ отправки не роняет сценарий: карточка — украшение, суть идёт
 * текстом, и вызывающий код получает ноль, как от остальных отправителей.
 */

export type CardName = 'start' | 'morning' | 'week' | 'reminder' | 'all' | 'evening';

export const CARD_FILES: Readonly<Record<CardName, string>> = {
  start: 'start.jpg',
  morning: 'morning.jpg',
  week: 'week.jpg',
  reminder: 'reminder.jpg',
  all: 'all.jpg',
  evening: 'evening.jpg',
};

/** Папка с картинками: рядом с кодом и в исходниках, и в собранном образе. */
export function cardsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../assets/cards');
}

export interface CardSender {
  /** Возвращает номер сообщения, при сбое — ноль. */
  send(params: {
    readonly chatId: number;
    readonly threadId?: number | undefined;
    readonly card: CardName;
    readonly caption: string;
    readonly buttons?: readonly StatusButton[] | undefined;
  }): Promise<number>;
}

export interface CardSenderDeps {
  readonly api: Api;
  readonly db: Executor;
  readonly logger: Logger;
  readonly dir?: string | undefined;
}

function keyOf(card: CardName): string {
  return `card.file_id.${card}`;
}

async function rememberedId(db: Executor, card: CardName): Promise<string | undefined> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, keyOf(card)))
    .limit(1);
  return row?.value;
}

async function remember(db: Executor, card: CardName, fileId: string): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: keyOf(card), value: fileId, updatedBy: 'bot' })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: fileId, updatedAt: sql`now()`, updatedBy: 'bot' },
    });
}

/** Telegram не принял идентификатор файла: перезалить, а не сдаваться. */
function isBadFileId(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    error.error_code === 400 &&
    /file identifier|file_id|wrong remote file/iu.test(error.description)
  );
}

export function createCardSender(deps: CardSenderDeps): CardSender {
  const dir = deps.dir ?? cardsDir();

  return {
    async send({ chatId, threadId, card, caption, buttons }) {
      const options = {
        caption,
        ...(threadId === undefined ? {} : { message_thread_id: threadId }),
        ...(buttons === undefined || buttons.length === 0
          ? {}
          : { reply_markup: fitKeyboard([buttons]) }),
      };

      const post = async (photo: string | InputFile): Promise<number> => {
        const message = await deps.api.sendPhoto(chatId, photo, options);
        const fileId = message.photo.at(-1)?.file_id;
        if (photo instanceof InputFile && fileId !== undefined)
          await remember(deps.db, card, fileId);
        return message.message_id;
      };

      const known = await rememberedId(deps.db, card);
      const file = (): InputFile => new InputFile(join(dir, CARD_FILES[card]));

      try {
        if (known === undefined) return await post(file());

        try {
          return await post(known);
        } catch (error) {
          if (!isBadFileId(error)) throw error;
          deps.logger.info({ card }, 'Telegram отверг запомненный file_id карточки, шлю файлом');
          return await post(file());
        }
      } catch (error) {
        if (isBlockedError(error)) {
          deps.logger.info({ chatId }, 'Пользователь заблокировал бота, помечаю');
          await markBlocked(deps.db, chatId);
        } else {
          deps.logger.error({ err: error, chatId, card }, 'Не удалось отправить карточку');
        }
        return 0;
      }
    },
  };
}
