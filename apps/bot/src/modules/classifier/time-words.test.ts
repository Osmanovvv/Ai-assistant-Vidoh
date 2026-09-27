import { describe, expect, it } from 'vitest';

import { resolveDeadline } from './dates.js';
import {
  dayOfMonthIn,
  hasTimeWord,
  relativeDaysIn,
  timeQuoteInSpeech,
  weekdayIn,
} from './time-words.js';

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
// Четверг, 11:00 по Москве: до полудня «в четверг» — ещё сегодня (`namedWeekday`).
const NOW = new Date('2026-08-27T08:00:00.000Z');
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
      // Ближайший четверг от четверга утром — это сегодня: человек говорит о
      // ближайшем, иначе сказал бы «в следующий». Вечером — см. ниже.
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

  it('после полудня сегодняшний четверг — уже следующий (голос 10, 18.09.2026)', () => {
    // Тот же четверг, 15:00 по Москве: о сегодняшнем вечере человек
    // говорит «сегодня», а «в четверг» — про 3 сентября. Модель как раз
    // так и отвечала; прежний код тянул её на сегодня.
    const outcome = resolveDeadline(
      { deadline: '2026-09-03', accuracy: 'day' },
      { now: new Date('2026-08-27T12:00:00.000Z'), timeZone: ZONE, said: `${SAID} в четверг` },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      expect(outcome.corrected).toBeUndefined();
      expect(outcome.deadline.at.toISOString().slice(0, 10)).toBe('2026-09-02');
    }
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
    // Слово содержит «завтра» целиком: при поиске подстрокой вышло бы
    // два смещения сразу, и правило отказалось бы работать. Сверка по
    // границам слов это исключает.
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
      // Не «сегодня», а неделя, и хранится она понедельником (31.08 по
      // Москве — 30.08T21:00Z): срок не опровергнут, а уложен на начало периода.
      expect(outcome.deadline.at.toISOString().slice(0, 10)).toBe('2026-08-30');
      expect(outcome.deadline.accuracy).toBe('week');
    }
  });
});

describe('«завтрак» — не «завтра» (ревизия, дефект 7)', () => {
  it('слово о дне сверяется целиком, а не подстрокой', () => {
    // «Завтрак», «завтраки», «позавтракать» содержат «завтра» целиком,
    // и поиск подстрокой давал на них смещение +1 — то есть срок дела
    // про еду уезжал на завтра. Соседний модуль (own-sentence.ts) те же
    // три слова сверяет равенством и на «завтрак» молчит.
    expect(relativeDaysIn('приготовить завтрак')).toEqual([]);
    expect(relativeDaysIn('собрать завтраки детям')).toEqual([]);
    expect(relativeDaysIn('позавтракать с мамой')).toEqual([]);
  });

  it('названный день рядом с «завтраком» считается один раз', () => {
    // Раньше «завтрак» давал второе, призрачное смещение, и правило 3.41
    // отказывалось работать — тихо, как «два слова о дне».
    expect(relativeDaysIn('сегодня приготовить завтрак')).toEqual([0]);
    expect(relativeDaysIn('завтра завтрак с мамой')).toEqual([1]);
    expect(relativeDaysIn('послезавтра завтрак')).toEqual([2]);
  });

  it('срок дела про завтрак не уезжает на завтра', () => {
    // Модель верно поставила «сегодня» на «утром приготовить завтрак»,
    // а код перебивал её датой на завтра и писал в журнал «relative» —
    // как поправку за моделью.
    const outcome = resolveDeadline(
      { deadline: '2026-08-27', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'утром приготовить завтрак' },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      expect(outcome.corrected).toBeUndefined();
      expect(outcome.deadline.at.toISOString().slice(0, 10)).toBe('2026-08-26');
    }
  });

  it('«сегодня» рядом с «завтраком» по-прежнему пересчитывает дату', () => {
    // Обратная сторона той же ошибки: «сегодня» плюс призрачное «завтра»
    // из «завтрака» читались как два слова о дне, и неверную дату модели
    // никто не поправлял.
    const outcome = resolveDeadline(
      { deadline: '2026-08-28', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'ещё сегодня приготовить завтрак на утро' },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      expect(outcome.corrected).toBe('relative');
      expect(outcome.deadline.at.toISOString().slice(0, 10)).toBe('2026-08-26');
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

describe('цитата, которая принадлежит соседней записи (прогон 17.09.2026)', () => {
  /**
   * Стенд на живой расшифровке: «…на? Следующей неделе записаться к
   * стоматологу давно уже откладываю в октябре пройти диспансеризацию».
   * Извлечение потеряло «в октябре», и модель отдала диспансеризации
   * срок соседа — 21.09, неделя, с цитатой «следующей неделе». Цитата в
   * речи есть — проверка дословности её пропускала, а принадлежит она
   * стоматологу: его слова её содержат. Чужая цитата срок не спасает.
   */
  const thursday = { now: new Date('2026-09-16T23:24:42.000Z'), timeZone: 'Europe/Moscow' };
  const SPEECH =
    'В пятницу надо забрать справку из поликлиники завтра позвонить в банк по карте, там что то с лимитом на? Следующей неделе записаться к стоматологу давно уже откладываю в октябре пройти диспансеризацию.';
  const dentist = 'Следующей неделе записаться к стоматологу записаться к стоматологу';

  it('цитата, которую содержат слова соседней записи, — не своя: срок снимается', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-09-21', accuracy: 'week' },
      {
        ...thursday,
        said: 'пройти диспансеризацию пройти диспансеризацию',
        quoted: 'следующей неделе',
        spoken: SPEECH,
        siblings: [dentist],
      },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('другой записи');
  });

  it('без соседей та же цитата срок держит — прежнее поведение', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-09-21', accuracy: 'week' },
      {
        ...thursday,
        said: 'пройти диспансеризацию пройти диспансеризацию',
        quoted: 'следующей неделе',
        spoken: SPEECH,
        siblings: ['забрать справку из поликлиники'],
      },
    );

    expect(outcome.ok).toBe(true);
  });

  it('фраза сказана дважды — на двоих её хватает', () => {
    // «завтра позвонить в банк, завтра же купить хлеб»: сосед забрал одно
    // «завтра», второе свободно.
    const outcome = resolveDeadline(
      { deadline: '2026-09-18', accuracy: 'day' },
      {
        ...thursday,
        said: 'купить хлеб',
        quoted: 'завтра',
        spoken: 'завтра позвонить в банк, завтра же купить хлеб',
        siblings: ['завтра позвонить в банк позвонить в банк'],
      },
    );

    expect(outcome.ok).toBe(true);
  });

  it('чужая цитата, с которой дата совпадает, снимает срок и при цифрах в словах дела (заказчица, бой 21.09.2026)', () => {
    /**
     * Бой: «Записаться в Краснодаре на Хайдру на среду, так? Так завтра.
     * С 9 до 10 не забыть позвонить Елене Михайловне в бухгалтерию» —
     * звонку модель дала среду, день соседа. Цитата «на среду» чужая, но
     * цифры «с 9 до 10» пускали дату и без цитаты: цифра считается
     * словом о времени. Часы — не день; дата, совпадающая с чужой
     * цитатой, взята из неё, и держаться ей не на чем.
     */
    const monday = { now: new Date('2026-09-21T06:46:00.000Z'), timeZone: 'Europe/Moscow' };
    const speech =
      'Записаться в Краснодаре на Хайдру на среду, так? Так завтра. С 9 до 10 не забыть позвонить. Елене Михайловне в бухгалтерию.';
    const call = {
      ...monday,
      said: 'С 9 до 10 не забыть позвонить Елене Михайловне в бухгалтерию',
      quoted: 'на среду',
      spoken: speech,
      siblings: ['Записаться в Краснодаре на Хайдру на среду Записаться на Хайдру на среду'],
    };

    const wednesday = resolveDeadline({ deadline: '2026-09-23', accuracy: 'day' }, call);
    expect(wednesday.ok).toBe(false);
    if (!wednesday.ok) expect(wednesday.reason).toContain('другой записи');

    // Дата, с чужой цитатой не совпадающая, взята не из неё — держится на
    // своих цифрах, как прежде.
    const tuesday = resolveDeadline({ deadline: '2026-09-22', accuracy: 'day' }, call);
    expect(tuesday.ok).toBe(true);
  });

  it('свои слова о времени цитатой соседа не отменяются', () => {
    // У записи есть своё «в октябре» — правило месяца работает как прежде,
    // чужая цитата просто не участвует.
    const outcome = resolveDeadline(
      { deadline: '2026-09-21', accuracy: 'week' },
      {
        ...thursday,
        said: 'в октябре пройти диспансеризацию',
        quoted: 'следующей неделе',
        spoken: SPEECH,
        siblings: [dentist],
      },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      expect(outcome.deadline.accuracy).toBe('month');
      expect(outcome.deadline.at.toISOString()).toBe('2026-09-30T21:00:00.000Z');
    }
  });
});

describe('срок «ГГГГ-ММ» от модели (бой 17.09.2026)', () => {
  /**
   * Журнал боя: «срок «2026-10» не в виде ГГГГ-ММ-ДД» — запись осталась
   * без срока. Промпт просит ГГГГ-ММ-ДД и первое число для месяца, но
   * месяц без дня — естественный ответ на «в октябре», и терять его
   * из-за формы нельзя: это месяц, первое число.
   */
  const thursday = { now: new Date('2026-09-16T23:24:42.000Z'), timeZone: 'Europe/Moscow' };

  it('«2026-10» — первое октября с точностью «месяц», какую бы точность модель ни назвала', () => {
    for (const accuracy of ['month', 'day', 'week'] as const) {
      const outcome = resolveDeadline(
        { deadline: '2026-10', accuracy },
        { ...thursday, said: 'в октябре пройти диспансеризацию' },
      );

      expect(outcome.ok).toBe(true);
      if (outcome.ok && outcome.deadline) {
        expect(outcome.deadline.at.toISOString()).toBe('2026-09-30T21:00:00.000Z');
        expect(outcome.deadline.accuracy).toBe('month');
      }
    }
  });

  it('месяц без слов человека о времени — по-прежнему не срок', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-10', accuracy: 'month' },
      { ...thursday, said: 'за осень сделать ремонт в спальне' },
    );

    expect(outcome.ok).toBe(false);
  });

  it('несуществующий месяц — отказ', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-13', accuracy: 'month' },
      { ...thursday, said: 'в октябре пройти диспансеризацию' },
    );

    expect(outcome.ok).toBe(false);
  });
});

describe('число месяца словами — «до десятого» (стенд 27.09.2026, voice-27-03)', () => {
  /**
   * «Еще оплатить квартплату до десятого» — модель дала 10.10 с цитатой
   * «до десятого», а код её отбросил: число словами он словом о времени
   * не считал, цифрой «до 10» прошло бы. Признаётся только число после
   * предлога и без своего существительного за ним: «к пятому уроку» и
   * «до десятого класса» — не даты.
   */
  const SPEECH =
    'Значит так, в понедельник надо отправить договор юристу. Хотя нет, давай во вторник, в понедельник я не успею. Еще оплатить квартплату до десятого и купить корм собаке, он заканчивается.';
  const SUNDAY_EVENING = new Date('2026-09-27T16:40:00.000Z');

  it.each([
    ['до десятого', [10]],
    ['к пятнадцатому числу', [15]],
    ['до двадцать пятого', [25]],
    ['до тридцать первого', [31]],
    ['с третьего', [3]],
    ['к пятому уроку', []],
    ['до десятого класса', []],
    ['в десятом классе', []],
    ['десятого', []],
  ])('«%s» → %j', (text, days) => {
    expect(dayOfMonthIn(text)).toEqual(days);
  });

  it('цитата «до десятого», сказанная дословно, — о времени', () => {
    expect(timeQuoteInSpeech('до десятого', SPEECH)).toBe(true);
  });

  it('«к пятому уроку» — нет, даже дословно', () => {
    expect(timeQuoteInSpeech('к пятому уроку', 'Отвести сына к пятому уроку')).toBe(false);
  });

  it('срок модели 10.10 по цитате «до десятого» принимается', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-10-10', accuracy: 'day' },
      {
        now: SUNDAY_EVENING,
        timeZone: ZONE,
        said: 'Оплатить квартплату до десятого',
        quoted: 'до десятого',
        spoken: SPEECH,
      },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.deadline?.at.toISOString()).toBe('2026-10-09T21:00:00.000Z');
  });

  it('число в дате модели не то, что сказано, — срока нет, как было', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-10-11', accuracy: 'day' },
      {
        now: SUNDAY_EVENING,
        timeZone: ZONE,
        said: 'Оплатить квартплату до десятого',
        quoted: 'до десятого',
        spoken: SPEECH,
      },
    );

    expect(outcome.ok).toBe(false);
  });
});
