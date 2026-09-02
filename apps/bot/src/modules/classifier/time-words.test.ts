import { describe, expect, it } from 'vitest';

import { resolveDeadline } from './dates.js';
import { hasTimeWord, timeQuoteInSpeech, weekdayIn } from './time-words.js';

/**
 * Проверка сроков словами человека (задача 2.7).
 *
 * Замер контрольного набора 27.08.2026 показал десять выдуманных сроков
 * из сорока трёх дел. Промпт уже просил «не выдумывай сроки» — просьба не
 * помогла, поэтому правило переехало в код.
 *
 * Цена ошибки не в самом сроке, а в выдаче: фильтр ставит дела «на
 * сегодня» впереди всех, и мелочь с придуманной датой вытесняет важное
 * дело без срока. На живой выгрузке в ответе оказались пуфики, капсулы и
 * кофе, а ортопед со стоматологом — нет.
 */

/** Четверг, 27 августа 2026, полдень по Москве. */
const NOW = new Date('2026-08-27T09:00:00.000Z');
const ZONE = 'Europe/Moscow';

describe('слова о времени', () => {
  const withTime = [
    'записаться к врачу в четверг',
    'купить продукты сегодня',
    'сдать отчёт до конца недели',
    'поездка на 5 7 сентября',
    'позвонить через два дня',
    'начну ходить с 15 сентября',
  ];

  for (const text of withTime) {
    it(`видит время в «${text}»`, () => {
      expect(hasTimeWord(text)).toBe(true);
    });
  }

  const withoutTime = [
    // Событие подразумевает дату, но не называет её. Для проверки это то
    // же самое, что её нет: живая выгрузка показала, как модель выдумала
    // и годовщину, и день рождения.
    'поздравить с днём рождения',
    'спланировать годовщину родителей',
    'успеть законспектировать марафон',
    'купить пуфики',
    'записаться к ортопеду',
    'проверить список продуктов',
    'сделать маникюр',
    'почистить корзину',
    'сверить кассу',
  ];

  for (const text of withoutTime) {
    it(`не видит времени в «${text}»`, () => {
      expect(hasTimeWord(text)).toBe(false);
    });
  }

  it('«ё» и регистр не мешают', () => {
    expect(hasTimeWord('В ЧЕТВЕРГ')).toBe(true);
    expect(hasTimeWord('сдать в третьем квартале')).toBe(true);
  });
});

describe('день недели в тексте', () => {
  it('узнаёт названный день', () => {
    expect(weekdayIn('записаться к стоматологу в четверг')).toBe(4);
    expect(weekdayIn('в воскресенье к маме')).toBe(0);
  });

  it('два дня — не выбор за человека', () => {
    // «Каждый вторник и четверг» — составное; выбрать один за него
    // значило бы напоминать не в тот день.
    expect(weekdayIn('каждый вторник и четверг возить к репетитору')).toBeUndefined();
  });

  it('нет дня — нет и ответа', () => {
    expect(weekdayIn('купить пуфики')).toBeUndefined();
  });
});

describe('срок принимается только со словами человека', () => {
  it('срок без слов о времени отбрасывается', () => {
    // Ровно случай живой выгрузки: «купить пуфики» с датой на сегодня.
    const outcome = resolveDeadline(
      { deadline: '2026-08-27', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'купить пуфики' },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('не назван');
  });

  it('проверяется только текст самого дела, а не вся выгрузка', () => {
    // Сначала проверялась и выгрузка целиком — и это оказалось дырой:
    // одного «успеть» или одной цифры «1968 года» в потоке хватало,
    // чтобы пропустить выдуманные сроки у двадцати других дел. Замер
    // поймал сразу: семь придуманных сроков вернулись.
    const outcome = resolveDeadline(
      { deadline: '2026-09-05', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'запланировать поездку' },
    );

    expect(outcome.ok).toBe(false);
  });

  it('дата в тексте дела срок сохраняет', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-09-05', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'запланировать поездку на 5 7 сентября' },
    );

    expect(outcome.ok).toBe(true);
  });

  it('без слов человека проверка не работает и срок принимается', () => {
    // Обратная совместимость: старые вызовы без `said` ведут себя как
    // раньше. Молча менять поведение вызывающего кода нельзя.
    const outcome = resolveDeadline(
      { deadline: '2026-08-28', accuracy: 'day' },
      { now: NOW, timeZone: ZONE },
    );

    expect(outcome.ok).toBe(true);
  });
});

describe('день недели считает код, а не модель', () => {
  it('неверный день недели пересчитывается', () => {
    // Замер 27.08.2026: на «в четверг» модель вернула среду 2 сентября.
    const outcome = resolveDeadline(
      { deadline: '2026-09-02', accuracy: 'day' },
      {
        now: NOW,
        timeZone: ZONE,
        said: 'записаться к стоматологу в четверг',
      },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      // Ближайший четверг от четверга — это сегодня: человек говорит о
      // ближайшем, иначе сказал бы «в следующий».
      expect(outcome.deadline.at.toISOString().slice(0, 10)).toBe('2026-08-26');
      expect(outcome.corrected).toBe('weekday');
    }
  });

  it('верный день недели не трогается', () => {
    // Пятница, 28 августа.
    const outcome = resolveDeadline(
      { deadline: '2026-08-28', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'сдать отчёт в пятницу' },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      expect(outcome.corrected).toBeUndefined();
      expect(outcome.deadline.at.toISOString().slice(0, 10)).toBe('2026-08-27');
    }
  });
});

describe('цитата о времени, подтверждённая речью (задача 3.37)', () => {
  const SPEECH =
    'так сегодня мне надо сходить в магазин купить продукты молоко хлеб яйца ' +
    'и ещё в четверг заехать к родителям завезти им вещи ' +
    'на выходных надо разобрать балкон и забрать посылку до 6 вечера';

  it('дословная цитата из речи признаётся', () => {
    expect(timeQuoteInSpeech('сегодня', SPEECH)).toBe(true);
    expect(timeQuoteInSpeech('в четверг', SPEECH)).toBe(true);
    expect(timeQuoteInSpeech('на выходных', SPEECH)).toBe(true);
    expect(timeQuoteInSpeech('до 6 вечера', SPEECH)).toBe(true);
  });

  it('цитаты, которой в речи нет, не признаёт', () => {
    // Ровно то, ради чего проверка и заведена: выдумать срок теперь
    // значит выдумать цитату, дословно присутствующую в речи.
    expect(timeQuoteInSpeech('в пятницу', SPEECH)).toBe(false);
    expect(timeQuoteInSpeech('на следующей неделе', SPEECH)).toBe(false);
    expect(timeQuoteInSpeech('завтра', SPEECH)).toBe(false);
  });

  it('пересказ вместо цитаты не проходит', () => {
    // Слова есть оба, но не подряд: «в четверг… завезти» — это пересказ.
    expect(timeQuoteInSpeech('в четверг завезти вещи', SPEECH)).toBe(false);
    expect(timeQuoteInSpeech('сегодня вечером', SPEECH)).toBe(false);
  });

  it('цифра сама по себе временем не считается', () => {
    // Цифра есть почти в любой речи: «5 заказов» — не срок. Иначе
    // проверку можно было бы обойти, процитировав любое число.
    expect(timeQuoteInSpeech('6', SPEECH)).toBe(false);
    expect(timeQuoteInSpeech('магазин', SPEECH)).toBe(false);
    expect(timeQuoteInSpeech('', SPEECH)).toBe(false);
  });

  it('цитата ищется по границам слов', () => {
    // «год» внутри «годовщины» — не слово о времени, а часть другого.
    expect(timeQuoteInSpeech('год', 'спланировать годовщину родителей')).toBe(false);
    expect(timeQuoteInSpeech('в мае', 'поехать в майские куда-нибудь')).toBe(false);
  });

  it('регистр, «ё» и знаки не мешают', () => {
    expect(timeQuoteInSpeech('В ЧЕТВЕРГ', SPEECH)).toBe(true);
    expect(timeQuoteInSpeech('в четверг,', SPEECH)).toBe(true);
    expect(timeQuoteInSpeech('на выходных!', 'на выходных разобрать балкон')).toBe(true);
  });
});

describe('цитата возвращает сроки, которые проверка теряла (задача 3.37)', () => {
  const SPEECH = 'сегодня мне надо сходить в магазин купить продукты и в четверг к родителям';

  it('слово о времени выброшено извлечением, но цитата его вернула', () => {
    // Живой журнал 02.09.2026: шесть таких сроков за сутки. Модель
    // называла день верно, а код его отбрасывал.
    const outcome = resolveDeadline(
      { deadline: '2026-08-27', accuracy: 'day' },
      {
        now: NOW,
        timeZone: ZONE,
        said: 'купить продукты',
        quoted: 'сегодня',
        spoken: SPEECH,
      },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      expect(outcome.deadline.at.toISOString()).toBe('2026-08-26T21:00:00.000Z');
    }
  });

  it('выдуманная цитата срок не спасает', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-08-28', accuracy: 'day' },
      {
        now: NOW,
        timeZone: ZONE,
        said: 'купить пуфики',
        quoted: 'завтра',
        spoken: SPEECH,
      },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('которой в речи нет');
  });

  it('без цитаты причина остаётся прежней', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-08-28', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'купить пуфики', quoted: '', spoken: SPEECH },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('человеком не назван');
  });

  it('без речи ветка цитаты не работает', () => {
    // Проверять цитату тогда нечем, и признавать её на слово нельзя.
    const outcome = resolveDeadline(
      { deadline: '2026-08-27', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'купить продукты', quoted: 'сегодня' },
    );

    expect(outcome.ok).toBe(false);
  });

  it('день недели из цитаты пересчитывает дату', () => {
    // Раньше день недели проверялся только по тексту дела — а человек
    // назвал его в речи, и проверять было нечем.
    const outcome = resolveDeadline(
      { deadline: '2026-09-02', accuracy: 'day' },
      {
        now: NOW,
        timeZone: ZONE,
        said: 'заехать к родителям',
        quoted: 'в четверг',
        spoken: SPEECH,
      },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      expect(outcome.corrected).toBe('weekday');
      // Ближайший четверг от четверга 27 августа — он сам.
      expect(outcome.deadline.at.toISOString()).toBe('2026-08-26T21:00:00.000Z');
    }
  });
});
