import { describe, expect, it } from 'vitest';

import type { ResolverAnswer } from '../ai/schemas/index.js';
import type { Candidate, CandidateSource } from './candidates.js';
import { decide, DEFAULT_THRESHOLDS, spokenFits } from './decision.js';

/**
 * Пороговая логика резолвера (§7.3 ТЗ, задача 3.2).
 *
 * План требует таблицу случаев. Она здесь — и проверяет не только три
 * строки из ТЗ, но и то, ради чего второй сигнал вводился: уверенная
 * модель без подтверждения запись человека не меняет.
 *
 * Цена ошибки несимметрична, и таблица это отражает: лишний вопрос стоит
 * одного тапа, лишнее изменение — доверия.
 */

const NOW = new Date('2026-08-29T12:00:00.000Z');

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 'i-1',
    text: 'Записать сына к врачу в четверг',
    topic: 'здоровье',
    deadlineAt: null,
    status: 'new',
    updatedAt: new Date(NOW.getTime() - 2 * 60_000),
    similarity: null,
    sources: ['session'] as readonly CandidateSource[],
    ...overrides,
  };
}

function answer(overrides: Partial<ResolverAnswer> = {}): ResolverAnswer {
  return {
    action: 'update',
    mode: 'replace',
    itemId: 'i-1',
    confidence: 0.9,
    changes: {
      note: '',
      text: '',
      deadline: '2026-09-04',
      deadlineAccuracy: 'day',
      recurrenceKind: 'none',
      recurrenceInterval: 0,
      recurrenceText: '',
    },
    reason: 'поправка срока',
    ...overrides,
  };
}

describe('три строки §7.3', () => {
  it('высокая уверенность с подтверждением — применить', () => {
    const verdict = decide(answer(), [candidate()], { now: NOW });

    expect(verdict.kind).toBe('apply');
    expect(verdict.candidate?.id).toBe('i-1');
  });

  it('средняя уверенность — спросить', () => {
    for (const confidence of [0.45, 0.6, 0.79]) {
      expect(decide(answer({ confidence }), [candidate()], { now: NOW }).kind).toBe('ask');
    }
  });

  it('низкая уверенность — создать новую: дубли лучше потери данных', () => {
    for (const confidence of [0, 0.2, 0.44]) {
      const verdict = decide(answer({ confidence }), [candidate()], { now: NOW });
      expect(verdict.kind).toBe('create');
      expect(verdict.action).toBe('new');
    }
  });

  it('границы порогов включающие', () => {
    // Ровно 0.80 — уже верхняя полоса, ровно 0.45 — уже средняя.
    expect(decide(answer({ confidence: 0.8 }), [candidate()], { now: NOW }).kind).toBe('apply');
    expect(decide(answer({ confidence: 0.45 }), [candidate()], { now: NOW }).kind).toBe('ask');
  });
});

describe('второй сигнал: без подтверждения не меняем', () => {
  it('уверенность высокая, запись несвежая и непохожая — спросить', () => {
    // Это и есть смысл второго сигнала. Самооценка модели завышена;
    // одного её числа мало, чтобы трогать запись человека.
    const stale = candidate({
      updatedAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
      sources: ['session'],
    });

    const verdict = decide(answer({ confidence: 0.99 }), [stale], { now: NOW });

    expect(verdict.kind).toBe('ask');
    expect(verdict.why).toContain('второго сигнала нет');
  });

  it('свежесть подтверждает, только когда свежая запись одна', () => {
    // Человек наговорил три дела и поправил одно вскользь — свежесть
    // не указывает ни на одно из них.
    const many = [
      candidate({ id: 'i-1' }),
      candidate({ id: 'i-2', text: 'Купить корм' }),
      candidate({ id: 'i-3', text: 'Сверить кассу' }),
    ];

    expect(decide(answer(), many, { now: NOW }).kind).toBe('ask');
    expect(decide(answer(), [many[0]!], { now: NOW }).kind).toBe('apply');
  });

  it('свежесть кончается вместе с окном', () => {
    const inside = candidate({ updatedAt: new Date(NOW.getTime() - 14 * 60_000) });
    const outside = candidate({ updatedAt: new Date(NOW.getTime() - 16 * 60_000) });

    expect(decide(answer(), [inside], { now: NOW }).kind).toBe('apply');
    expect(decide(answer(), [outside], { now: NOW }).kind).toBe('ask');
  });

  it('свежесть засчитывается только короткой памяти', () => {
    // Запись могла попасть в список смысловым поиском и оказаться
    // недавно тронутой по совпадению — это не тот сигнал.
    const found = candidate({ sources: ['semantic'], similarity: 0.3 });

    expect(decide(answer(), [found], { now: NOW }).kind).toBe('ask');
  });

  it('близость подтверждает при отрыве от второго кандидата', () => {
    const chosen = candidate({ id: 'i-1', sources: ['semantic'], similarity: 0.62 });
    const rival = candidate({ id: 'i-2', sources: ['semantic'], similarity: 0.4 });

    const verdict = decide(answer(), [chosen, rival], { now: NOW });

    expect(verdict.kind).toBe('apply');
    expect(verdict.why).toContain('близостью');
  });

  it('близость без отрыва не подтверждает: два похожих — это неясность', () => {
    const chosen = candidate({ id: 'i-1', sources: ['semantic'], similarity: 0.62 });
    const rival = candidate({ id: 'i-2', sources: ['semantic'], similarity: 0.58 });

    expect(decide(answer(), [chosen, rival], { now: NOW }).kind).toBe('ask');
  });

  it('близость ниже порога не подтверждает', () => {
    // Замеренная близость настоящей поправки — около 0,3. Сама по себе
    // она сигналом не является.
    const chosen = candidate({ sources: ['semantic'], similarity: 0.31 });

    expect(decide(answer(), [chosen], { now: NOW }).kind).toBe('ask');
  });

  it('срок подтверждает только единственного: два дела на тот же день — неясность (ревизия этапа 3, A2)', () => {
    /**
     * «Врача перенеси» при двух делах на четверг: близость и свежесть
     * единственности требуют, а срок — нет, и правка шла в первое
     * попавшееся без вопроса.
     */
    const first = candidate({
      id: 'i-1',
      sources: ['deadline'],
      updatedAt: new Date(NOW.getTime() - 5 * 60 * 60_000),
      deadlineAt: new Date('2026-09-03T21:00:00.000Z'),
    });
    const second = candidate({
      id: 'i-2',
      sources: ['deadline'],
      updatedAt: new Date(NOW.getTime() - 5 * 60 * 60_000),
      deadlineAt: new Date('2026-09-03T21:00:00.000Z'),
    });

    const verdict = decide(answer(), [first, second], { now: NOW });

    expect(verdict.kind).toBe('ask');
  });

  it('совпадение по сроку подтверждает: «то, что в четверг, — на десятое»', () => {
    // Дата в фразе назвала запись (у неё срок четверг), а новый срок — другой.
    const dated = candidate({
      sources: ['deadline'],
      updatedAt: new Date(NOW.getTime() - 5 * 60 * 60_000),
      deadlineAt: new Date('2026-09-03T21:00:00.000Z'),
    });

    const verdict = decide(
      answer({ changes: { ...answer().changes, deadline: '2026-09-10' } }),
      [dated],
      { now: NOW },
    );

    expect(verdict.kind).toBe('apply');
    expect(verdict.why).toContain('сроком');
  });

  it('дата назначения не опознаёт запись: «перенеси врача на понедельник» при деле, уже стоящем на понедельник (прогон 17.09.2026, шаг 16)', () => {
    /**
     * Бой: «врача» в делах нет, у стоматолога срок «на неделе с 21.09»
     * (понедельник). Кандидаты по сроку нашли стоматолога — по дате
     * **назначения**, — сигнал засчитался, и бот «перенёс» его туда, где
     * он и был: «Там уже так — менять нечего». Должен был спросить.
     */
    const monday = candidate({
      id: 'i-1',
      text: 'Записаться к стоматологу',
      sources: ['session', 'deadline'],
      updatedAt: new Date(NOW.getTime() - 40 * 60_000),
      deadlineAt: new Date('2026-09-20T21:00:00.000Z'),
    });

    const verdict = decide(
      answer({ confidence: 1, changes: { ...answer().changes, deadline: '2026-09-21' } }),
      [monday],
      { now: NOW, spoken: 'перенеси врача на понедельник' },
    );

    expect(verdict.kind).toBe('ask');
  });
});

describe('четвёртый сигнал: человек назвал запись её словом (прогон 17.09.2026, блок E)', () => {
  /**
   * Бой: «Нет, к стоматологу лучше в субботу» при 13 кандидатах —
   * модель уверена (1,0), выбрала «Записаться к стоматологу», дата
   * верная, а бот спросил «это про … или отдельная история?»: запись
   * несвежая (80 минут), по сроку не выделяется, вектор отрыва не дал.
   * Но слово «стоматологу» есть ровно в одной записи из тринадцати —
   * дословность и единственность, как у срока и свежести.
   */
  const stale = (id: string, text: string): Candidate =>
    candidate({
      id,
      text,
      updatedAt: new Date(NOW.getTime() - 80 * 60_000),
      sources: ['session', 'semantic'],
      similarity: 0.3,
    });

  const dentist = stale('i-1', 'Записаться к стоматологу');
  const others = [
    stale('i-2', 'Записаться к парикмахеру'),
    stale('i-3', 'Пройти диспансеризацию'),
    stale('i-4', 'Забрать справку из поликлиники'),
  ];

  it('слово, которое есть у одного кандидата, и он же выбран моделью — применить', () => {
    const verdict = decide(answer({ confidence: 1 }), [dentist, ...others], {
      now: NOW,
      spoken: 'Нет, к стоматологу лучше в субботу.',
    });

    expect(verdict.kind).toBe('apply');
    expect(verdict.why).toBe('подтверждено словом');
  });

  it('слово общее для двух кандидатов не подтверждает: «записаться» есть у двоих', () => {
    const verdict = decide(answer({ confidence: 1 }), [dentist, ...others], {
      now: NOW,
      spoken: 'Нет, записаться лучше в субботу.',
    });

    expect(verdict.kind).toBe('ask');
  });

  it('слово о времени не считается: «в субботу» — не имя записи', () => {
    const saturday = stale('i-5', 'Разобрать балкон в субботу');
    const verdict = decide(answer({ confidence: 1, itemId: 'i-5' }), [dentist, saturday], {
      now: NOW,
      spoken: 'Нет, лучше в субботу.',
    });

    expect(verdict.kind).toBe('ask');
  });

  it('названо слово другой записи, а модель выбрала не её — спросить, не применять', () => {
    const verdict = decide(answer({ confidence: 1, itemId: 'i-3' }), [dentist, ...others], {
      now: NOW,
      spoken: 'Нет, к стоматологу лучше в субботу.',
    });

    expect(verdict.kind).toBe('ask');
  });

  it('склонение не мешает: «врача» находит «врачу», «стоматолога» — «стоматологу»', () => {
    const doctor = stale('i-6', 'Записать сына к врачу');
    const verdict = decide(answer({ confidence: 1, itemId: 'i-6' }), [doctor, dentist], {
      now: NOW,
      spoken: 'Врача перенеси на пятницу.',
    });

    expect(verdict.kind).toBe('apply');
    expect(verdict.why).toBe('подтверждено словом');
  });

  it('глагол дела — не имя: «купила» не называет «Купить корм коту» (набор резолвера, случай 06)', () => {
    const food = stale('i-7', 'Купить корм коту');
    const list = stale('i-8', 'Проверить список продуктов');
    const verdict = decide(
      answer({ confidence: 1, itemId: 'i-7', action: 'complete' }),
      [food, list],
      {
        now: NOW,
        spoken: 'купила',
      },
    );

    expect(verdict.kind).toBe('ask');
  });

  it('склонение с другой длиной тоже находит: «собакой» — «собаке», но у трёх собачьих дел единственности нет', () => {
    const collar = stale('i-9', 'Купить собаке новый ошейник');
    const leash = stale('i-10', 'Купить новый поводок для собаки');
    const alone = decide(answer({ confidence: 1, itemId: 'i-9' }), [collar, dentist], {
      now: NOW,
      spoken: 'Дело с собакой перенеси на вторник.',
    });
    expect(alone.kind).toBe('apply');

    const crowd = decide(answer({ confidence: 1, itemId: 'i-9' }), [collar, leash, dentist], {
      now: NOW,
      spoken: 'Дело с собакой перенеси на вторник.',
    });
    expect(crowd.kind).toBe('ask');
  });

  it('короткие и служебные слова не считаются', () => {
    const verdict = decide(answer({ confidence: 1 }), [dentist, ...others], {
      now: NOW,
      spoken: 'Нет, это лучше не так.',
    });

    expect(verdict.kind).toBe('ask');
  });

  it('без слов человека сигнала нет — прежнее поведение', () => {
    const verdict = decide(answer({ confidence: 1 }), [dentist, ...others], { now: NOW });

    expect(verdict.kind).toBe('ask');
    expect(verdict.why).toContain('второго сигнала нет');
  });
});

describe('пятый сигнал: перенос срока, а срок есть у одной записи (прогон 18.09.2026, голос 2)', () => {
  /**
   * Бой: «Записать кота к ветеринару в среду, хотя нет, в среду не могу,
   * давай в четверг, и ещё купить ему корм» — одним голосовым. Правка
   * «Не могу, давай в четверг» меняет только срок; кандидатов два, оба
   * свежие, близости нет, слова записи не названо — и бот спросил «это
   * про ветеринара?». Но срок из двух записей есть у одной: перенос —
   * это когда есть что переносить, а переносить больше нечего.
   */
  const vet = candidate({
    id: 'i-1',
    text: 'Записать кота к ветеринару',
    deadlineAt: new Date('2026-09-22T21:00:00.000Z'),
  });
  const food = candidate({ id: 'i-2', text: 'Купить коту корм' });
  const thursday = (overrides: Partial<ResolverAnswer> = {}): ResolverAnswer =>
    answer({
      confidence: 1,
      changes: { ...answer().changes, deadline: '2026-09-24' },
      ...overrides,
    });
  const context = { now: NOW, spoken: 'Не могу, давай в четверг', timeZone: 'Europe/Moscow' };

  it('две свежие записи, срок у одной, и её выбрала модель — применить', () => {
    const verdict = decide(thursday(), [vet, food], context);

    expect(verdict.kind).toBe('apply');
    expect(verdict.why).toBe('подтверждено переносом');
  });

  it('срок у обеих — переносить можно любую, спросить', () => {
    const dated = candidate({
      id: 'i-2',
      text: 'Купить коту корм',
      deadlineAt: new Date('2026-09-20T21:00:00.000Z'),
    });

    const verdict = decide(thursday(), [vet, dated], context);

    expect(verdict.kind).toBe('ask');
  });

  it('модель выбрала запись без срока — это не перенос, спросить', () => {
    const verdict = decide(thursday({ itemId: 'i-2' }), [vet, food], context);

    expect(verdict.kind).toBe('ask');
  });

  it('срок в тот же день, где запись и стоит, — не перенос: дата в фразе была назначением (шаг 16)', () => {
    const verdict = decide(
      thursday({ changes: { ...thursday().changes, deadline: '2026-09-23' } }),
      [vet, food],
      context,
    );

    expect(verdict.kind).toBe('ask');
  });

  it('правка не только срока — с новым текстом сигнал молчит', () => {
    const verdict = decide(
      thursday({ changes: { ...thursday().changes, text: 'Записать кота к грумеру' } }),
      [vet, food],
      context,
    );

    expect(verdict.kind).toBe('ask');
  });
});

/**
 * Шестой сигнал: запись — единственная из последнего разговора (проверка
 * Никиты 24.09.2026, 16:40). «Купить сыр» бот записал три минуты назад,
 * «Не сыр, а творог» — модель уверена и права, но свежих два (посылку
 * переносили в 16:33), а «сыр» короче четырёх букв — и бот спрашивал
 * кнопкой. Последний разговор был ровно об одном деле — о сыре.
 */
describe('шестой сигнал: единственная запись последнего разговора', () => {
  const cheese = candidate({ id: 'cheese', text: 'Купить сыр' });
  const parcel = candidate({ id: 'parcel', text: 'Забрать посылку' });
  const confident = answer({
    itemId: 'cheese',
    confidence: 1,
    changes: { ...answer().changes, text: 'Купить творог' },
  });

  it('два свежих, слово короткое — разговор был о сыре: применяется', () => {
    expect(
      decide(confident, [cheese, parcel], {
        now: NOW,
        spoken: 'Не сыр, а творог',
        lastTalk: ['cheese'],
      }),
    ).toMatchObject({ kind: 'apply', why: 'подтверждено разговором' });
  });

  it('без следа разговора — как прежде, вопрос', () => {
    expect(
      decide(confident, [cheese, parcel], { now: NOW, spoken: 'Не сыр, а творог' }),
    ).toMatchObject({
      kind: 'ask',
      why: 'уверенность высокая, но второго сигнала нет',
    });
  });

  it('разговор был о другом деле или о двух — не подтверждение', () => {
    for (const lastTalk of [['parcel'], ['cheese', 'parcel'], []]) {
      expect(
        decide(confident, [cheese, parcel], { now: NOW, spoken: 'Не сыр, а творог', lastTalk }),
      ).toMatchObject({ kind: 'ask' });
    }
  });

  it('средняя уверенность разговором не поднимается', () => {
    expect(
      decide({ ...confident, confidence: 0.6 }, [cheese, parcel], {
        now: NOW,
        spoken: 'Не сыр, а творог',
        lastTalk: ['cheese'],
      }),
    ).toMatchObject({ kind: 'ask', why: 'уверенность средняя' });
  });
});

describe('защита от выдуманного ответа', () => {
  it('запись не из списка не применяется ни при какой уверенности', () => {
    // Модель может назвать идентификатор, которого мы ей не давали.
    // Что это за запись и чья она — неизвестно.
    const verdict = decide(answer({ itemId: 'i-999', confidence: 1 }), [candidate()], { now: NOW });

    expect(verdict.kind).toBe('create');
    expect(verdict.why).toContain('не было среди кандидатов');
  });

  it('пустой список кандидатов даёт новую запись', () => {
    expect(decide(answer({ confidence: 1 }), [], { now: NOW }).kind).toBe('create');
  });

  it('ответ «новая мысль» уважается даже при высокой уверенности', () => {
    const verdict = decide(answer({ action: 'new', itemId: '', confidence: 0.95 }), [candidate()], {
      now: NOW,
    });

    expect(verdict.kind).toBe('create');
  });
});

describe('действие сохраняется', () => {
  it('закрыть и отменить проходят те же пороги, что и правка', () => {
    // Закрыть чужое дело — такая же потеря доверия, как поправить его.
    for (const action of ['complete', 'cancel'] as const) {
      const applied = decide(answer({ action }), [candidate()], { now: NOW });
      expect(applied.kind).toBe('apply');
      expect(applied.action).toBe(action);

      const asked = decide(answer({ action, confidence: 0.5 }), [candidate()], { now: NOW });
      expect(asked.kind).toBe('ask');
      expect(asked.action).toBe(action);
    }
  });
});

describe('пороги настраиваются', () => {
  it('переданные значения перекрывают значения по умолчанию', () => {
    // §3.2: пороги должны настраиваться из админки. Её ещё нет, но
    // настраиваемость обязана быть заложена, иначе четвёртый этап
    // упрётся в константы, разбросанные по коду.
    const strict = decide(answer({ confidence: 0.85 }), [candidate()], {
      now: NOW,
      thresholds: { apply: 0.95 },
    });

    expect(strict.kind).toBe('ask');
  });

  it('значения по умолчанию — те, что измерены', () => {
    expect(DEFAULT_THRESHOLDS.apply).toBe(0.8);
    expect(DEFAULT_THRESHOLDS.create).toBe(0.45);
    // Порог близости 0,75 из плана недостижим для поправок: замер дал
    // 0,31–0,52. Если кто-то вернёт его обратно, тест скажет об этом.
    expect(DEFAULT_THRESHOLDS.similarity).toBeLessThan(0.6);
  });
});

describe('отметка выполнения не переспрашивает (§21 п.8, задача 3.8)', () => {
  /**
   * Два пункта §21 спорят: п.8 требует отметки «без уточняющих вопросов»,
   * п.5 — вопроса на неоднозначной реплике. Спор решён замером: отметка
   * повторяет слова дела, и близость у неё выше, чем у поправки.
   *
   * Значит порог у неё свой — и проверять надо обе стороны: что ясная
   * отметка проходит молча, а неясная всё равно спрашивает.
   */
  const found = (similarity: number): Candidate =>
    candidate({
      sources: ['semantic'],
      similarity,
      updatedAt: new Date(NOW.getTime() - 5 * 60 * 60_000),
    });

  it('«кассу сверила» закрывает дело без вопроса', () => {
    // Замер этой пары — 0,512. Правке такой близости не хватило бы, и это
    // верно: правка не повторяет слов дела, а отметка повторяет.
    const verdict = decide(answer({ action: 'complete' }), [found(0.512)], { now: NOW });

    expect(verdict.kind).toBe('apply');
    expect(verdict.action).toBe('complete');
  });

  it('самая слабая из замеренных верных пар тоже проходит', () => {
    // «Продукты купила» → «Проверить список продуктов», 0,391.
    expect(decide(answer({ action: 'complete' }), [found(0.391)], { now: NOW }).kind).toBe('apply');
  });

  it('самая сильная из чужих пар не проходит', () => {
    // «Записалась к врачу» → «Сверить кассу», 0,256. Закрыть чужое дело
    // дороже, чем переспросить.
    expect(decide(answer({ action: 'complete' }), [found(0.256)], { now: NOW }).kind).toBe('ask');
  });

  it('двум похожим делам отметка всё равно задаёт вопрос (§21 п.5)', () => {
    // «Купила» при двух покупках сразу: отрыва нет, и низкий порог тут не
    // помогает — он и не должен.
    const first = candidate({ id: 'i-1', sources: ['semantic'], similarity: 0.45 });
    const second = candidate({ id: 'i-2', sources: ['semantic'], similarity: 0.42 });

    expect(decide(answer({ action: 'complete' }), [first, second], { now: NOW }).kind).toBe('ask');
  });

  it('правке этот порог не достаётся', () => {
    // 0,391 для отметки — достаточно, для правки — нет. Иначе смягчение
    // ради §21 п.8 тихо распространилось бы на переписывание заголовков.
    expect(decide(answer({ action: 'update' }), [found(0.391)], { now: NOW }).kind).toBe('ask');
  });

  it('отмена идёт по тому же порогу, что и выполнение', () => {
    // §13.5: «убрать» — тоже не переписывание, а перевод в отменённые, и
    // откатывается одним тапом.
    expect(decide(answer({ action: 'cancel' }), [found(0.42)], { now: NOW }).kind).toBe('apply');
  });
});

describe('подходят ли слова человека к записи (страж разговора, проба 24.09.2026)', () => {
  it('«посылку» подходит к «посылки с Вайлдберриз» — одно слово в разных формах', () => {
    expect(
      spokenFits('посылку давай на субботу', candidate({ text: 'Забрать посылки с Вайлдберриз' })),
    ).toBe(true);
  });

  it('названо другое дело — не подходит', () => {
    expect(spokenFits('врача перенеси на пятницу', candidate({ text: 'Забрать посылку' }))).toBe(
      false,
    );
    expect(spokenFits('с Ирой созвонились', candidate({ text: 'Забрать посылку' }))).toBe(false);
  });

  it('связки, время и глаголы-повеления делом не называют', () => {
    // «Давай», «на субботу», «забрать» есть у половины фраз и дел.
    expect(spokenFits('давай забрать на субботу', candidate({ text: 'Забрать посылку' }))).toBe(
      false,
    );
  });
});
