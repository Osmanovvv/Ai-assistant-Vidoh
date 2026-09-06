import { beforeEach, describe, expect, it } from 'vitest';

import { aiCalls } from '../../db/schema.js';
import { isAccessFailure, isOwnOutage, isTransientFailure } from '../../infra/errors.js';
import { SpendCeilingError } from '../../infra/failures.js';
import { testDb } from '../../test/db.js';
import { createSpendGuard, isSpendCeiling, type SpendNotice } from './spend-guard.js';

/**
 * Страж расхода на настоящей базе учёта (задача 3.79).
 *
 * **Что случилось без него.** За сутки 04.09.2026 прогоны сожгли 1 977 ₽
 * при плане 125 ₽ в день, а 05.09 Yandex ответил 403 на любой запрос:
 * деньги кончились. Узнали из отказа, когда бот уже встал.
 *
 * Здесь проверяется и то, что страж останавливает, и — не меньше — то,
 * чего он делать не должен: молчать при выключенных потолках, запирать
 * бота от собственной поломки, хоронить слова человека.
 */

const RUB = 1_000_000;
const NOW = new Date('2026-09-06T12:00:00.000Z');

/** Записывает вызов с заданной ценой и временем. */
async function spend(rubles: number, at: Date = NOW): Promise<void> {
  await testDb()
    .insert(aiCalls)
    .values({
      stage: 'classifier',
      model: 'yandex:yandexgpt/latest',
      costMicros: Math.round(rubles * RUB),
      costCurrency: 'rub',
      latencyMs: 100,
      ok: true,
      createdAt: at,
    });
}

/** Вызов, цену которого мы не знаем: счёт становится неполным. */
async function spendUnpriced(at: Date = NOW): Promise<void> {
  await testDb().insert(aiCalls).values({
    stage: 'classifier',
    model: 'неизвестная-модель',
    latencyMs: 100,
    ok: true,
    createdAt: at,
  });
}

const guardWith = (
  ceilings: { total?: number; daily?: number },
  extra: {
    warnShare?: number;
    onWarn?: (notice: SpendNotice) => void;
    now?: () => Date;
  } = {},
) =>
  createSpendGuard({
    db: testDb(),
    ceilings: {
      ...(ceilings.total === undefined
        ? {}
        : { total: { micros: ceilings.total * RUB, currency: 'rub' as const } }),
      ...(ceilings.daily === undefined
        ? {}
        : { daily: { micros: ceilings.daily * RUB, currency: 'rub' as const } }),
    },
    now: extra.now ?? ((): Date => NOW),
    ...(extra.warnShare === undefined ? {} : { warnShare: extra.warnShare }),
    ...(extra.onWarn === undefined ? {} : { onWarn: extra.onWarn }),
  });

beforeEach(async () => {
  await testDb().delete(aiCalls);
});

describe('потолки выключены', () => {
  it('страж не делает ничего и в базу не ходит', async () => {
    /**
     * Главное свойство: не задано ни одной суммы — поведение бота ровно
     * такое, как до стража. Проверяется тем, что базы у него нет вовсе:
     * обратись он к ней — упал бы.
     */
    const guard = createSpendGuard({
      db: undefined as never,
      ceilings: {},
      now: () => NOW,
    });

    await expect(guard.beforeCall()).resolves.toBeUndefined();
    expect(() => {
      guard.noteSpent(1000);
    }).not.toThrow();
    await expect(guard.report()).resolves.toEqual([]);
  });
});

describe('потолок за всё время', () => {
  it('под потолком пропускает', async () => {
    await spend(300);

    await expect(guardWith({ total: 1000 }).beforeCall()).resolves.toBeUndefined();
  });

  it('перейдён — останавливает и говорит, сколько и из чего', async () => {
    await spend(1200);

    await expect(guardWith({ total: 1000 }).beforeCall()).rejects.toThrow(
      /потолок расхода за всё время перейдён: 1200\.00 ₽ из 1000\.00 ₽/u,
    );
  });

  it('останавливает ДО обращения к модели, а не после', async () => {
    /**
     * Смысл всей задачи. Проверка стоит один запрос в базу; если бы она
     * шла после вызова, потолок узнавал бы о превышении, уже заплатив за
     * него, и на разгоне в шестнадцать раз это ничего не спасло бы.
     */
    await spend(1200);
    let called = false;

    const guard = guardWith({ total: 1000 });
    await expect(
      (async () => {
        await guard.beforeCall();
        called = true;
      })(),
    ).rejects.toThrow(SpendCeilingError);

    expect(called).toBe(false);
  });

  it('повторные проверки денег не тратят', async () => {
    // Досмотр берёт застрявшую выгрузку каждые полминуты. Если бы отказ
    // стоил обращения к модели, ожидание денег их же и сжигало бы.
    await spend(1200);
    const guard = guardWith({ total: 1000 });

    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(guard.beforeCall()).rejects.toThrow(SpendCeilingError);
    }

    const rows = await testDb().select().from(aiCalls);
    expect(rows).toHaveLength(1);
  });
});

describe('потолок за сутки', () => {
  it('вчерашний расход сегодняшний потолок не занимает', async () => {
    await spend(900, new Date('2026-09-05T12:00:00.000Z'));
    await spend(50);

    await expect(guardWith({ daily: 500 }).beforeCall()).resolves.toBeUndefined();
  });

  it('сегодняшний расход суточный потолок перекрывает', async () => {
    await spend(600);

    await expect(guardWith({ daily: 500 }).beforeCall()).rejects.toThrow(
      /за сутки перейдён: 600\.00 ₽ из 500\.00 ₽/u,
    );
  });

  it('суточный и общий работают независимо', async () => {
    // Вчера много, сегодня мало: общий потолок перейдён, суточный нет.
    await spend(900, new Date('2026-09-05T12:00:00.000Z'));
    await spend(10);

    await expect(guardWith({ total: 800, daily: 500 }).beforeCall()).rejects.toThrow(
      /за всё время/u,
    );
    await expect(guardWith({ daily: 500 }).beforeCall()).resolves.toBeUndefined();
  });
});

describe('предупреждение до остановки', () => {
  it('на пороге зовёт оповещение, но вызов пропускает', async () => {
    await spend(850);
    const notices: SpendNotice[] = [];

    await expect(
      guardWith({ total: 1000 }, { onWarn: (one) => notices.push(one) }).beforeCall(),
    ).resolves.toBeUndefined();

    expect(notices).toHaveLength(1);
    expect(notices[0]?.exceeded).toBe(false);
    expect(notices[0]?.window).toBe('all');
  });

  it('одно предупреждение на состояние, а не на каждый вызов', async () => {
    // Иначе один разбор из шести стадий даёт шесть одинаковых оповещений.
    await spend(850);
    const notices: SpendNotice[] = [];
    const guard = guardWith({ total: 1000 }, { onWarn: (one) => notices.push(one) });

    for (let attempt = 0; attempt < 4; attempt++) await guard.beforeCall();

    expect(notices).toHaveLength(1);
  });

  it('при превышении оповещение отдельное, со своим признаком', async () => {
    await spend(1200);
    const notices: SpendNotice[] = [];
    const guard = guardWith({ total: 1000 }, { onWarn: (one) => notices.push(one) });

    await expect(guard.beforeCall()).rejects.toThrow(SpendCeilingError);

    expect(notices).toHaveLength(1);
    expect(notices[0]?.exceeded).toBe(true);
  });
});

describe('чего страж делать не должен', () => {
  it('своя поломка бота не останавливает', async () => {
    /**
     * **Самая важная проверка здесь.** Сторож, который запирает дом,
     * когда сам сломался, хуже отсутствующего: он превращает свою мелкую
     * неполадку — моргнувшую базу, разъехавшуюся схему — в остановку
     * продукта. Поэтому при своей ошибке страж пропускает вызов.
     */
    const broken = createSpendGuard({
      db: {
        select: () => {
          throw new Error('база моргнула');
        },
      } as never,
      ceilings: { total: { micros: 1 * RUB, currency: 'rub' } },
      now: () => NOW,
    });

    await expect(broken.beforeCall()).resolves.toBeUndefined();
  });

  it('слова человека не теряются: превышение — временный сбой', () => {
    /**
     * Связь с задачей 3.72. Конвейер решает судьбу выгрузки по
     * `isTransientFailure`, а «попытку не тратить» — по `isOwnOutage`.
     * Окажись превышение постоянным сбоем — выгрузка умерла бы из-за
     * нашего бюджета, и слова человека пропали бы навсегда.
     */
    const error = new SpendCeilingError('потолок перейдён');

    expect(isTransientFailure(error)).toBe(true);
    expect(isOwnOutage(error)).toBe(true);
    expect(isSpendCeiling(error)).toBe(true);
    // И это не отказ в доступе: тексты оповещений разные.
    expect(isAccessFailure(error)).toBe(false);
  });

  it('неполный счёт превышения не выдумывает', async () => {
    // Один вызов без цены и мелкий расход: счёт неполон, но потолок
    // далеко. Останавливать нельзя — это была бы догадка.
    await spend(10);
    await spendUnpriced();

    await expect(guardWith({ total: 1000 }).beforeCall()).resolves.toBeUndefined();
  });

  it('отказные вызовы денег не занимают', async () => {
    // 403 не тарифится: у отказных строк цены нет, и потолок их не видит.
    await testDb().insert(aiCalls).values({
      stage: 'router',
      model: 'yandex:yandexgpt-lite/latest',
      latencyMs: 50,
      ok: false,
      error: 'модель ответила 403',
      createdAt: NOW,
    });

    await expect(guardWith({ total: 1 }).beforeCall()).resolves.toBeUndefined();
  });
});

describe('счёт между чтениями базы', () => {
  it('потраченное с последнего чтения учитывается сразу', async () => {
    /**
     * Кэш держит запрос пятнадцать секунд, и за это время прогон
     * набора успевает потратить сотни рублей. Поэтому страж складывает
     * то, что сам же и пропустил: кэш не «примерно», а точно.
     */
    await spend(900);
    const guard = guardWith({ total: 1000 });

    await expect(guard.beforeCall()).resolves.toBeUndefined();

    // Два вызова по 60 ₽ — база ещё не перечитана, но потолок уже занят.
    guard.noteSpent(60 * RUB);
    guard.noteSpent(60 * RUB);

    await expect(guard.beforeCall()).rejects.toThrow(SpendCeilingError);
  });

  it('отрицательное и нечисловое в счёт не идут', () => {
    const guard = guardWith({ total: 1000 });

    expect(() => {
      guard.noteSpent(-5_000_000);
      guard.noteSpent(Number.NaN);
    }).not.toThrow();
  });
});

describe('отчёт о расходе', () => {
  it('называет каждое окно, его расход и потолок', async () => {
    await spend(400, new Date('2026-09-05T12:00:00.000Z'));
    await spend(200);

    const notices = await guardWith({ total: 1000, daily: 500 }).report();

    expect(notices).toHaveLength(2);

    const all = notices.find((one) => one.window === 'all');
    const day = notices.find((one) => one.window === 'day');

    expect(all?.verdict.spentMicros).toBe(600 * RUB);
    expect(day?.verdict.spentMicros).toBe(200 * RUB);
    expect(all?.exceeded).toBe(false);
  });
});

/**
 * Находки встречной проверки 06.09.2026.
 *
 * Правку смотрели четыре независимые линзы, и три дефекта они нашли —
 * все такие, что страж выглядел работающим и не защищал. Каждый закрыт
 * тестом: находка без теста возвращается.
 */
describe('чтобы страж не притворялся работающим', () => {
  it('предупреждение приходит каждые сутки, а не один раз за жизнь процесса', async () => {
    /**
     * **Самая дорогая из находок.** Ключ памяти «о чём уже сказали» не
     * содержал дня, а бот живёт неделями. Значит со вторых суток ни
     * предупреждение на 80%, ни сообщение о перейдённом суточном потолке
     * не уходили никогда: во второй раз бот встал бы молча.
     */
    let moment = new Date('2026-09-06T12:00:00.000Z');
    const notices: SpendNotice[] = [];
    const guard = guardWith(
      { daily: 100 },
      { onWarn: (one) => notices.push(one), now: () => moment },
    );

    await spend(150, moment);
    await expect(guard.beforeCall()).rejects.toThrow(SpendCeilingError);
    expect(notices).toHaveLength(1);

    // Новые сутки, новый расход — и новое сообщение.
    moment = new Date('2026-09-07T12:00:00.000Z');
    await spend(150, moment);

    await expect(guard.beforeCall()).rejects.toThrow(SpendCeilingError);
    expect(notices.map((one) => one.window)).toEqual(['day', 'day']);
  });

  it('смена суток внутри окна кэша не даёт ложной остановки', async () => {
    /**
     * Кэш держит запрос пятнадцать секунд и сперва не знал, за какое
     * окно посчитан. Поэтому первые секунды новых суток суточный потолок
     * сравнивался со **вчерашней** суммой и останавливал бота, когда
     * денег на сегодня было полно.
     */
    let moment = new Date('2026-09-06T23:59:55.000Z');
    const guard = guardWith({ daily: 500 }, { now: () => moment });

    await spend(600, new Date('2026-09-06T12:00:00.000Z'));

    // Вчера потолок перейдён — останавливаем, и это верно.
    await expect(guard.beforeCall()).rejects.toThrow(SpendCeilingError);

    // Пять секунд спустя, но уже новые сутки: кэш свеж, а окно другое.
    moment = new Date('2026-09-07T00:00:00.000Z');
    await expect(guard.beforeCall()).resolves.toBeUndefined();
  });

  it('отказные вызовы не делают счёт «неполным» навсегда', async () => {
    /**
     * У отказа цены нет и быть не может: 403 не тарифится. Считались они
     * вместе с настоящей неизвестной ценой — и одного отказа за всё
     * время хватало, чтобы каждый прогон печатал «это нижняя оценка».
     * Предупреждение, которое горит всегда, не значит ничего.
     */
    await spend(100);
    await testDb().insert(aiCalls).values({
      stage: 'router',
      model: 'yandex:yandexgpt-lite/latest',
      latencyMs: 50,
      ok: false,
      error: 'модель ответила 403',
      createdAt: NOW,
    });

    const notices = await guardWith({ total: 1000 }).report();
    expect(notices[0]?.verdict.partial).toBe(false);
  });

  it('слепой потолок говорит о себе, а не молчит', async () => {
    /**
     * Ключ прайса — имя модели, каким его пишет провайдер, а `latest`
     * однажды переедет на другое поколение. В этот день все вызовы
     * станут бесценовыми, расход посчитается нулём, и потолок перестанет
     * срабатывать. Молча — то есть надеяться на него будет уже нельзя,
     * а знать об этом неоткуда.
     */
    for (let index = 0; index < 5; index++) await spendUnpriced();

    const notices: SpendNotice[] = [];
    const guard = guardWith({ total: 1 }, { onWarn: (one) => notices.push(one) });

    // Пропускает — расход-то нулевой, — но об этом сказано.
    await expect(guard.beforeCall()).resolves.toBeUndefined();

    expect(notices).toHaveLength(1);
    expect(notices[0]?.blind).toBe(true);
    expect(notices[0]?.exceeded).toBe(false);
  });

  it('сломавшийся страж слышен наружу, а не только в журнале', async () => {
    /**
     * Мёртвый страж и страж под потолком снаружи выглядят одинаково:
     * тихо. Ровно так и потеряли деньги 05.09.2026, поэтому своя поломка
     * должна доходить до мониторинга — при том что вызов она пропускает.
     */
    const broken: { window: string }[] = [];

    const guard = createSpendGuard({
      db: {
        select: () => {
          throw new Error('база моргнула');
        },
      } as never,
      ceilings: { total: { micros: 1 * RUB, currency: 'rub' } },
      now: () => NOW,
      onBroken: (window) => broken.push({ window }),
    });

    await expect(guard.beforeCall()).resolves.toBeUndefined();
    await expect(guard.beforeCall()).resolves.toBeUndefined();

    // Один раз на окно: сломанная база иначе даст сотню оповещений.
    expect(broken).toEqual([{ window: 'all' }]);
  });

  it('трата, доложенная пока идёт запрос, из счёта не стирается', async () => {
    /**
     * Счёт между чтениями обнулялся вслепую. Пока идёт запрос, конвейер
     * успевает потратить ещё, и `noteSpent` об этом докладывает —
     * обнуление стирало доложенное, и до следующего чтения страж считал
     * расход меньше настоящего.
     */
    await spend(400);
    const guard = guardWith({ total: 1000 });

    // Первое чтение: в базе 400 ₽, счёт между чтениями пуст.
    await guard.beforeCall();

    // Две траты по 400 ₽ — база их ещё не отдаёт, но страж их знает.
    guard.noteSpent(400 * RUB);
    guard.noteSpent(400 * RUB);

    // 400 в базе + 800 доложено = 1200 из 1000: потолок перейдён.
    await expect(guard.beforeCall()).rejects.toThrow(SpendCeilingError);
  });

  it('о слепоте говорится один раз на окно, а не на каждый вызов', async () => {
    await spendUnpriced();
    const notices: SpendNotice[] = [];
    const guard = guardWith({ total: 1000 }, { onWarn: (one) => notices.push(one) });

    for (let attempt = 0; attempt < 4; attempt++) await guard.beforeCall();

    expect(notices.filter((one) => one.blind === true)).toHaveLength(1);
  });
});
