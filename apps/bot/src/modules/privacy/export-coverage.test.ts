import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  batches,
  items,
  messagesRaw,
  topics,
  userSettings,
  users,
  userState,
} from '../../db/schema.js';

/**
 * Полнота выгрузки данных (§16 ТЗ, задача 1.20).
 *
 * Экспорт перечисляет поля по именам — иначе наружу уехали бы наши
 * первичные ключи и служебные признаки. Плата за это: новая колонка в
 * выгрузку сама не попадает. Так и вышло с записями, темами и уровнем
 * сил: таблиц на задаче 1.20 не существовало, а когда они появились,
 * экспорт о них не узнал. Ошибка тихая — файл приходит, и что в нём
 * чего-то нет, заметить неоткуда.
 *
 * Эта проверка делает её громкой. Каждая колонка каждой таблицы с
 * пользовательскими данными обязана быть отнесена к одному из двух
 * списков: отдаём человеку или намеренно не отдаём. Добавил колонку —
 * тест красный, пока не решишь, к какому списку она относится.
 *
 * Проверяется именно наличие решения, а не его правильность: решение
 * принимает человек, а тест следит, что оно принято.
 */

interface Decision {
  /** Уходит в файл выгрузки. */
  readonly exported: readonly string[];
  /** Намеренно не уходит, с причиной в комментарии рядом. */
  readonly internal: readonly string[];
}

const DECISIONS: readonly {
  readonly name: string;
  readonly columns: string[];
  readonly decision: Decision;
}[] = [
  {
    name: 'users',
    columns: Object.keys(getTableColumns(users)),
    decision: {
      exported: [
        'tgId',
        'username',
        'firstName',
        'timezone',
        'referralSource',
        'consentAt',
        'createdAt',
      ],
      internal: [
        // Наш первичный ключ, человеку он ни о чём не говорит.
        'id',
        // Служебные признаки платформы и нашего состояния.
        'languageCode',
        'timezoneConfirmed',
        'hasTopicsEnabled',
        'isBlocked',
        'blockedAt',
        'lastActiveAt',
      ],
    },
  },
  {
    name: 'user_settings',
    columns: Object.keys(getTableColumns(userSettings)),
    decision: {
      exported: [
        'morningTime',
        'eveningTime',
        'notificationsOn',
        'eveningOn',
        'quietHoursOn',
        'energyDefault',
        'textProfile',
        'onboardingDoneAt',
      ],
      internal: [
        'userId',
        // Шаг опроса — внутреннее состояние диалога, не факт о человеке.
        'onboardingStep',
        'updatedAt',
      ],
    },
  },
  {
    name: 'user_state',
    columns: Object.keys(getTableColumns(userState)),
    decision: {
      exported: ['energy', 'energyAt'],
      internal: ['userId', 'updatedAt'],
    },
  },
  {
    name: 'topics',
    columns: Object.keys(getTableColumns(topics)),
    decision: {
      exported: ['name', 'emoji', 'isDefault', 'isArchived', 'createdAt'],
      internal: [
        'id',
        'userId',
        'sortOrder',
        // Идентификаторы Telegram наружу не показываются (§8 ТЗ).
        'tgThreadId',
        'summaryMessageId',
      ],
    },
  },
  {
    name: 'items',
    columns: Object.keys(getTableColumns(items)),
    decision: {
      exported: [
        'text',
        'type',
        'priority',
        'topic',
        'status',
        'isProject',
        'assignee',
        'deadlineAt',
        'deadlineAccuracy',
        'isDraft',
        'draftReason',
        'createdAt',
        'updatedAt',
        // Задача 2.18а. Фраза — слова человека, источник и правило — вывод
        // бота о нём, и §16 требует отдавать и то и другое.
        'recurrenceText',
        'recurrenceSource',
        'recurrenceRule',
      ],
      internal: [
        'id',
        'userId',
        'sourceBatchId',
        'sourceOrder',
        // Вектор — машинное представление того самого текста, который в
        // выгрузку уже вошёл. Двести пятьдесят шесть чисел человеку
        // ничего не скажут, а по существу от него ничего не скрыто.
        // Это не то же, что вывод бота о человеке: тот отдавать надо.
        'embedding',
      ],
    },
  },
  {
    name: 'batches',
    columns: Object.keys(getTableColumns(batches)),
    decision: {
      exported: ['openedAt', 'status', 'combinedText'],
      internal: [
        'id',
        'userId',
        'closedAt',
        'processedAt',
        'messageCount',
        'attempts',
        'error',
        'statusMessageId',
        'statusUpdatedAt',
        'lastMessageAt',
      ],
    },
  },
  {
    name: 'messages_raw',
    columns: Object.keys(getTableColumns(messagesRaw)),
    decision: {
      exported: ['receivedAt', 'kind', 'text', 'transcript'],
      internal: [
        'id',
        'userId',
        'updateId',
        'tgChatId',
        'tgMessageId',
        'tgThreadId',
        'fileId',
        'audioDurationSec',
        'batchId',
      ],
    },
  },
];

describe('решение по каждой колонке принято', () => {
  for (const table of DECISIONS) {
    it(`${table.name}: нет ни одной неучтённой колонки`, () => {
      const decided = new Set([...table.decision.exported, ...table.decision.internal]);
      const forgotten = table.columns.filter((column) => !decided.has(column));

      expect(
        forgotten,
        `Колонки без решения в таблице ${table.name}. Отдаём человеку — добавь в exported и в exportUserData; не отдаём — добавь в internal с причиной.`,
      ).toEqual([]);
    });

    it(`${table.name}: в списках нет колонок, которых уже не существует`, () => {
      // Обратная сторона: колонку удалили, а решение о ней осталось.
      // Список решений должен описывать нынешнюю схему, а не прошлую.
      const actual = new Set(table.columns);
      const stale = [...table.decision.exported, ...table.decision.internal].filter(
        (column) => !actual.has(column),
      );

      expect(stale).toEqual([]);
    });
  }
});
