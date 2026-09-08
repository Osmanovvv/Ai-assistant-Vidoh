import { beforeEach, describe, expect, it } from 'vitest';

import { testDb } from '../../test/db.js';
import { createChosenTopics, TOPIC_CHOICES } from '../onboarding/onboarding.service.js';
import { upsertUser } from '../users/users.repo.js';
import { appendTopics, createTopics, FALLBACK_TOPIC, listTopics } from './topics.repo.js';

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
  it('выбор из девяти сфер обрезается до предела', async () => {
    /**
     * Тот самый случай из находки: девять сфер на выбор против предела
     * три. Прежде создавались все девять.
     */
    const result = await createChosenTopics(testDb(), userId, [...TOPIC_CHOICES], 3);

    expect(result.created).toBe(3);
    expect(await names()).toHaveLength(3);
  });

  it('умолчание из кода тоже предел, а не «сколько попросили»', async () => {
    // Без реестра настроек работает умолчание — восемь. Девять сфер
    // помещаться в него не должны: до правки помещались.
    await createChosenTopics(testDb(), userId, [...TOPIC_CHOICES]);

    expect(await names()).toHaveLength(8);
  });

  it('тема по умолчанию остаётся даже под самым тесным пределом', async () => {
    /**
     * На «личном» §6.4 держит всё, что не попало ни в одну тему. Обрежь
     * список подряд — и оно бы не поместилось: записи ушли бы в первую
     * попавшуюся ветку, а увидеть это можно было бы только по чужой
     * жалобе.
     */
    await createChosenTopics(testDb(), userId, ['семья', 'здоровье', 'работа'], 1);

    expect(await names()).toEqual([FALLBACK_TOPIC]);

    const [only] = await listTopics(testDb(), userId);

    expect(only?.isDefault).toBe(true);
  });

  it('базовый набор при пустом ответе тоже под пределом', async () => {
    // Пустой ответ означает базовый набор §6.4 — пять сфер. Предел два
    // означает два, иначе «значение задаётся в настройках» неправда.
    const result = await createChosenTopics(testDb(), userId, [], 2);

    expect(result.fallback).toBe(true);
    expect(await names()).toHaveLength(2);
  });

  it('список короче предела не обрезается и не переставляется', async () => {
    // Обрезка не должна трогать обычный случай: порядок ветвей — это
    // порядок в списке чата, и тасовать его без просьбы человека нельзя.
    await createChosenTopics(testDb(), userId, ['семья', 'личное', 'работа'], 8);

    expect(await names()).toEqual(['семья', 'личное', 'работа']);
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
