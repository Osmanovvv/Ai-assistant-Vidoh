import { describe, expect, it } from 'vitest';

import {
  HORIZON_HOURS,
  localDayNumber,
  planFor,
  PROJECT_NUDGE_TIME,
  type PlanInput,
} from './plan.js';

/**
 * Раскладка заданий (задачи 3.14–3.17).
 *
 * Часы управляемые: `now` приходит аргументом, `new Date()` без аргумента
 * в модуле не встречается. Поэтому «через семь дней» здесь — это правка
 * одного числа, а не ожидание недели.
 */

const MOSCOW = 'Europe/Moscow';

const settings = {
  morningTime: '08:30',
  eveningTime: '21:00',
  notificationsOn: true,
  eveningOn: true,
  quietHoursOn: true,
  quietFrom: '22:00',
  quietTo: '08:00',
};

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    timeZone: MOSCOW,
    settings,
    ignoredStreak: 0,
    deadlines: [],
    staleProjects: [],
    now: new Date('2026-08-30T03:00:00.000Z'), // 06:00 в Москве
    ...overrides,
  };
}

const kindsOf = (plan: readonly { kind: string }[]): string[] => plan.map((one) => one.kind);

const shown = (at: Date, zone = MOSCOW): string =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: zone,
    dateStyle: 'short',
    timeStyle: 'short',
    hourCycle: 'h23',
  })
    .format(at)
    .replace(',', '');

describe('утреннее и вечернее', () => {
  it('ставятся оба на сегодня', () => {
    const plan = planFor(input());

    expect(kindsOf(plan)).toEqual(['morning', 'evening']);
    expect(shown(plan[0]!.dueAt)).toBe('2026-08-30 08:30');
    expect(shown(plan[1]!.dueAt)).toBe('2026-08-30 21:00');
  });

  it('вечернее выключено отдельно от утреннего', () => {
    const plan = planFor(input({ settings: { ...settings, eveningOn: false } }));

    expect(kindsOf(plan)).toEqual(['morning']);
  });

  it('выключатель напоминаний гасит всё', () => {
    const plan = planFor(
      input({
        settings: { ...settings, notificationsOn: false },
        deadlines: [
          { itemId: 'i1', deadlineAt: new Date('2026-08-31T09:00:00.000Z'), accuracy: 'day' },
        ],
        staleProjects: ['p1'],
      }),
    );

    expect(plan).toEqual([]);
  });

  it('после утра сегодняшнее утреннее уезжает на завтра, а не в прошлое', () => {
    const plan = planFor(input({ now: new Date('2026-08-30T07:00:00.000Z') })); // 10:00 МСК

    expect(shown(plan[0]!.dueAt)).toBe('2026-08-31 08:30');
  });
});

describe('ключ, исключающий дубли', () => {
  it('у утреннего — вид и местная дата', () => {
    const plan = planFor(input());

    expect(plan[0]!.dedupeKey).toBe('morning:2026-08-30');
  });

  it('два прохода подряд дают одинаковые ключи', () => {
    // Именно на это опирается уникальный индекс: повторный запуск
    // планировщика должен упереться в тот же ключ, а не в новый.
    const first = planFor(input({ now: new Date('2026-08-30T03:00:00.000Z') }));
    const second = planFor(input({ now: new Date('2026-08-30T03:04:59.000Z') }));

    expect(second.map((one) => one.dedupeKey)).toEqual(first.map((one) => one.dedupeKey));
  });

  it('ключ срока держится за дату срока, а не за дату отправки', () => {
    // Перенос срока обязан породить новое напоминание, а не промолчать,
    // потому что «на сегодня уже ставили».
    const plan = planFor(
      input({
        deadlines: [
          { itemId: 'i1', deadlineAt: new Date('2026-08-31T09:00:00.000Z'), accuracy: 'day' },
        ],
      }),
    );

    const eve = plan.find((one) => one.kind === 'deadline_eve');
    expect(eve?.dedupeKey).toBe('deadline_eve:i1:2026-08-31');
  });
});

describe('сроки (3.16)', () => {
  const tomorrow = new Date('2026-08-31T09:00:00.000Z'); // 12:00 МСК 31-го

  it('точность «день»: накануне вечером и утром в день срока', () => {
    const plan = planFor(
      input({ deadlines: [{ itemId: 'i1', deadlineAt: tomorrow, accuracy: 'day' }] }),
    );

    const eve = plan.find((one) => one.kind === 'deadline_eve');
    const day = plan.find((one) => one.kind === 'deadline_day');

    expect(shown(eve!.dueAt)).toBe('2026-08-30 21:00');
    expect(shown(day!.dueAt)).toBe('2026-08-31 08:30');
    expect(eve!.itemId).toBe('i1');
  });

  it('точность «неделя»: ни одного напоминания', () => {
    // Условие готовности 3.16 дословно: запись со сроком «на следующей
    // неделе» не даёт напоминания на случайный день.
    const plan = planFor(
      input({ deadlines: [{ itemId: 'i1', deadlineAt: tomorrow, accuracy: 'week' }] }),
    );

    expect(kindsOf(plan)).toEqual(['morning', 'evening']);
  });

  it('точность «месяц»: тоже ни одного', () => {
    const plan = planFor(
      input({ deadlines: [{ itemId: 'i1', deadlineAt: tomorrow, accuracy: 'month' }] }),
    );

    expect(kindsOf(plan)).toEqual(['morning', 'evening']);
  });

  it('срок сегодня, полдень: вчерашний вечер и сегодняшнее утро уже позади', () => {
    const plan = planFor(
      input({
        now: new Date('2026-08-30T10:00:00.000Z'), // 13:00 МСК
        deadlines: [
          { itemId: 'i1', deadlineAt: new Date('2026-08-30T18:00:00.000Z'), accuracy: 'day' },
        ],
      }),
    );

    // Напоминать задним числом бессмысленно, и в прошлое задание не ставим.
    expect(plan.filter((one) => one.kind.startsWith('deadline_'))).toEqual([]);
  });

  it('дальний срок за горизонтом планирования сейчас не ставится', () => {
    const plan = planFor(
      input({
        deadlines: [
          { itemId: 'i1', deadlineAt: new Date('2026-09-20T09:00:00.000Z'), accuracy: 'day' },
        ],
      }),
    );

    expect(kindsOf(plan)).toEqual(['morning', 'evening']);
    expect(HORIZON_HOURS).toBeLessThan(24 * 7);
  });
});

describe('возврат к проекту (3.13)', () => {
  it('ставится в полдень, отдельным сообщением', () => {
    const plan = planFor(input({ staleProjects: ['p1'] }));
    const nudge = plan.find((one) => one.kind === 'project');

    expect(shown(nudge!.dueAt).slice(-5)).toBe(PROJECT_NUDGE_TIME);
    expect(nudge!.itemId).toBe('p1');
  });

  it('не сливается с утренней сводкой: разное время', () => {
    // Инвариант §13.9 — один вопрос на реплику. Вопрос про шаг проекта и
    // приглашение выгрузить мысли не могут ехать в одном сообщении.
    const plan = planFor(input({ staleProjects: ['p1'] }));
    const morning = plan.find((one) => one.kind === 'morning');
    const nudge = plan.find((one) => one.kind === 'project');

    expect(nudge!.dueAt.getTime()).not.toBe(morning!.dueAt.getTime());
  });
});

describe('тишина и выбор человека (3.17)', () => {
  /**
   * Регрессия, найденная на приёмке на живом пользователе: он выбрал на
   * онбординге утро в 07:00, а тишина по умолчанию 22:00–08:00 накрывала
   * его выбор целиком — утреннее не приходило бы никогда и молча.
   */
  it('выбранное человеком утро внутри тишины всё равно приходит', () => {
    const plan = planFor(input({ settings: { ...settings, morningTime: '07:00' } }));

    expect(kindsOf(plan)).toContain('morning');
  });

  it('и совсем раннее — тоже: он так сказал', () => {
    const plan = planFor(input({ settings: { ...settings, morningTime: '03:00' } }));

    expect(kindsOf(plan)).toContain('morning');
  });

  it('выбранный человеком поздний вечер приходит', () => {
    const plan = planFor(input({ settings: { ...settings, eveningTime: '23:00' } }));

    expect(kindsOf(plan)).toContain('evening');
  });

  it('тишина при этом не отменяется, а ужимается', () => {
    // Напоминание по сроку идёт по тем же временам, что и сводки, поэтому
    // проверяем на том, что тишина всё ещё что-то закрывает: срок в ночь
    // при обычных временах напоминания не даёт.
    const plan = planFor(
      input({
        settings: { ...settings, morningTime: '08:30', eveningTime: '02:00' },
        deadlines: [
          { itemId: 'i1', deadlineAt: new Date('2026-08-31T09:00:00.000Z'), accuracy: 'day' },
        ],
      }),
    );

    // Вечер в 02:00 человек выбрал сам — он проходит. А вот напоминание
    // накануне вечером о завтрашнем сроке встало бы на 02:00 сегодняшних
    // суток, то есть в прошлое, и не ставится по другой причине.
    expect(kindsOf(plan)).toContain('evening');
  });

  it('с выключенной тишиной проходит всё', () => {
    const plan = planFor(
      input({
        settings: { ...settings, morningTime: '03:00', quietHoursOn: false },
      }),
    );

    expect(kindsOf(plan)).toContain('morning');
  });

  it('вопрос о застрявшем проекте тишина по-прежнему может закрыть', () => {
    // Полдень — время, которое выбрали мы, а не человек. Если он растянул
    // тишину на день, вопрос не приходит.
    const plan = planFor(
      input({
        settings: { ...settings, quietFrom: '09:00', quietTo: '18:00' },
        staleProjects: ['p1'],
      }),
    );

    expect(kindsOf(plan)).not.toContain('project');
  });
});

describe('снижение частоты влияет на раскладку (3.17)', () => {
  const today = Math.floor(new Date('2026-08-30T00:00:00.000Z').getTime() / (24 * 60 * 60_000));

  it('десять молчаний: вчерашнее утреннее закрывает сегодняшнее', () => {
    const plan = planFor(input({ ignoredStreak: 10, lastMorningDay: today - 1 }));

    expect(kindsOf(plan)).toEqual(['evening']);
  });

  it('десять молчаний и неделя тишины: утреннее возвращается', () => {
    const plan = planFor(input({ ignoredStreak: 10, lastMorningDay: today - 7 }));

    expect(kindsOf(plan)).toContain('morning');
  });

  it('вечернее снижение частоты не касается', () => {
    // §11 говорит только про утренние. Вечерний итог — не приглашение к
    // разговору, а закрытие дня, и молчание на него не ответ.
    const plan = planFor(input({ ignoredStreak: 50, lastMorningDay: today }));

    expect(kindsOf(plan)).toEqual(['evening']);
  });
});

describe('пояса', () => {
  it.each([['Europe/Kaliningrad'], ['Europe/Moscow'], ['Asia/Yekaterinburg'], ['Asia/Kamchatka']])(
    '%s получает утреннее в своё местное время',
    (zone) => {
      const plan = planFor(input({ timeZone: zone, now: new Date('2026-08-29T20:00:00.000Z') }));
      const morning = plan.find((one) => one.kind === 'morning');

      expect(shown(morning!.dueAt, zone).slice(-5)).toBe('08:30');
    },
  );

  it('одно и то же местное время — разные моменты', () => {
    const moments = ['Europe/Kaliningrad', 'Asia/Kamchatka'].map((zone) => {
      const plan = planFor(input({ timeZone: zone, now: new Date('2026-08-29T20:00:00.000Z') }));
      return plan.find((one) => one.kind === 'morning')!.dueAt.getTime();
    });

    expect(moments[0]).not.toBe(moments[1]);
  });
});

describe('номер местного дня', () => {
  /**
   * Регрессия. Первая версия считала номер по моменту местной полуночи,
   * делённому на сутки. На переводе стрелок вперёд сутки короче на час,
   * две соседние полуночи попадают в один отрезок — и «через день» тихо
   * превращается в «сегодня», то есть в двойное напоминание.
   */
  it('соседние дни отличаются на единицу даже в ночь перевода стрелок', () => {
    const london = 'Europe/London';
    const before = localDayNumber(new Date('2026-03-28T12:00:00.000Z'), london);
    const during = localDayNumber(new Date('2026-03-29T12:00:00.000Z'), london);
    const after = localDayNumber(new Date('2026-03-30T12:00:00.000Z'), london);

    expect(during - before).toBe(1);
    expect(after - during).toBe(1);
  });

  it('момент один, а номер дня зависит от пояса', () => {
    const at = new Date('2026-08-30T22:30:00.000Z');

    expect(localDayNumber(at, 'Europe/Moscow') - localDayNumber(at, 'Europe/London')).toBe(1);
  });
});
