import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as schema from '../../db/schema.js';

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
    columns: Object.keys(getTableColumns(schema.users)),
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
    columns: Object.keys(getTableColumns(schema.userSettings)),
    decision: {
      exported: [
        'morningTime',
        'eveningTime',
        'notificationsOn',
        'eveningOn',
        'quietHoursOn',
        // Границы тишины человек выставил сам — как и времена выше.
        'quietFrom',
        'quietTo',
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
    columns: Object.keys(getTableColumns(schema.userState)),
    decision: {
      exported: ['energy', 'energyAt'],
      internal: ['userId', 'updatedAt'],
    },
  },
  {
    name: 'topics',
    columns: Object.keys(getTableColumns(schema.topics)),
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
    columns: Object.keys(getTableColumns(schema.items)),
    decision: {
      exported: [
        'text',
        // §7.4: подробности дела. Сказанное человеком, значит отдаём.
        'body',
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
        // §5: когда дело закрыли. Это факт о жизни человека, и §16 велит
        // отдавать такое наравне с его словами.
        'completedAt',
        // §13.6: запись, убранная «с чистого листа», человеку принадлежит
        // по-прежнему — и знать, что она в фоне, он вправе.
        'backgroundedAt',
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
        // Наш внешний ключ на тему. Человек видит название темы — оно
        // отдаётся полем topic, а идентификатор ему ни о чём не скажет.
        'topicId',
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
    columns: Object.keys(getTableColumns(schema.batches)),
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
    columns: Object.keys(getTableColumns(schema.messagesRaw)),
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
  {
    name: 'item_revisions',
    columns: Object.keys(getTableColumns(schema.itemRevisions)),
    decision: {
      exported: [
        // Что бот сделал с записью сам и когда. Человек имеет право
        // знать историю своих данных, а не только их нынешний вид.
        'changedBy',
        'before',
        'after',
        'revertedAt',
        'createdAt',
      ],
      internal: [
        'id',
        'itemId',
        'userId',
        // Строка решения резолвера: «подтверждено свежестью». Это наш
        // разбор жалоб, человеку она ничего не объясняет.
        'reason',
        'sourceMessageId',
      ],
    },
  },
  {
    name: 'project_steps',
    columns: Object.keys(getTableColumns(schema.projectSteps)),
    decision: {
      exported: [
        // Разложил их бот, но закрывал человек, и живут они как часть его
        // цели. Отдать «спланировать годовщину» без шагов — отдать половину.
        'text',
        'doneAt',
      ],
      internal: [
        'id',
        'itemId',
        'userId',
        // Порядок нужен нам, чтобы знать, какой шаг ближайший. Человеку в
        // выгрузке он виден самим порядком строк.
        'position',
        'createdAt',
      ],
    },
  },
  {
    name: 'pending_questions',
    columns: Object.keys(getTableColumns(schema.pendingQuestions)),
    decision: {
      exported: [
        // Сказанное человеком, которое ещё ждёт ответа. §9.1: сказанное
        // не пропадает, значит и в выгрузке оно быть обязано.
        'segment',
        'outcome',
        'createdAt',
      ],
      internal: [
        'id',
        'userId',
        'itemId',
        'batchId',
        // Служебное состояние вопроса: действие, которое применится, и
        // сроки жизни. Человеку они ничего не говорят.
        'action',
        'changes',
        'expiresAt',
        'resolvedAt',
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

/**
 * Полнота самого списка таблиц.
 *
 * Проверка выше следит за колонками — но только тех таблиц, что
 * перечислены здесь. Перечислены они руками, значит новая таблица с
 * данными человека в список не попадёт, и сторож промолчит именно там,
 * где должен закричать. Так уже и было: `items`, `topics` и `user_state`
 * появились, а выгрузка о них не узнала — и заметить это было неоткуда.
 *
 * Теперь схема сверяется целиком: каждая таблица либо разобрана по
 * колонкам выше, либо признана неличной — с причиной.
 */
const NOT_PERSONAL: readonly string[] = [
  /**
   * Поставленные напоминания (задача 3.14).
   *
   * Ни строчки сказанного человеком: вид напоминания, время отправки,
   * ссылка на запись и отметка «отправлено». Сама запись отдаётся выше
   * со всем содержимым; «бот собирался написать в 08:30 и написал» —
   * это память продукта о своём поведении.
   *
   * **Решение не бесспорное.** История напоминаний показывает, когда
   * человек не отвечал, и по ней считается снижение частоты. Но выгрузка
   * §16 существует, чтобы человек забрал **свои мысли и дела**, а не наш
   * журнал рассылки; ни одного факта о себе, которого нет в других
   * таблицах, он отсюда не узнает.
   *
   * При удалении уходит целиком: строки висят на пользователе каскадом.
   */
  'reminders',
  /**
   * Предложения запомнить регулярность (задача 3.8в).
   *
   * Здесь нет ни строчки сказанного человеком: ссылки на записи, вид
   * ритма и ответ «да/нет». Сами записи отдаются выше со всем
   * содержимым, а «бот однажды предложил и получил отказ» — это память
   * продукта о своём поведении, а не данные человека.
   *
   * При удалении уходит целиком: строки висят на пользователе каскадом,
   * и после удаления предлагать будет некому.
   */
  'recurrence_suggestions',
  // Номер апдейта Telegram и время получения. Ни текста, ни привязки к
  // человеку: удаление её не касается.
  'telegram_updates',
  // Наши промпты и их версии. Данные разработчика, не пользователя.
  'prompt_versions',
  // Учёт расхода: этап, модель, токены, стоимость, задержка. Ни строчки
  // пользовательского текста; при удалении обезличивается (set null),
  // потому что на этих числах держится история себестоимости.
  'ai_calls',
];

function tablesInSchema(): readonly string[] {
  // Через unknown: в модуле схемы лежат не только таблицы, но и
  // перечисления, и объединение их точных типов сужению не поддаётся.
  const values: readonly unknown[] = Object.values(schema);

  return values
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => getTableName(table))
    .sort((first, second) => first.localeCompare(second));
}

describe('список таблиц полон', () => {
  it('в схеме нет таблицы, о которой не принято решение', () => {
    const known = new Set([...DECISIONS.map((table) => table.name), ...NOT_PERSONAL]);
    const forgotten = tablesInSchema().filter((name) => !known.has(name));

    expect(
      forgotten,
      'Новые таблицы. Есть данные человека — разбери по колонкам в DECISIONS и добавь в exportUserData; нет — впиши в NOT_PERSONAL с причиной.',
    ).toEqual([]);
  });

  it('в списках нет таблиц, которых уже нет в схеме', () => {
    const actual = new Set(tablesInSchema());
    const stale = [...DECISIONS.map((table) => table.name), ...NOT_PERSONAL].filter(
      (name) => !actual.has(name),
    );

    expect(stale).toEqual([]);
  });
});
