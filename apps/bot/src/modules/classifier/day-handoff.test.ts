import { describe, expect, it } from 'vitest';

import type { ClassifiedItems } from '../ai/schemas/classifier.js';
import { handOffTrailingDay } from './day-handoff.js';

type RawItem = ClassifiedItems['items'][number];

const raw = (
  text: string,
  day?: { readonly deadline: string; readonly deadlineText: string },
): RawItem => ({
  text,
  type: 'TASK',
  priority: 'SOON',
  topic: 'личное',
  isProject: false,
  deadline: day?.deadline ?? '',
  deadlineAccuracy: day === undefined ? 'none' : 'day',
  deadlineText: day?.deadlineText ?? '',
  recurrenceKind: 'none',
  recurrenceInterval: 0,
  recurrenceText: '',
});

const texts = (items: readonly RawItem[]): readonly string[] => items.map((item) => item.text);

/**
 * Стенд 27.09.2026, voice-27-08: «…и позвонить в банк по кредиту в
 * пятницу в субботу. День рождения у Иры, подарок еще не купила.» Модель
 * отдала банку «в пятницу **или** в субботу» — «или» она придумала, — и
 * подарок остался без срока. Ответ модели — из записи стенда.
 */
const SPEECH =
  'Так значит, в понедельник отвести Артема к логопеду в 4 часа. Потом купить продукты на неделю и заехать в аптеку за витаминами. В среду у меня. Отчет квартальный надо сдать до обеда, кстати, и позвонить в банк по кредиту в пятницу в субботу. День рождения у Иры, подарок еще не купила.';

const BANK = 'Позвонить в банк по кредиту в пятницу или в субботу';
const GIFT = 'День рождения у Иры, подарок ещё не купила';

const RECORDED: readonly RawItem[] = [
  raw('В понедельник отвести Артёма к логопеду в 4 часа', {
    deadline: '2026-09-28',
    deadlineText: 'в понедельник',
  }),
  raw('Купить продукты на неделю и заехать в аптеку за витаминами'),
  raw('В среду сдать квартальный отчёт до обеда', {
    deadline: '2026-09-30',
    deadlineText: 'в среду',
  }),
  raw(BANK, { deadline: '2026-10-01', deadlineText: 'в пятницу или в субботу' }),
  raw(GIFT),
];

describe('день в конце предложения — следующему делу (стенд 27.09.2026, voice-27-08)', () => {
  it('«в пятницу в субботу. День рождения у Иры…»: суббота — подарку, банку — пятница без придуманного «или»', () => {
    const result = handOffTrailingDay(RECORDED, texts(RECORDED), SPEECH);

    const bank = result.items[3];
    expect(bank?.text).toBe('Позвонить в банк по кредиту в пятницу');
    expect(bank?.deadlineText).toBe('в пятницу');
    expect(result.said?.[3]).toBe('Позвонить в банк по кредиту в пятницу');

    const gift = result.items[4];
    expect(gift?.text).toBe(GIFT);
    expect(gift?.deadlineText).toBe('в субботу');
    expect(gift?.deadlineAccuracy).toBe('day');
    expect(gift?.deadline).toBe('2026-10-01');

    // Остальное не тронуто.
    expect(result.items.slice(0, 3)).toEqual(RECORDED.slice(0, 3));
    expect(result.moved).toBe(1);
  });
});

describe('где правило молчит', () => {
  it('«или» сказал сам человек — выбор его, ничего не отдаётся', () => {
    const speech = SPEECH.replace('в пятницу в субботу', 'в пятницу или в субботу');

    const result = handOffTrailingDay(RECORDED, texts(RECORDED), speech);

    expect(result.items).toEqual(RECORDED);
    expect(result.moved).toBe(0);
  });

  it('в следующем предложении свой день — второй день туда не идёт', () => {
    const speech = SPEECH.replace(
      'День рождения у Иры, подарок еще не купила.',
      'В воскресенье день рождения у Иры, подарок еще не купила.',
    );

    const result = handOffTrailingDay(RECORDED, texts(RECORDED), speech);

    expect(result.items).toEqual(RECORDED);
  });

  it('у следующего дела уже есть срок — не перебиваем', () => {
    const items = RECORDED.map((item) =>
      item.text === GIFT
        ? raw(GIFT, { deadline: '2026-10-04', deadlineText: 'в воскресенье' })
        : item,
    );

    const result = handOffTrailingDay(items, texts(items), SPEECH);

    expect(result.items).toEqual(items);
  });

  it('после второго дня нет точки — это не конец предложения', () => {
    const speech = SPEECH.replace(
      'в пятницу в субботу. День рождения у Иры',
      'в пятницу в субботу и день рождения у Иры',
    );

    const result = handOffTrailingDay(RECORDED, texts(RECORDED), speech);

    expect(result.items).toEqual(RECORDED);
  });

  it('в следующем предложении два дела без срока — кому день, не угадываем', () => {
    const speech = SPEECH.replace(
      'День рождения у Иры, подарок еще не купила.',
      'День рождения у Иры, подарок еще не купила и торт заказать.',
    );
    const items = [...RECORDED, raw('Торт заказать')];

    const result = handOffTrailingDay(items, texts(items), speech);

    expect(result.items).toEqual(items);
  });

  it('два дня кончают чужое предложение, а не предложение этого дела — не трогаем', () => {
    const speech =
      'Позвонить в банк по кредиту. Сходить на рынок в пятницу в субботу. День рождения у Иры, подарок еще не купила.';
    const items = [
      raw('Позвонить в банк по кредиту', {
        deadline: '2026-10-01',
        deadlineText: 'в пятницу или в субботу',
      }),
      raw(GIFT),
    ];

    const result = handOffTrailingDay(items, texts(items), speech);

    expect(result.items).toEqual(items);
  });

  it('речи нет — ничего не трогает', () => {
    const result = handOffTrailingDay(RECORDED, texts(RECORDED), undefined);

    expect(result.items).toEqual(RECORDED);
  });
});
