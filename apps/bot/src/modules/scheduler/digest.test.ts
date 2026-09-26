import { describe, expect, it } from 'vitest';

import type { Item } from '../../db/schema.js';
import { defaultTexts } from '../../texts/index.js';
import { forbiddenPhraseIn } from '../../texts/rules.js';
import {
  deadlineText,
  eveningText,
  hourText,
  MORNING_ACTIONS_LIMIT,
  morningText,
  projectText,
} from './digest.js';

/**
 * Сводки (задача 3.15).
 *
 * План просит «проверку текстов на запрещённые формулировки». Список
 * запрещённого здесь тот же, которым проверяется ответ модели: правило
 * §13.8 одно на продукт, и раздваивать его нельзя.
 *
 * Отдельно проверяется §13.6 — просроченное не подаётся как провал, дни
 * не считаются. Эти реплики приходят без спроса, и упрёк в них стоит
 * дороже, чем в ответе на вопрос.
 */

const item = (text: string, deadlineAt: Date | null = null): Item =>
  ({
    text,
    deadlineAt,
    deadlineAccuracy: deadlineAt === null ? null : 'day',
    deadlineTime: null,
  }) as Item;

/** Полдень 5 сентября 2026 по Москве — «сегодня» для всех проверок ниже. */
const NOW = new Date('2026-09-05T09:00:00.000Z');
const MOSCOW = 'Europe/Moscow';
const TODAY = { now: NOW, timeZone: MOSCOW };

/** Полночь того же дня в поясе человека — так срок и хранится. */
const todayAt = new Date('2026-09-04T21:00:00.000Z');

/** Имена параметров функции — по ним видно, что ей вообще можно скормить. */
function paramsOf(fn: (...args: never[]) => unknown): string[] {
  const inside = /\(([^)]*)\)/u.exec(fn.toString())?.[1] ?? '';

  return inside
    .split(',')
    .map((one) => one.trim().split(/[:=?]/u)[0]?.trim() ?? '')
    .filter((one) => one.length > 0);
}

/** Вечер как вызывает планировщик: закрытых столько-то, осталось то-то. */
const evening = (
  closed: number,
  left: readonly Item[] = [],
  extra: { readonly suggestion?: string; readonly mayDump?: boolean; readonly now?: Date } = {},
): string =>
  eveningText(defaultTexts, {
    closed,
    left,
    day: { now: extra.now ?? NOW, timeZone: MOSCOW },
    ...(extra.suggestion === undefined ? {} : { suggestion: extra.suggestion }),
    ...(extra.mayDump === undefined ? {} : { mayDump: extra.mayDump }),
  });

const all = (): string[] => [
  morningText(defaultTexts, [], TODAY),
  morningText(defaultTexts, [item('Позвонить в садик'), item('Забрать посылку')], TODAY),
  evening(0),
  evening(3),
  evening(1, [item('Забрать посылку')]),
  deadlineText(defaultTexts, { item: item('Оплатить квитанцию'), onDay: true }),
  deadlineText(defaultTexts, { item: item('Оплатить квитанцию'), onDay: false }),
  projectText(defaultTexts, { title: 'День рождения сына', step: 'выбрать кафе' }),
];

/**
 * Приветствие утром и вечером (ТЗ проджекта 17.09.2026, 2.9): одна
 * короткая человеческая строка, после неё сразу полезная часть; 3–4
 * заранее заданных варианта по кругу, не модель. «Остальное я помню» —
 * фирменная формула.
 */
const hellos = Object.values(defaultTexts.reminders.morningHello);
const intros = Object.values(defaultTexts.reminders.morningIntro);
const dayAfter = (days: number): { readonly now: Date; readonly timeZone: string } => ({
  now: new Date(NOW.getTime() + days * 24 * 60 * 60_000),
  timeZone: MOSCOW,
});
const three = [item('Позвонить в садик'), item('Забрать посылку'), item('Купить хлеб')];

describe('утро', () => {
  it('обычное утро: приветствие с переходом к сути одной строкой, потом дела — без второй шапки', () => {
    const lines = morningText(defaultTexts, three, TODAY).split('\n');

    const first = lines[0] ?? '';
    expect(hellos.some((hello) => first.startsWith(hello))).toBe(true);
    expect(intros.some((intro) => first.endsWith(intro))).toBe(true);
    expect(lines.slice(1)).toEqual([
      defaultTexts.reminders.line('Позвонить в садик'),
      defaultTexts.reminders.line('Забрать посылку'),
      defaultTexts.reminders.line('Купить хлеб'),
    ]);
  });

  it('приветствие меняется по кругу день за днём, а не одно и то же дословно', () => {
    const firsts = [0, 1, 2, 3].map(
      (days) => morningText(defaultTexts, three, dayAfter(days)).split('\n')[0],
    );

    expect(new Set(firsts.slice(0, 3)).size).toBe(3);
    expect(firsts[3]).toBe(firsts[0]);
  });

  it('лёгкий день: приветствие, «На сегодня немного:», дела', () => {
    const lines = morningText(defaultTexts, [item('Позвонить в садик')], TODAY).split('\n');

    expect(hellos).toContain(lines[0]);
    expect(lines[1]).toBe(defaultTexts.reminders.morningLight);
    expect(lines[2]).toBe(defaultTexts.reminders.line('Позвонить в садик'));
  });

  it('без дел — приветствие, «ничего срочного нет» и куда скидывать: три строки', () => {
    const lines = morningText(defaultTexts, [], TODAY).split('\n');

    expect(hellos).toContain(lines[0]);
    expect(lines.slice(1)).toEqual([
      defaultTexts.reminders.morningEmpty,
      defaultTexts.reminders.morningEmptyInvite,
    ]);
  });

  it('без доступа к разборам приглашение «скидывай сюда» заменяется словами об оплате', () => {
    const empty = morningText(defaultTexts, [], TODAY, false);
    expect(empty).toContain(defaultTexts.reminders.needsPay);
    expect(empty).not.toContain(defaultTexts.reminders.morningEmptyInvite);

    const busy = morningText(defaultTexts, three, TODAY, false);
    expect(busy.split('\n').at(-1)).toBe(defaultTexts.reminders.needsPay);
  });

  it('с делами — приглашение и список', () => {
    const text = morningText(defaultTexts, [item('Позвонить в садик')], TODAY);

    expect(text).toContain('Позвонить в садик');
  });

  it('список урезан до лимита выдачи', () => {
    // Иначе утро приносит стену дел — ровно ту гору, ради которой
    // человек и пришёл к продукту (§13.2).
    const many = Array.from({ length: 10 }, (_value, index) => item(`Дело ${String(index)}`));
    const text = morningText(defaultTexts, many, TODAY);

    expect(text).toContain('Дело 0');
    expect(text).not.toContain(`Дело ${String(MORNING_ACTIONS_LIMIT)}`);
  });

  it('вчерашнее «завтра» под шапкой «на сегодня» срезается', () => {
    /**
     * **Задача 3.78, найдено прогоном выдачи на боевых записях.** Сводка
     * проджекта читалась «На сегодня: — Позвонить стоматологу завтра»:
     * шапка про сегодня, строка про завтра. Он сказал «завтра» вчера,
     * срок встал на сегодня, а слова остались вчерашние.
     */
    const text = morningText(defaultTexts, [item('Позвонить стоматологу завтра', todayAt)], TODAY);

    expect(text).toContain('Позвонить стоматологу');
    expect(text).not.toContain('завтра');
  });

  it('после срезанной даты заголовок начинается с заглавной', () => {
    // «Завтра надо купить корм» → «надо купить корм»: строчная буква в
    // списке рядом с «Вынести мусор» читается как небрежность.
    const text = morningText(defaultTexts, [item('Завтра надо купить корм', todayAt)], TODAY);

    expect(text).toContain('Надо купить корм');
  });

  it('у дела без срока слова человека не трогает', () => {
    /**
     * «Завтра» в тексте без срока — единственное, что у человека есть
     * про день: срок либо не назывался, либо не прошёл проверку §2.7.
     * Срезать это значило бы спрятать то, чего больше нигде нет.
     */
    const text = morningText(defaultTexts, [item('Позвонить стоматологу завтра')], TODAY);

    expect(text).toContain('Позвонить стоматологу завтра');
  });

  it('у дела с чужим днём слова человека не трогает', () => {
    // Срок на послезавтра под шапкой «на сегодня» — случай не наш:
    // такие дела в список не попадают вовсе (задача 3.71).
    const later = new Date('2026-09-06T21:00:00.000Z');
    const text = morningText(defaultTexts, [item('Забрать посылку в понедельник', later)], TODAY);

    expect(text).toContain('Забрать посылку в понедельник');
  });

  it('не считает, сколько всего осталось', () => {
    // «И ещё 47» утром — это счёт несделанного, запрещённый §13.6.
    const many = Array.from({ length: 50 }, (_value, index) => item(`Дело ${String(index)}`));

    expect(morningText(defaultTexts, many, TODAY)).not.toMatch(/\d{2}/u);
  });
});

describe('вечер', () => {
  const eveningHellos = Object.values(defaultTexts.reminders.eveningHello);

  it('всё закрыто: «На сегодня всё 🤍», закрытое числом, «Остальное я помню.»', () => {
    expect(evening(3).split('\n')).toEqual([
      defaultTexts.reminders.eveningAllDone,
      defaultTexts.reminders.eveningClosed(3),
      defaultTexts.reminders.remembered,
    ]);
  });

  it('что-то осталось: приветствие, что осталось с сегодня и что с этим можно сделать', () => {
    const lines = evening(1, [item('Забрать посылку'), item('Купить хлеб')]).split('\n');

    expect(eveningHellos).toContain(lines[0]);
    expect(lines.slice(1)).toEqual([
      defaultTexts.reminders.eveningClosed(1),
      defaultTexts.reminders.eveningLeft,
      defaultTexts.reminders.line('Забрать посылку'),
      defaultTexts.reminders.line('Купить хлеб'),
      defaultTexts.reminders.eveningLeftHint,
    ]);
  });

  it('вечернее приветствие тоже идёт по кругу', () => {
    const firsts = [0, 1, 2, 3].map(
      (days) =>
        evening(0, [item('Купить хлеб')], {
          now: new Date(NOW.getTime() + days * 24 * 60 * 60_000),
        }).split('\n')[0],
    );

    expect(new Set(firsts.slice(0, 3)).size).toBe(3);
    expect(firsts[3]).toBe(firsts[0]);
  });

  it('пустой день не получает упрёка и не получает нуля', () => {
    const text = evening(0);

    expect(text).not.toContain('0');
    expect(text).not.toMatch(/не сделал|ничего не|успел|жаль|всего лишь/iu);
    expect(text.split('\n')).toEqual([
      defaultTexts.reminders.eveningAllDone,
      defaultTexts.reminders.remembered,
    ]);
  });

  it('вечер — точка, а не приглашение: выгружать не зовёт', () => {
    expect(evening(2)).not.toMatch(/накопи|наговори|скажи/iu);
  });

  it('без доступа к разборам — слова об оплате последней строкой', () => {
    expect(evening(0, [], { mayDump: false }).split('\n').at(-1)).toBe(
      defaultTexts.reminders.needsPay,
    );
  });
});

describe('предложение запомнить регулярность в сводке (3.17а)', () => {
  const noticed = defaultTexts.resolver.noticed(
    'Оплатить садик',
    '6 мая, 5 июня, 6 июля и 5 августа',
    'каждый месяц',
  );

  it('едет внутри вечерней сводки, а не отдельным сообщением', () => {
    const text = evening(2, [], { suggestion: noticed });

    expect(text).toContain(defaultTexts.reminders.eveningAllDone);
    expect(text).toContain('Оплатить садик');
  });

  it('занимает единственный вопрос сводки', () => {
    // §13.9: один вопрос на реплику. Итог выше — не вопрос.
    const text = evening(2, [], { suggestion: noticed });

    expect((text.match(/\?/gu) ?? []).length).toBe(1);
  });

  it('без предложения сводка остаётся без вопросов вовсе', () => {
    expect((evening(2).match(/\?/gu) ?? []).length).toBe(0);
  });

  it('пустая строка предложением не считается', () => {
    expect(evening(2, [], { suggestion: '' })).toBe(evening(2));
  });

  it('предложение отделено пустой строкой от итога', () => {
    // Иначе вопрос читается как продолжение итога.
    const lines = evening(2, [], { suggestion: noticed }).split('\n');
    expect(lines.at(-2)).toBe('');
    expect(lines.at(-1)).toBe(noticed);
  });

  it('и с предложением тон остаётся в рамках §13.8', () => {
    expect(forbiddenPhraseIn(evening(0, [], { suggestion: noticed }))).toBeUndefined();
  });
});

describe('§13.6: просроченное не провал', () => {
  it('ни одна реплика не говорит о просроченном', () => {
    for (const text of all()) {
      expect(text).not.toMatch(/просроч|опозда|пропусти|горит|давно/iu);
    }
  });

  it('ни одна реплика не считает дни', () => {
    for (const text of all()) {
      expect(text).not.toMatch(/дн(я|ей) назад|уже \d|\d+ (дн|недел)/iu);
    }
  });

  it('сборщику неоткуда узнать число просроченных', () => {
    /**
     * Не проверка формулировки, а проверка устройства: в сигнатурах
     * `morningText` и `eveningText` нет параметра, куда просроченное
     * можно было бы подставить. Значит, оно не появится и после правки
     * текстов чужой рукой.
     *
     * Имена, а не количество: считать параметры бесполезно, стоит кому-то
     * добавить `overdueCount` вместо чего-нибудь. Список имён падает
     * ровно на той правке, ради которой этот тест написан.
     *
     * `day` появился в задаче 3.78 и несёт ровно две вещи — «сейчас» и
     * пояс, — что и написано в его типе. Подставить в него просроченное
     * нельзя, а новое имя в этом списке потребует объяснения здесь.
     *
     * `mayDump` добавлен ревизией четвёртого этапа: он булев и отвечает
     * на один вопрос — пустит ли бот новую выгрузку. Приглашение
     * выгружать уходило каждое утро и тому, кому бот в ответ откажет;
     * просроченное в булев не подставить.
     *
     * `extra` добавлен запросом на изменение №4 (13.09.2026): в нём разбор
     * вчерашнего — **сами дела**, чтобы назвать их, — и одно из «Позже».
     * Число просроченных из него взять можно, но сказать его нечем: шапка
     * разбора — постоянная строка без числа, а номера строк — адреса для
     * кнопок, не счёт. Проверка ниже держит это на самих текстах.
     */
    expect(paramsOf(morningText)).toEqual(['texts', 'actions', 'day', 'mayDump', 'extra']);
    // Вечеру передаются закрытое числом и оставшееся списком — ни числа
    // просроченных, ни пропущенных дней среди параметров нет.
    expect(paramsOf(eveningText)).toEqual(['texts', 'params']);
    expect(evening(2, [item('Купить хлеб')])).not.toMatch(/просроч|пропущ|дней/iu);
  });

  it('шапки разбора вчерашнего — без числа (запрос №4, §13)', () => {
    // «Вчера не дошли руки до: …», а не «осталось три дела»: заказчица
    // выбрала вариант без счётчика (ответ от 12.09.2026, п. 2).
    for (const header of [
      defaultTexts.review.headerYesterday,
      defaultTexts.review.headerEarlier,
      defaultTexts.review.offer('дело'),
    ]) {
      expect(header).not.toMatch(/\d/u);
    }
  });

  it('предложение из «Позже» — её словами (правка заказчицы 14.09.2026, п. 1.4)', () => {
    // «Можно ещё вернуться к…» — так она это назвала; прежняя строка
    // «Если захочется — из отложенного» была нашей. «…, если захочется»
    // — из ТЗ проджекта 17.09.2026 (2.9, лёгкий день).
    expect(defaultTexts.review.offer('Разобрать балкон')).toBe(
      'Можно ещё вернуться к «Разобрать балкон», если захочется.',
    );
  });
});

describe('§13.8: запрещённые формулировки', () => {
  it.each(all().map((text, index) => [index, text] as const))(
    'реплика %i чиста',
    (_index, text) => {
      expect(forbiddenPhraseIn(text)).toBeUndefined();
    },
  );
});

describe('§13.9: один вопрос на реплику', () => {
  it.each(all().map((text, index) => [index, text] as const))(
    'в реплике %i не больше одного вопроса',
    (_index, text) => {
      expect((text.match(/\?/gu) ?? []).length).toBeLessThanOrEqual(1);
    },
  );
});

describe('сроки и проект', () => {
  it('накануне и в день срока — разные реплики', () => {
    const eve = deadlineText(defaultTexts, { item: item('Квитанция'), onDay: false });
    const day = deadlineText(defaultTexts, { item: item('Квитанция'), onDay: true });

    expect(eve).not.toBe(day);
    expect(eve).toMatch(/завтра/iu);
    expect(day).toMatch(/сегодня/iu);
  });

  it('после карточки первого утра — без второго приветствия: сразу дела (проверка Никиты 26.09.2026, 09:00)', () => {
    // Карточка: «Доброе утро ☀️ Вот что сегодня важно:» — следом было «Утро
    // доброе. На сегодня немного:» — два приветствия и две шапки подряд.
    const text = morningText(
      defaultTexts,
      [item('Купить кефир'), item('Позвонить маме')],
      TODAY,
      true,
      {
        afterCard: true,
      },
    );

    expect(text.split('\n')).toEqual(['— Купить кефир', '— Позвонить маме']);
    // Без карточки — как было: приветствие и шапка.
    const plain = morningText(defaultTexts, [item('Купить кефир')], TODAY).split('\n')[0] ?? '';
    expect(hellos.some((hello) => plain.startsWith(hello))).toBe(true);
  });

  describe('час срока назван (проверка Никиты 25.09.2026, 21:00)', () => {
    // «Завтра срок: Забрать ребёнка из школы» — без 16:00, хотя час известен
    // и в списках стоит «· 16:00». Утром в «Сегодня срок» и в утреннем — так же.
    const timed = (text: string, deadlineAt: Date, minutes: number): Item => ({
      ...item(text, deadlineAt),
      deadlineTime: minutes,
    });

    it('«Завтра срок» и «Сегодня срок» — с часом из срока; старый час из названия срезан', () => {
      const child = timed('Забрать ребёнка из школы', todayAt, 16 * 60);
      expect(deadlineText(defaultTexts, { item: child, onDay: false })).toBe(
        'Завтра срок: Забрать ребёнка из школы · 16:00',
      );
      expect(deadlineText(defaultTexts, { item: child, onDay: true })).toBe(
        'Сегодня срок: Забрать ребёнка из школы · 16:00',
      );
      expect(
        deadlineText(defaultTexts, {
          item: timed('Позвонить маме в 9', todayAt, 21 * 60),
          onDay: false,
        }),
      ).toBe('Завтра срок: Позвонить маме · 21:00');
      // Без часа — как было.
      expect(
        deadlineText(defaultTexts, { item: item('Оплатить квитанцию', todayAt), onDay: false }),
      ).toBe('Завтра срок: Оплатить квитанцию');
    });

    it('утреннее и вечернее: у сегодняшнего дела — час из срока', () => {
      const child = timed('Забрать ребёнка из школы', todayAt, 16 * 60);
      const morning = morningText(defaultTexts, [child, item('Купить кефир')], TODAY);
      expect(morning).toContain('— Забрать ребёнка из школы · 16:00');
      expect(morning).toContain('— Купить кефир');
      expect(evening(0, [child])).toContain('— Забрать ребёнка из школы · 16:00');
    });

    it('напоминание о часе — с заглавной, даже если дело хранится строчным (живой прогон 26.09.2026)', () => {
      // «зайти в аптеку» сохранилось строчным до починки: «Через 30 минут,
      // в 19:00: зайти в аптеку.» — единственное место, где заглавной не было.
      expect(
        hourText(defaultTexts, { item: item('зайти в аптеку'), time: '19:00', leadMinutes: 30 }),
      ).toBe('Через 30 минут, в 19:00: Зайти в аптеку.');
      expect(
        hourText(defaultTexts, {
          item: item('Позвонить сестре в 3:10'),
          time: '03:45',
          leadMinutes: 0,
        }),
      ).toBe('Сейчас, в 03:45: Позвонить сестре.');
    });

    it('у дела без срока заголовок не трогается: «завтра» в нём — единственное про день', () => {
      expect(morningText(defaultTexts, [item('Купить хлеб завтра')], TODAY)).toContain(
        '— Купить хлеб завтра',
      );
    });
  });

  it('вопрос про проект называет и цель, и шаг', () => {
    const text = projectText(defaultTexts, { title: 'Ремонт', step: 'вызвать замерщика' });

    expect(text).toContain('Ремонт');
    expect(text).toContain('вызвать замерщика');
  });
});
