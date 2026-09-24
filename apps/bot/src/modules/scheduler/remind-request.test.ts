import { describe, expect, it } from 'vitest';

import { defaultTexts } from '../../texts/index.js';
import { asksToRemind, remindAnswer, type RemindItem } from './remind-request.js';

/**
 * «Напомнишь?» сразу после записи (живая проверка Никиты 24.09.2026,
 * 17:03). Бот только что записал «Поехать за ребёнком», человек спросил
 * «Напомнишь ?» — и получил обзор дня от модели, где открытые дела были
 * названы сделанными: «ты отвела сельди на автостанцию, забрала посылку».
 * Спрашивали про одно дело и про напоминание — ответ знает планировщик.
 */

const MOSCOW = 'Europe/Moscow';
/** 24.09.2026, 17:03 по Москве. */
const NOW = new Date('2026-09-24T14:03:00.000Z');
/** Начало 25.09 по Москве — так хранится срок «завтра». */
const TOMORROW = new Date('2026-09-24T21:00:00.000Z');

const settings = {
  morningTime: '08:00',
  eveningTime: '21:00',
  notificationsOn: true,
  eveningOn: true,
  quietHoursOn: true,
  quietFrom: '22:00',
  quietTo: '08:00',
};

function item(overrides: Partial<RemindItem> = {}): RemindItem {
  return {
    id: 'item-1',
    text: 'Поехать за ребёнком',
    type: 'TASK',
    deadlineAt: TOMORROW,
    deadlineAccuracy: 'day',
    deadlineTime: null,
    ...overrides,
  };
}

function answer(one: RemindItem, now = NOW, own = settings): string {
  return remindAnswer({ item: one, settings: own, now, timeZone: MOSCOW, texts: defaultTexts });
}

describe('«Напомнишь?» узнаётся целой короткой фразой', () => {
  it.each([
    'Напомнишь ?',
    'напомнишь?',
    'Ты напомнишь?',
    'А напомнишь?',
    'Напомнишь мне?',
    'Ты же напомнишь?',
    'А ты мне напомнишь?',
    'Не забудешь напомнить?',
    'Напомнишь об этом?',
    'Напомнишь про это?',
    'Напомни мне.',
  ])('«%s»', (text) => {
    expect(asksToRemind(text)).toBe(true);
  });

  it.each([
    // §13.4: вопрос о деле — это к ответам, не к напоминанию.
    'Напомни, что я хотела сделать с альбомом',
    // Своё время — это правка: её разбирает конвейер.
    'напомнишь что э поехать за ребенком надо в 4 часа',
    'Напомни завтра позвонить маме',
    'Напоминание',
    'Купить хлеб',
    '',
  ])('«%s» — не она', (text) => {
    expect(asksToRemind(text)).toBe(false);
  });
});

describe('ответ — по плану планировщика, а не словами модели', () => {
  it('живой случай: срок завтра без часа — накануне вечером и утром в день, и приглашение назвать час', () => {
    expect(answer(item())).toBe(
      'Да, напомню про «Поехать за ребёнком» сегодня в 21:00 и завтра в 08:00. Если нужно к определённому часу — скажи время.',
    );
  });

  it('с часом — ещё и за полчаса до него; тот же день второй раз не называется', () => {
    expect(answer(item({ deadlineTime: 16 * 60 }))).toBe(
      'Да, напомню про «Поехать за ребёнком» сегодня в 21:00, завтра в 08:00 и в 15:30.',
    );
  });

  it('срок через четыре дня — всё равно называет (план не ограничен сутками вперёд)', () => {
    const later = new Date('2026-09-27T21:00:00.000Z'); // 28.09
    expect(answer(item({ deadlineAt: later }))).toBe(
      'Да, напомню про «Поехать за ребёнком» 27.09 в 21:00 и 28.09 в 08:00. Если нужно к определённому часу — скажи время.',
    );
  });

  it('вечер накануне уже прошёл — только оставшееся', () => {
    const lateEvening = new Date('2026-09-24T18:30:00.000Z'); // 21:30
    expect(answer(item({ deadlineTime: 16 * 60 }), lateEvening)).toBe(
      'Да, напомню про «Поехать за ребёнком» завтра в 08:00 и в 15:30.',
    );
  });

  it('без срока — напоминать не к чему, и что сделать', () => {
    expect(answer(item({ deadlineAt: null, deadlineAccuracy: null }))).toBe(
      defaultTexts.reminders.remindNoDeadline('Поехать за ребёнком'),
    );
  });

  it('срок прошёл — напоминать уже нечего', () => {
    const past = new Date('2026-09-21T21:00:00.000Z'); // 22.09
    expect(answer(item({ deadlineAt: past }))).toBe(
      defaultTexts.reminders.remindNothingAhead('Поехать за ребёнком'),
    );
  });

  it('напоминания выключены — так и сказано', () => {
    expect(answer(item(), NOW, { ...settings, notificationsOn: false })).toBe(
      defaultTexts.reminders.remindOff,
    );
  });

  it('сведение не напоминается — как у планировщика', () => {
    expect(answer(item({ type: 'INFO', text: 'У мамы день рождения' }))).toBe(
      defaultTexts.reminders.remindNothingAhead('У мамы день рождения'),
    );
  });
});
