import { randomUUID } from 'node:crypto';

import { InlineKeyboard } from 'grammy';
import { describe, expect, it } from 'vitest';

import type { Item } from '../db/schema.js';
import {
  ACTION as ONBOARDING,
  timezoneQuestion,
  topicRows,
  questionFor,
  STEP,
} from '../modules/onboarding/onboarding.service.js';
import { buildReply } from '../modules/presenter/presenter.service.js';
import { defaultTexts } from '../texts/index.js';
import { cardKeyboard } from './handlers/card.js';
import { MENU_ACTION } from './handlers/menu.js';
import { DELETE_CANCEL, DELETE_STEP_ONE, DELETE_STEP_TWO } from './handlers/privacy.js';
import { CALLBACK_DATA_LIMIT, callbackDataSize, toShortId } from './short-id.js';

/**
 * Длина `callback_data` у всех клавиатур проекта (задача 2.18).
 *
 * План прямо требует проверять **все** клавиатуры, а не те, что попались
 * на глаза: предел в 64 байта пробивается незаметно и обнаруживается уже
 * в бою, когда клавиатур десяток. Поэтому здесь собраны все места, где
 * рождается `callback_data`, — и данные берутся худшие из возможных, а не
 * удобные.
 *
 * Проверяется размер в **байтах**: предел Telegram задан в них, а
 * кириллица весит по два байта на знак.
 */

/** Худший случай: очень длинное название темы и очень длинный текст дела. */
const LONG_NAME = 'сфера жизни с очень длинным названием, какое человек может себе придумать сам';
const LONG_TEXT = 'дело с очень длинным текстом, какой получается из живой речи без остановки';

function itemFixture(): Item {
  return {
    id: randomUUID(),
    userId: randomUUID(),
    sourceBatchId: null,
    sourceOrder: 0,
    recurrenceRule: null,
    recurrenceText: null,
    recurrenceSource: null,
    text: LONG_TEXT,
    type: 'TASK',
    priority: 'SOON',
    topic: LONG_NAME,
    status: 'new',
    isProject: false,
    assignee: null,
    deadlineAt: new Date('2026-09-04T00:00:00.000Z'),
    deadlineAccuracy: 'day',
    embedding: null,
    isDraft: false,
    draftReason: null,
    createdAt: new Date('2026-08-26T00:00:00.000Z'),
    updatedAt: new Date('2026-08-26T00:00:00.000Z'),
  };
}

/** Все идентификаторы действий из всех клавиатур продукта. */
function everyCallbackData(): { where: string; data: string }[] {
  const found: { where: string; data: string }[] = [];

  const fromKeyboard = (where: string, keyboard: InlineKeyboard): void => {
    for (const row of keyboard.inline_keyboard) {
      // Типы grammY уже обещают строку у кнопок с действием: лишняя
      // проверка на undefined только сбивает с толку.
      for (const button of row) {
        if ('callback_data' in button) found.push({ where, data: button.callback_data });
      }
    }
  };

  // Первый экран (§13.1).
  found.push({ where: 'start', data: 'start:voice' }, { where: 'start', data: 'start:text' });

  // Приватность (§16).
  for (const data of [DELETE_STEP_ONE, DELETE_STEP_TWO, DELETE_CANCEL]) {
    found.push({ where: 'privacy', data });
  }

  // Онбординг (§12.2): все шаги, список городов, выбор сфер.
  for (const step of Object.values(STEP)) {
    const question = questionFor(step, { texts: defaultTexts, name: 'Аня' });
    for (const button of question?.rows.flat() ?? []) {
      found.push({ where: `onboarding:${String(step)}`, data: button.action });
    }
  }
  for (const button of timezoneQuestion(defaultTexts).rows.flat()) {
    found.push({ where: 'onboarding:timezones', data: button.action });
  }
  for (const button of topicRows(defaultTexts, ['семья']).flat()) {
    found.push({ where: 'onboarding:topics', data: button.action });
  }
  for (const data of Object.values(ONBOARDING)) {
    found.push({ where: 'onboarding:action', data });
  }

  // Ответ на выгрузку (§13.2).
  for (const button of buildReply({
    texts: defaultTexts,
    acknowledgement: 'Я тебя услышала.',
    actions: [LONG_TEXT],
    hidden: 3,
    tired: false,
  }).buttons) {
    found.push({ where: 'answer', data: button.action });
  }

  // Меню (§12.1) и карточка (§12.2).
  for (const data of Object.values(MENU_ACTION)) {
    found.push({ where: 'menu:action', data });
  }
  found.push({
    where: 'menu:topic',
    data: `${MENU_ACTION.topicPrefix}${toShortId(randomUUID())}`,
  });

  fromKeyboard('card', cardKeyboard(itemFixture(), defaultTexts, MENU_ACTION.root));

  return found;
}

describe('предел Telegram на callback_data', () => {
  it('ни одна кнопка проекта не превышает 64 байта', () => {
    for (const { where, data } of everyCallbackData()) {
      expect(callbackDataSize(data), `${where}: «${data}»`).toBeLessThanOrEqual(
        CALLBACK_DATA_LIMIT,
      );
    }
  });

  it('длинное название темы и длинный текст дела ничего не ломают', () => {
    // Именно на этом и попадаются: пример из трёх слов проходит, а живая
    // речь на минуту даёт заголовок в сотню знаков.
    const card = cardKeyboard(itemFixture(), defaultTexts, MENU_ACTION.root);

    for (const row of card.inline_keyboard) {
      for (const button of row) {
        if ('callback_data' in button) {
          expect(callbackDataSize(button.callback_data)).toBeLessThanOrEqual(CALLBACK_DATA_LIMIT);
        }
      }
    }
  });

  it('проверка ловит перебор, а не пропускает его', () => {
    // Страж, который врёт, хуже отсутствующего. Убедимся, что предел
    // действительно проверяется: заведомо длинная строка обязана упасть.
    const tooLong = `menu:t:${'я'.repeat(40)}`;

    expect(callbackDataSize(tooLong)).toBeGreaterThan(CALLBACK_DATA_LIMIT);
  });

  it('собрано не пусто: проверка правда что-то проверяет', () => {
    // Если сборщик клавиатур однажды вернёт пустой список, тест выше
    // станет зелёным и бесполезным.
    expect(everyCallbackData().length).toBeGreaterThan(30);
  });
});

describe('идентификаторы действий не пересекаются', () => {
  it('ни одно действие не является началом другого с тем же смыслом', () => {
    // Обработчики ловят по префиксу. Если одно действие — начало другого,
    // нажатие уйдёт не туда, и заметить это можно только руками.
    const prefixes = [
      MENU_ACTION.topicPrefix,
      ONBOARDING.timezonePrefix,
      ONBOARDING.morningPrefix,
      ONBOARDING.eveningPrefix,
      ONBOARDING.topicPrefix,
    ];

    const exact = [
      MENU_ACTION.root,
      MENU_ACTION.all,
      MENU_ACTION.today,
      MENU_ACTION.help,
      ONBOARDING.nameYes,
      ONBOARDING.nameLater,
      ONBOARDING.timezoneMoscow,
      ONBOARDING.timezoneOther,
      ONBOARDING.topicsDone,
      DELETE_STEP_ONE,
      DELETE_STEP_TWO,
      DELETE_CANCEL,
    ];

    for (const prefix of prefixes) {
      for (const action of exact) {
        // Единственное законное исключение — «не надо вечером»: он
        // намеренно начинается с префикса времени, и обработчик времени
        // отличает его проверкой формата.
        if (action === ONBOARDING.eveningOff) continue;
        expect(action.startsWith(prefix), `${action} начинается с ${prefix}`).toBe(false);
      }
    }
  });
});
