import { describe, expect, it } from 'vitest';

import { resolveDeadline } from './dates.js';
import { hasTimeWord, relativeDaysIn, timeQuoteInSpeech, weekdayIn } from './time-words.js';

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

  it('пересказ проходит, только если день из него назван в речи (3.49)', () => {
    // «Завтра вечером» при сказанном «купить завтра»: рядом таких слов
    // нет, но день — «завтра» — человек назвал, и дата из него одна.
    // Живой прогон 03.09.2026: без этого верная дата корма отбрасывалась.
    expect(timeQuoteInSpeech('сегодня вечером', SPEECH)).toBe(true);
    expect(timeQuoteInSpeech('в четверг завезти вещи', SPEECH)).toBe(true);

    // А день, которого в речи нет, пересказ не спасает.
    expect(timeQuoteInSpeech('в пятницу вечером', SPEECH)).toBe(false);
    expect(timeQuoteInSpeech('завтра утром', SPEECH)).toBe(false);
    // Только час без дня — тоже нет: дату из него не вывести.
    expect(timeQuoteInSpeech('вечером в семь', SPEECH)).toBe(false);
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

  it('откат на старую версию промпта ничего не ломает', () => {
    /**
     * Схема `classifier.v2` поля цитаты не содержит, и при откате на
     * `classifier@5` его в ответе не будет вовсе. Тогда `quoted` придёт
     * `undefined` — и должно получиться прежнее поведение, а не отказ.
     */
    const outcome = resolveDeadline(
      { deadline: '2026-08-27', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'купить продукты сегодня', spoken: SPEECH },
    );

    expect(outcome.ok).toBe(true);
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

describe('назван день недели — берётся ближайший (задача 3.39)', () => {
  /** Четверг, 27 августа 2026. Следующий четверг — 3 сентября. */
  const SAID = 'забрать справку из поликлиники';

  it('дальний четверг подтягивается к ближайшему', () => {
    // Живой прогон 03.09.2026, в четверг: на «в четверг забрать справку»
    // модель вернула 10 сентября — тоже четверг, и прежняя проверка это
    // пропускала. Справка уезжала на неделю.
    const outcome = resolveDeadline(
      { deadline: '2026-09-03', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: `${SAID} в четверг` },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      expect(outcome.corrected).toBe('weekday');
      // Ближайший четверг от четверга — он сам, 27 августа.
      expect(outcome.deadline.at.toISOString().slice(0, 10)).toBe('2026-08-26');
    }
  });

  it('«в следующий четверг» остаётся дальним — это его выбор', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-09-03', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: `${SAID} в следующий четверг` },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      expect(outcome.corrected).toBeUndefined();
      expect(outcome.deadline.at.toISOString().slice(0, 10)).toBe('2026-09-02');
    }
  });

  it('«через неделю в пятницу» тоже не трогается', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-09-04', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'сдать отчёт через неделю в пятницу' },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) expect(outcome.corrected).toBeUndefined();
  });

  it('ближайший день недели не трогается', () => {
    // Пятница 28 августа — ближайшая от четверга.
    const outcome = resolveDeadline(
      { deadline: '2026-08-28', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'сдать отчёт в пятницу' },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) expect(outcome.corrected).toBeUndefined();
  });

  it('правило работает и через цитату', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-09-03', accuracy: 'day' },
      {
        now: NOW,
        timeZone: ZONE,
        said: SAID,
        quoted: 'в четверг',
        spoken: 'в четверг забрать справку из поликлиники',
      },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      expect(outcome.deadline.at.toISOString().slice(0, 10)).toBe('2026-08-26');
    }
  });
});

describe('«сегодня» и «завтра» считает код (задача 3.41)', () => {
  /** Четверг, 27 августа 2026, полдень по Москве. */
  it('«сегодня» кладёт дату на сегодня, что бы ни сказала модель', () => {
    // Живая выгрузка проджекта 03.09.2026: «ещё сегодня хотел позвонить
    // бабушке» модель датировала завтрашним днём.
    const outcome = resolveDeadline(
      { deadline: '2026-08-28', accuracy: 'day' },
      {
        now: NOW,
        timeZone: ZONE,
        said: 'позвонить бабушке',
        quoted: 'сегодня',
        spoken: 'ещё сегодня хотел позвонить бабушке',
      },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      expect(outcome.corrected).toBe('relative');
      expect(outcome.deadline.at.toISOString().slice(0, 10)).toBe('2026-08-26');
    }
  });

  it('«завтра» — ровно следующий день', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-09-01', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'отнести ноутбук в сервис завтра' },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      expect(outcome.deadline.at.toISOString().slice(0, 10)).toBe('2026-08-27');
    }
  });

  it('«послезавтра» не путается с «завтра»', () => {
    // Слово содержит «завтра» целиком: без порядка поиска вышло бы два
    // смещения сразу, и правило отказалось бы работать.
    expect(relativeDaysIn('английский послезавтра')).toEqual([2]);
    expect(relativeDaysIn('завтра в банк')).toEqual([1]);
    expect(relativeDaysIn('сегодня вечером')).toEqual([0]);
  });

  it('верную дату не трогает', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-08-27', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'сегодня купить продукты' },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) expect(outcome.corrected).toBeUndefined();
  });

  it('два слова о дне — за человека не решаем', () => {
    // «Сегодня купить продукты на завтра»: какой из двух дней срок —
    // догадка, а её цена неверный срок.
    const outcome = resolveDeadline(
      { deadline: '2026-08-28', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'сегодня купить продукты на завтра' },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) expect(outcome.corrected).toBeUndefined();
  });

  it('назван день недели — правило дня недели главнее', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-09-03', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'сегодня решить, а сделать в четверг' },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      // Ближайший четверг, а не сегодня.
      expect(outcome.deadline.at.toISOString().slice(0, 10)).toBe('2026-08-26');
    }
  });

  it('неделя и месяц словом о дне не опровергаются', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-09-02', accuracy: 'week' },
      { now: NOW, timeZone: ZONE, said: 'сегодня подумать про отчёт на этой неделе' },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      expect(outcome.corrected).toBeUndefined();
      expect(outcome.deadline.at.toISOString().slice(0, 10)).toBe('2026-09-01');
    }
  });
});

describe('«на выходных» — неделя, а не день (задача 3.50)', () => {
  it('точность становится недельной, дата — на субботу', () => {
    // §2.7: `week` — назван период. «Выходные» это два дня, и выдавать
    // их за один нельзя. В наборе модель четыре прогона подряд отдавала
    // «день» на «разобрать балкон на выходных».
    const outcome = resolveDeadline(
      { deadline: '2026-08-30', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'на выходных разобрать балкон' },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      expect(outcome.corrected).toBe('weekend');
      expect(outcome.deadline.accuracy).toBe('week');
      // Ближайшая суббота от четверга 27 августа — 29-е.
      expect(outcome.deadline.at.toISOString().slice(0, 10)).toBe('2026-08-28');
    }
  });

  it('названный день главнее выходных', () => {
    // «В субботу на выходных» — день назван, и решает он.
    const outcome = resolveDeadline(
      { deadline: '2026-08-29', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'в субботу на выходных разобрать балкон' },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      expect(outcome.deadline.accuracy).toBe('day');
    }
  });

  it('точность недели и месяца не трогается', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-08-29', accuracy: 'week' },
      { now: NOW, timeZone: ZONE, said: 'на выходных разобрать балкон' },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      expect(outcome.corrected).toBeUndefined();
      expect(outcome.deadline.accuracy).toBe('week');
    }
  });

  it('слова внутри других слов не считаются выходными', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-08-28', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'завтра проверить выходные данные отчёта' },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      // «Завтра» названо — им и решается, точность дневная.
      expect(outcome.deadline.accuracy).toBe('day');
    }
  });
});
