import { beforeEach, describe, expect, it } from 'vitest';

import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import {
  appendTopics,
  createBaseTopics,
  createTopics,
  DEFAULT_TOPIC_NAMES,
  FALLBACK_TOPIC,
  listTopics,
  MAX_TOPICS,
} from './topics.repo.js';

/**
 * Предел числа тем действует на **оба** пути создания (§6.4, §15).
 *
 * §6.4 дословно: «Количество тем ограничено, значение задаётся в
 * настройках». §15 перечисляет «число тем» среди настроек панели.
 *
 * **Ревизия панели, находка 6.** Настройку читало только согласие
 * добавить сферу (`appendTopics`). Начальный набор шёл мимо:
 * `createChosenTopics` → `createTopics`, где предела не было ни
 * параметром, ни константой. Сфер на выбор девять, значит человек,
 * отметивший все, получал девять ветвей даже при умолчании восемь, а при
 * выставленных заказчицей трёх — те же девять. Панель показывала её
 * число, бот жил по чужому, и проверить это заказчице было нечем.
 *
 * Проверки идут против живой базы: обрезка меняет то, что уходит в
 * `insert`, а не то, что считается в памяти.
 */

let userId = '';

beforeEach(async () => {
  const user = await upsertUser(testDb(), { tgId: 777_001, firstName: 'Аня' });

  userId = user.id;
});

async function names(): Promise<readonly string[]> {
  return (await listTopics(testDb(), userId)).map((topic) => topic.name);
}

describe('предел числа тем на начальном наборе', () => {
  const NINE = [
    'семья',
    'здоровье',
    'работа',
    'покупки',
    'дом',
    'дети',
    'деньги',
    'учёба',
    'личное',
  ];

  it('девять сфер целиком обрезаются до предела', async () => {
    const created = await createTopics(
      testDb(),
      userId,
      NINE.map((name) => ({ name })),
      3,
    );

    expect(created).toBe(3);
    expect(await names()).toHaveLength(3);
  });

  it('умолчание из кода тоже предел, а не «сколько попросили»', async () => {
    const tooMany = [
      ...NINE,
      ...Array.from({ length: 5 }, (_unused, index) => `сфера ${String(index + 1)}`),
    ];

    expect(tooMany.length).toBeGreaterThan(MAX_TOPICS);

    await createTopics(
      testDb(),
      userId,
      tooMany.map((name) => ({ name })),
    );

    expect(await names()).toHaveLength(MAX_TOPICS);
  });

  it('тема по умолчанию остаётся даже под самым тесным пределом', async () => {
    // Базовый набор §6.4 под пределом один — одна тема, и это «личное»:
    // туда уходит всё, что не подошло ни к одной.
    await createBaseTopics(testDb(), userId, 1);

    expect(await names()).toEqual([FALLBACK_TOPIC]);

    const [only] = await listTopics(testDb(), userId);

    expect(only?.isDefault).toBe(true);
  });

  it('базовый набор на первой выгрузке тоже под пределом', async () => {
    // Базовый набор §6.4 — пять сфер. Предел два означает два, иначе
    // «значение задаётся в настройках» неправда.
    const created = await createBaseTopics(testDb(), userId, 2);

    expect(created).toBe(2);
    expect(await names()).toHaveLength(2);
  });

  it('базовый набор короче предела не обрезается и не переставляется', async () => {
    // Обрезка не должна трогать обычный случай: порядок ветвей — это
    // порядок в списке чата, и тасовать его без просьбы человека нельзя.
    await createBaseTopics(testDb(), userId, 8);

    expect(await names()).toEqual([...DEFAULT_TOPIC_NAMES]);
  });

  it('предел один и тот же на создании и на добавлении сферы', async () => {
    /**
     * Иначе человек получал бы разное число ветвей в зависимости от
     * того, каким путём они появились: восемь по опросу и девятую
     * согласием после него.
     */
    await createTopics(
      testDb(),
      userId,
      ['семья', 'здоровье', 'работа'].map((name) => ({ name })),
      3,
    );

    const added = await appendTopics(testDb(), userId, ['покупки'], 3);

    expect(added).toEqual({ added: [], limited: true });
    expect(await names()).toHaveLength(3);
  });
});
