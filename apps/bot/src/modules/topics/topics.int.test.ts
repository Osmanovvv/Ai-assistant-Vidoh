import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { items, topics } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { defaultTexts } from '../../texts/index.js';
import { upsertUser } from '../users/users.repo.js';
import { FakeTopicGateway } from './fake-gateway.js';
import { buildSummary, itemsOfTopic, refreshSummary, refreshSummaries } from './summary.service.js';
import { ensureTopics } from './topics.repo.js';
import {
  ensureThread,
  forgetThread,
  moveItemToTopic,
  removeThread,
  topicByThread,
  updateThreadIcon,
  updateThreadName,
} from './topics.service.js';

/**
 * Ветки личного чата и сводки тем (задачи 2.15–2.17).
 *
 * Проба 0.3 уже подтвердила, что настоящий API в ЛС работает. Здесь
 * проверяется наш код: ветка создаётся один раз, сводка правится вместо
 * отправки новой, пропавшая ветка не роняет бота, а выключенный режим тем
 * даёт работающий плоский режим.
 */

const logger = createLogger({ level: 'silent' });
const CHAT = 900;
const MOSCOW = 'Europe/Moscow';

let userId: string;

function deps(gateway: FakeTopicGateway) {
  return { db: testDb(), gateway, logger };
}

async function seedTopics(names: readonly string[]): Promise<void> {
  // «личное» становится темой по умолчанию само (`ensureTopics`).
  await ensureTopics(testDb(), userId, names);
}

async function topicRow(name: string) {
  const [row] = await testDb().select().from(topics).where(eq(topics.name, name));
  return row;
}

async function addItem(params: {
  readonly topic: string;
  readonly text: string;
  readonly deadlineAt?: Date | undefined;
  readonly status?: 'new' | 'done';
  readonly type?: 'TASK' | 'DESIRE' | 'IDEA' | 'INFO' | 'EMOTION';
}): Promise<string> {
  const [row] = await testDb()
    .insert(items)
    .values({
      userId,
      text: params.text,
      type: params.type ?? 'TASK',
      priority: 'SOON',
      topic: params.topic,
      sourceOrder: 0,
      status: params.status ?? 'new',
      deadlineAt: params.deadlineAt ?? null,
      deadlineAccuracy: params.deadlineAt === undefined ? null : 'day',
    })
    .returning({ id: items.id });

  return row!.id;
}

beforeEach(async () => {
  const user = await upsertUser(testDb(), { tgId: 900, firstName: 'Аня' });
  userId = user.id;
});

describe('ветка темы', () => {
  it('создаётся один раз и запоминается', async () => {
    await seedTopics(['здоровье', 'личное']);
    const gateway = new FakeTopicGateway();
    const topic = await topicRow('здоровье');

    const first = await ensureThread(deps(gateway), { topicId: topic!.id, chatId: CHAT });
    const second = await ensureThread(deps(gateway), { topicId: topic!.id, chatId: CHAT });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.threadId).toBe(first.threadId);
    expect(gateway.created).toHaveLength(1);

    // Идентификатор ветки живёт в базе и больше нигде (§8.2).
    expect((await topicRow('здоровье'))?.tgThreadId).toBe(first.threadId);
  });

  it('получает иконку из набора Telegram, а не произвольную', async () => {
    // Проба 0.3: произвольный эмодзи платформа не принимает, набор
    // ограничен. В коде живёт соответствие «сфера → эмодзи», а
    // идентификатор ищется по нему.
    await seedTopics(['здоровье']);
    const gateway = new FakeTopicGateway({ icons: new Map([['💊', 'icon-1']]) });

    await ensureThread(deps(gateway), { topicId: (await topicRow('здоровье'))!.id, chatId: CHAT });

    // Имя ветки — сфера с заглавной (правка заказчицы 30.09.2026).
    expect(gateway.created[0]).toEqual({ name: 'Здоровье', iconEmojiId: 'icon-1' });
  });

  it('без подходящей иконки ветка всё равно создаётся', async () => {
    // Отказываться от ветки из-за картинки глупо.
    await seedTopics(['бизнес']);
    const gateway = new FakeTopicGateway({ icons: new Map([['💊', 'icon-1']]) });

    const result = await ensureThread(deps(gateway), {
      topicId: (await topicRow('бизнес'))!.id,
      chatId: CHAT,
    });

    expect(result.created).toBe(true);
    expect(gateway.created[0]?.iconEmojiId).toBeUndefined();
  });

  describe('семья ❤️ и личное ⭐️ (выбор заказчицы 30.09.2026)', () => {
    // Так их пишет Telegram: со знаком начертания U+FE0F.
    const TELEGRAM = new Map([
      ['❤️', 'heart-id'],
      ['⭐️', 'star-id'],
    ]);

    it('новые ветки создаются с иконкой', async () => {
      await seedTopics(['семья', 'личное']);
      const gateway = new FakeTopicGateway({ icons: TELEGRAM });

      await ensureThread(deps(gateway), { topicId: (await topicRow('семья'))!.id, chatId: CHAT });
      await ensureThread(deps(gateway), { topicId: (await topicRow('личное'))!.id, chatId: CHAT });

      expect(gateway.created).toEqual([
        { name: 'Семья', iconEmojiId: 'heart-id' },
        { name: 'Личное', iconEmojiId: 'star-id' },
      ]);
    });

    it('знак начертания не мешает найти иконку: «⭐» без него — та же звезда', async () => {
      await seedTopics(['личное']);
      const gateway = new FakeTopicGateway({ icons: new Map([['⭐', 'star-id']]) });

      await ensureThread(deps(gateway), { topicId: (await topicRow('личное'))!.id, chatId: CHAT });

      expect(gateway.created[0]?.iconEmojiId).toBe('star-id');
    });

    it('у готовой ветки иконка ставится правкой ветки', async () => {
      await seedTopics(['семья']);
      const gateway = new FakeTopicGateway({ icons: TELEGRAM });
      const topicId = (await topicRow('семья'))!.id;
      const { threadId } = await ensureThread(deps(new FakeTopicGateway()), {
        topicId,
        chatId: CHAT,
      });

      const result = await updateThreadIcon(deps(gateway), { topicId, chatId: CHAT });

      expect(result).toBe('set');
      expect(gateway.iconsSet).toEqual([{ chatId: CHAT, threadId, iconEmojiId: 'heart-id' }]);
    });

    it('ветки ещё нет — править нечего, она получит иконку при создании', async () => {
      await seedTopics(['семья']);
      const gateway = new FakeTopicGateway({ icons: TELEGRAM });

      const result = await updateThreadIcon(deps(gateway), {
        topicId: (await topicRow('семья'))!.id,
        chatId: CHAT,
      });

      expect(result).toBe('no-thread');
      expect(gateway.iconsSet).toEqual([]);
    });

    it('сфера без иконки в наборе — не трогается', async () => {
      await seedTopics(['бизнес']);
      const topicId = (await topicRow('бизнес'))!.id;
      await ensureThread(deps(new FakeTopicGateway()), { topicId, chatId: CHAT });
      const gateway = new FakeTopicGateway({ icons: TELEGRAM });

      expect(await updateThreadIcon(deps(gateway), { topicId, chatId: CHAT })).toBe('no-icon');
      expect(gateway.iconsSet).toEqual([]);
    });

    it('готовая ветка переименовывается в сферу с заглавной (правка заказчицы 30.09.2026)', async () => {
      await seedTopics(['семья']);
      const topicId = (await topicRow('семья'))!.id;
      const { threadId } = await ensureThread(deps(new FakeTopicGateway()), {
        topicId,
        chatId: CHAT,
      });
      const gateway = new FakeTopicGateway();

      expect(await updateThreadName(deps(gateway), { topicId, chatId: CHAT })).toBe('set');
      expect(gateway.renamed).toEqual([{ chatId: CHAT, threadId, name: 'Семья' }]);
    });

    it('имя уже с заглавной — не трогается; ветки нет — тоже', async () => {
      await seedTopics(['ВБ заказы', 'семья']);
      const shouting = (await topicRow('ВБ заказы'))!.id;
      await ensureThread(deps(new FakeTopicGateway()), { topicId: shouting, chatId: CHAT });
      const gateway = new FakeTopicGateway();

      expect(await updateThreadName(deps(gateway), { topicId: shouting, chatId: CHAT })).toBe(
        'same',
      );
      expect(
        await updateThreadName(deps(gateway), {
          topicId: (await topicRow('семья'))!.id,
          chatId: CHAT,
        }),
      ).toBe('no-thread');
      expect(gateway.renamed).toEqual([]);
    });

    it('ветку удалили руками — не ошибка', async () => {
      await seedTopics(['семья']);
      const topicId = (await topicRow('семья'))!.id;
      const { threadId } = await ensureThread(deps(new FakeTopicGateway()), {
        topicId,
        chatId: CHAT,
      });
      const gateway = new FakeTopicGateway({
        icons: TELEGRAM,
        goneThreads: new Set([threadId ?? -1]),
      });

      expect(await updateThreadIcon(deps(gateway), { topicId, chatId: CHAT })).toBe('gone');
    });
  });

  it('выключенный режим тем даёт плоский режим, а не отказ', async () => {
    // §8.2: плоский режим резервный, но он должен работать.
    await seedTopics(['здоровье']);
    const gateway = new FakeTopicGateway({ topicsOff: true });

    const result = await ensureThread(deps(gateway), {
      topicId: (await topicRow('здоровье'))!.id,
      chatId: CHAT,
    });

    expect(result).toEqual({ threadId: undefined, created: false, flat: true });
    expect((await topicRow('здоровье'))?.tgThreadId).toBeNull();
  });

  it('пропавшая ветка забывается, а тема и записи остаются', async () => {
    // §17: человек удалил ветку руками. Архивировать тему нельзя — он
    // удалил ветку в чате, а не сферу жизни.
    await seedTopics(['здоровье', 'личное']);
    const gateway = new FakeTopicGateway();
    const topic = await topicRow('здоровье');

    const created = await ensureThread(deps(gateway), { topicId: topic!.id, chatId: CHAT });
    const itemId = await addItem({ topic: 'здоровье', text: 'к врачу' });

    await forgetThread(deps(gateway), userId, created.threadId!);

    const after = await topicRow('здоровье');
    expect(after?.tgThreadId).toBeNull();
    expect(after?.summaryMessageId).toBeNull();
    expect(after?.isArchived).toBe(false);

    const [item] = await testDb().select().from(items).where(eq(items.id, itemId));
    expect(item?.topic).toBe('здоровье');

    // И пересоздаётся тем же путём, что создавалась.
    const again = await ensureThread(deps(gateway), { topicId: topic!.id, chatId: CHAT });
    expect(again.created).toBe(true);
    expect(again.threadId).not.toBe(created.threadId);
  });

  it('чужую тему с тем же номером ветки не трогает', async () => {
    /**
     * Найдено ревизией второго этапа. Номер ветки — это `message_id`
     * служебного сообщения в личном чате: у каждого своя нумерация с
     * малых чисел, и ветка №12 у двух людей — обычное дело.
     *
     * Условие без владельца обнуляло ветку и сводку **всем**, у кого тот
     * же номер. Посторонний человек получал вторую ветку с тем же
     * названием, новую закреплённую сводку в ней, а старая оставалась в
     * чате с намертво замороженным списком дел — то самое, что §8.2
     * запрещает двумя строками.
     *
     * Схема указывала на это прямо: уникальна пара `user_id` и
     * `tg_thread_id`, а не номер сам по себе.
     */
    await seedTopics(['здоровье']);

    const stranger = await upsertUser(testDb(), { tgId: 902, firstName: 'Посторонний' });
    const shared = 12;

    // У обоих тема с одним и тем же номером ветки — так бывает в бою.
    await testDb()
      .update(topics)
      .set({ tgThreadId: shared, summaryMessageId: 77 })
      .where(and(eq(topics.userId, userId), eq(topics.name, 'здоровье')));

    await testDb()
      .insert(topics)
      .values({ userId: stranger.id, name: 'здоровье', tgThreadId: shared, summaryMessageId: 88 });

    await forgetThread(deps(new FakeTopicGateway()), userId, shared);

    /**
     * Свою строку читаем **по владельцу**, а не помощником `topicRow`:
     * тот выбирает по названию и при двух людях с темой «здоровье»
     * отдаёт произвольную. Ровно та же слепота, что и в самом дефекте, —
     * и она успела покраснеть на этой проверке, пока я её писал.
     */
    const [mine] = await testDb()
      .select()
      .from(topics)
      .where(and(eq(topics.userId, userId), eq(topics.name, 'здоровье')));

    expect(mine?.tgThreadId).toBeNull();
    expect(mine?.summaryMessageId).toBeNull();

    // …а у постороннего всё на месте.
    const [alien] = await testDb()
      .select()
      .from(topics)
      .where(and(eq(topics.userId, stranger.id), eq(topics.name, 'здоровье')));

    expect(alien?.tgThreadId).toBe(shared);
    expect(alien?.summaryMessageId).toBe(88);
  });
});

describe('тема по ветке (§8.1)', () => {
  it('находит тему, в ветке которой пришло сообщение', async () => {
    await seedTopics(['здоровье', 'покупки']);
    const gateway = new FakeTopicGateway();
    const health = await ensureThread(deps(gateway), {
      topicId: (await topicRow('здоровье'))!.id,
      chatId: CHAT,
    });

    const found = await topicByThread(testDb(), userId, health.threadId!);
    expect(found?.name).toBe('здоровье');
  });

  it('чужая ветка не находится', async () => {
    await seedTopics(['здоровье']);
    const other = await upsertUser(testDb(), { tgId: 901, firstName: 'Не Аня' });

    const gateway = new FakeTopicGateway();
    const thread = await ensureThread(deps(gateway), {
      topicId: (await topicRow('здоровье'))!.id,
      chatId: CHAT,
    });

    expect(await topicByThread(testDb(), other.id, thread.threadId!)).toBeUndefined();
  });
});

describe('перенос записи между темами', () => {
  it('переносит в существующую тему человека', async () => {
    await seedTopics(['здоровье', 'покупки', 'личное']);
    const itemId = await addItem({ topic: 'здоровье', text: 'купить лекарство' });

    const result = await moveItemToTopic(testDb(), {
      itemId,
      userId,
      topicName: 'покупки',
    });

    expect(result).toEqual({ moved: true, from: 'здоровье', to: 'покупки' });
    const [item] = await testDb().select().from(items).where(eq(items.id, itemId));
    expect(item?.topic).toBe('покупки');
  });

  it('перенос в ту же тему — не перенос', async () => {
    await seedTopics(['здоровье']);
    const itemId = await addItem({ topic: 'здоровье', text: 'к врачу' });

    expect(await moveItemToTopic(testDb(), { itemId, userId, topicName: 'Здоровье' })).toEqual({
      moved: false,
      from: 'здоровье',
      to: 'здоровье',
    });
  });

  it('в несуществующую тему не переносит', async () => {
    // §6.4 запрещает создавать темы без спроса, а перенос в отсутствующую
    // создал бы её именем в поле записи — тихо и мимо всех правил.
    await seedTopics(['здоровье']);
    const itemId = await addItem({ topic: 'здоровье', text: 'к врачу' });

    await expect(
      moveItemToTopic(testDb(), { itemId, userId, topicName: 'бизнес' }),
    ).rejects.toThrow(/бизнес/u);
  });

  it('чужую запись не переносит', async () => {
    await seedTopics(['здоровье', 'покупки']);
    const itemId = await addItem({ topic: 'здоровье', text: 'к врачу' });
    const other = await upsertUser(testDb(), { tgId: 902, firstName: 'Не Аня' });

    await expect(
      moveItemToTopic(testDb(), { itemId, userId: other.id, topicName: 'покупки' }),
    ).rejects.toThrow();
  });
});

describe('текст сводки', () => {
  it('заголовок — просто название темы, без «что здесь есть» (правка заказчицы 29.09.2026)', () => {
    const text = buildSummary({
      topicName: 'семья',
      items: [{ text: 'Написать мужу список продуктов', deadlineAt: null } as never],
      texts: defaultTexts,
      timeZone: MOSCOW,
    });

    // С заглавной (правка заказчицы 30.09.2026).
    expect(text).toBe('Семья\n\n— Написать мужу список продуктов');
    expect(text).not.toContain('что здесь есть');
  });

  it('заголовок, строки и дата', () => {
    const text = buildSummary({
      topicName: 'здоровье',
      items: [
        {
          text: 'к врачу',
          deadlineAt: new Date('2026-09-03T21:00:00.000Z'),
        } as never,
        { text: 'купить лекарство', deadlineAt: null } as never,
      ],
      texts: defaultTexts,
      timeZone: MOSCOW,
    });

    expect(text.split('\n')[0]).toBe('Здоровье');
    expect(text).toContain('04.09');
    expect(text).toContain('— купить лекарство');
  });

  it('неточный срок — словами карточки, а не числом (прогон 17.09.2026)', () => {
    /**
     * Бой: «— записаться к стоматологу · 21.09» и «— В октябре пройти
     * диспансеризацию · 21.09», а карточка тех же записей говорит «Срок:
     * на неделе с 21.09» и «в октябре». Список ветки обязан говорить то
     * же, что карточка, — иначе число читается как день.
     */
    const text = buildSummary({
      topicName: 'здоровье',
      items: [
        {
          text: 'На следующей неделе записаться к стоматологу',
          deadlineAt: new Date('2026-09-20T21:00:00.000Z'),
          deadlineAccuracy: 'week',
        } as never,
        {
          text: 'В октябре пройти диспансеризацию',
          deadlineAt: new Date('2026-09-30T21:00:00.000Z'),
          deadlineAccuracy: 'month',
        } as never,
        {
          text: 'В пятницу надо забрать справку из поликлиники',
          deadlineAt: new Date('2026-09-17T21:00:00.000Z'),
          deadlineAccuracy: 'day',
        } as never,
      ],
      texts: defaultTexts,
      timeZone: MOSCOW,
    });

    expect(text).toContain('— Записаться к стоматологу · на неделе с 21.09');
    expect(text).toContain('— Пройти диспансеризацию · в октябре');
    // Срезанное начало — с заглавной, как в карточке и в списке дня.
    expect(text).toContain('— Надо забрать справку из поликлиники · 18.09');
  });

  it('пустая тема говорит о пустоте, а не молчит', () => {
    const text = buildSummary({
      topicName: 'покупки',
      items: [],
      texts: defaultTexts,
      timeZone: MOSCOW,
    });

    expect(text).toContain(defaultTexts.summary.empty);
  });

  it('в сводке нет ни одного вопроса', () => {
    // §13.9 и инвариант 10: сводка — список, а не разговор.
    const text = buildSummary({
      topicName: 'здоровье',
      items: [{ text: 'к врачу', deadlineAt: null } as never],
      texts: defaultTexts,
      timeZone: MOSCOW,
    });

    expect(text).not.toContain('?');
  });

  it('длинный список урезается с честным остатком', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      text: `дело ${String(index)}`,
      deadlineAt: null,
    })) as never[];

    const text = buildSummary({
      topicName: 'работа',
      items: many,
      texts: defaultTexts,
      timeZone: MOSCOW,
    });

    expect(text).toContain('дело 14');
    expect(text).not.toContain('дело 15');
    expect(text).toContain(defaultTexts.summary.more(5));
  });
});

describe('сводка без закрепа (заказчица, 16.09.2026)', () => {
  /**
   * §8.2 её ТЗ держал в ветке одно закреплённое сообщение-сводку. По видео
   * она отказалась от закрепов: «отдельные закрепления — не показывать;
   * человек должен видеть результат, а не внутреннюю механику». Сводка
   * остаётся первым сообщением ветки и правится на месте — закреплять её
   * незачем, а полоска «Закреплённое сообщение #4» и строки «закрепил(а)»
   * уходят вместе с закрепом.
   */
  it('первый раз отправляется — и не закрепляется', async () => {
    await seedTopics(['здоровье']);
    const gateway = new FakeTopicGateway();
    await addItem({ topic: 'здоровье', text: 'к врачу' });

    const result = await refreshSummary(deps(gateway), {
      userId,
      chatId: CHAT,
      topicName: 'здоровье',
      timeZone: MOSCOW,
    });

    expect(result).toEqual({ sent: true, edited: false, skipped: false });
    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]?.threadId).toBe((await topicRow('здоровье'))?.tgThreadId);
    expect((await topicRow('здоровье'))?.summaryMessageId).not.toBeNull();
  });

  it('десять изменений дают одно сообщение, а не десять', async () => {
    // Условие готовности задачи 2.16. Лента темы не должна превращаться
    // в свалку (§8.2).
    await seedTopics(['покупки']);
    const gateway = new FakeTopicGateway();

    for (let index = 0; index < 10; index++) {
      await addItem({ topic: 'покупки', text: `дело ${String(index)}` });
      await refreshSummary(deps(gateway), {
        userId,
        chatId: CHAT,
        topicName: 'покупки',
        timeZone: MOSCOW,
      });
    }

    expect(gateway.sent).toHaveLength(1);
    expect(gateway.edited).toHaveLength(9);
  });

  it('«менять нечего» не считается сбоем', async () => {
    // Настоящий Telegram отвечает на правку тем же текстом отказом 400.
    await seedTopics(['покупки']);
    const gateway = new FakeTopicGateway({ rejectUnchangedEdits: true });
    await addItem({ topic: 'покупки', text: 'молоко' });

    await refreshSummary(deps(gateway), {
      userId,
      chatId: CHAT,
      topicName: 'покупки',
      timeZone: MOSCOW,
    });
    const second = await refreshSummary(deps(gateway), {
      userId,
      chatId: CHAT,
      topicName: 'покупки',
      timeZone: MOSCOW,
    });

    expect(second).toEqual({ sent: false, edited: false, skipped: true });
  });

  it('удалённая человеком сводка отправляется заново', async () => {
    await seedTopics(['покупки']);
    const gateway = new FakeTopicGateway();
    await addItem({ topic: 'покупки', text: 'молоко' });

    await refreshSummary(deps(gateway), {
      userId,
      chatId: CHAT,
      topicName: 'покупки',
      timeZone: MOSCOW,
    });

    const messageId = (await topicRow('покупки'))!.summaryMessageId!;
    const withGone = new FakeTopicGateway({ goneMessages: new Set([messageId]) });

    const result = await refreshSummary(deps(withGone), {
      userId,
      chatId: CHAT,
      topicName: 'покупки',
      timeZone: MOSCOW,
    });

    expect(result.sent).toBe(true);
    expect((await topicRow('покупки'))?.summaryMessageId).not.toBe(messageId);
  });

  it('закрытые записи в сводку не идут', async () => {
    await seedTopics(['покупки']);
    const gateway = new FakeTopicGateway();
    await addItem({ topic: 'покупки', text: 'молоко' });
    await addItem({ topic: 'покупки', text: 'уже купила', status: 'done' });

    await refreshSummary(deps(gateway), {
      userId,
      chatId: CHAT,
      topicName: 'покупки',
      timeZone: MOSCOW,
    });

    expect(gateway.sent[0]?.text).toContain('молоко');
    expect(gateway.sent[0]?.text).not.toContain('уже купила');
    expect(await itemsOfTopic(testDb(), userId, 'покупки')).toHaveLength(1);
  });

  it('при выключенном режиме тем сводок нет, но и отказа нет', async () => {
    await seedTopics(['покупки']);
    const gateway = new FakeTopicGateway({ topicsOff: true });
    await addItem({ topic: 'покупки', text: 'молоко' });

    const result = await refreshSummary(deps(gateway), {
      userId,
      chatId: CHAT,
      topicName: 'покупки',
      timeZone: MOSCOW,
    });

    expect(result.skipped).toBe(true);
    expect(gateway.writes).toBe(0);
  });

  it('несколько тем обновляются за один заход, каждая по одному разу', async () => {
    await seedTopics(['здоровье', 'покупки']);
    const gateway = new FakeTopicGateway();
    await addItem({ topic: 'здоровье', text: 'к врачу' });
    await addItem({ topic: 'покупки', text: 'молоко' });

    const touched = await refreshSummaries(deps(gateway), {
      userId,
      chatId: CHAT,
      // Дубли в списке — обычное дело: две записи одной темы в выгрузке.
      topicNames: ['здоровье', 'покупки', 'здоровье'],
      timeZone: MOSCOW,
    });

    expect(touched).toBe(2);
    expect(gateway.sent).toHaveLength(2);
  });

  it('отказ на одной теме не отменяет остальные', async () => {
    await seedTopics(['здоровье', 'покупки']);
    const gateway = new FakeTopicGateway();

    // Ветка «здоровья» уже есть и уже пропала.
    const health = await ensureThread(deps(gateway), {
      topicId: (await topicRow('здоровье'))!.id,
      chatId: CHAT,
    });
    const broken = new FakeTopicGateway({ goneThreads: new Set([health.threadId!]) });

    await addItem({ topic: 'здоровье', text: 'к врачу' });
    await addItem({ topic: 'покупки', text: 'молоко' });

    const touched = await refreshSummaries(deps(broken), {
      userId,
      chatId: CHAT,
      topicNames: ['здоровье', 'покупки'],
      timeZone: MOSCOW,
    });

    expect(touched).toBe(1);
    expect(broken.sent.map((message) => message.text.includes('молоко'))).toContain(true);
  });
});

describe('темп обращений к Telegram', () => {
  /** Считает ожидания вместо того, чтобы ждать по-настоящему. */
  function pacing(gateway: FakeTopicGateway) {
    const waited: number[] = [];
    return {
      waited,
      deps: {
        db: testDb(),
        gateway,
        logger,
        pauseMs: 400,
        sleep: (ms: number) => {
          waited.push(ms);
          return Promise.resolve();
        },
      },
    };
  }

  it('между темами есть пауза: залп в конце онбординга Telegram обрежет', async () => {
    // Девять сфер — это девять веток, девять сводок и девять закреплений.
    // Двадцать семь обращений подряд платформа не пустит.
    await seedTopics(['семья', 'здоровье', 'покупки']);
    const gateway = new FakeTopicGateway();
    const { waited, deps: paced } = pacing(gateway);

    await refreshSummaries(paced, {
      userId,
      chatId: CHAT,
      topicNames: ['семья', 'здоровье', 'покупки'],
      timeZone: MOSCOW,
    });

    // Пауза между темами, но не перед первой и не после последней.
    expect(waited).toEqual([400, 400]);
    expect(gateway.sent).toHaveLength(3);
  });

  it('на просьбу подождать ждёт ровно столько, сколько сказано, и повторяет', async () => {
    // 429 — не поломка, а просьба сбавить темп. Угадывать тут нечего:
    // Telegram присылает число.
    await seedTopics(['покупки']);
    const gateway = new FakeTopicGateway({ throttleFirst: { times: 1, retryAfterSec: 3 } });
    const { waited, deps: paced } = pacing(gateway);

    const touched = await refreshSummaries(paced, {
      userId,
      chatId: CHAT,
      topicNames: ['покупки'],
      timeZone: MOSCOW,
    });

    expect(waited).toEqual([3000]);
    expect(touched).toBe(1);
    expect(gateway.sent).toHaveLength(1);
  });

  it('залп из девяти сфер идёт с паузами между темами и без повторов', async () => {
    const chosen = [
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
    await seedTopics(chosen);
    const gateway = new FakeTopicGateway();
    const { waited, deps: paced } = pacing(gateway);

    const touched = await refreshSummaries(paced, {
      userId,
      chatId: CHAT,
      topicNames: chosen,
      timeZone: MOSCOW,
    });

    expect(touched).toBe(chosen.length);
    expect(gateway.sent).toHaveLength(chosen.length);
    // Ни одной правки: повтора темы не было, сводка отправлена один раз.
    expect(gateway.edited).toHaveLength(0);
    // Ожидания — только паузы между темами, ни одной просьбы Telegram.
    expect(waited).toEqual(Array.from({ length: chosen.length - 1 }, () => 400));
  });

  it('если и после паузы отказ — тема пропускается, остальные идут', async () => {
    await seedTopics(['покупки', 'здоровье']);
    const gateway = new FakeTopicGateway({ throttleFirst: { times: 10, retryAfterSec: 1 } });
    const { deps: paced } = pacing(gateway);

    const touched = await refreshSummaries(paced, {
      userId,
      chatId: CHAT,
      topicNames: ['покупки', 'здоровье'],
      timeZone: MOSCOW,
    });

    expect(touched).toBe(0);
    // Обе темы попробованы, ни одна не уронила заход.
    expect(gateway.sent).toHaveLength(0);
  });
});

describe('удаление ветки не оставляет сирот (задача 3.46)', () => {
  const noSleep = (): Promise<void> => Promise.resolve();

  it('«подождите» от Telegram — пауза и повтор, ветка удалена', async () => {
    // Иначе ветка осталась бы в чате навсегда: в базе её уже нет, а
    // перечислить темы чата Bot API не умеет — ровно сирота от 29 августа.
    const gateway = new FakeTopicGateway({ throttleDeletesFirst: { times: 1, retryAfterSec: 2 } });
    const waited: number[] = [];

    const outcome = await removeThread(
      {
        ...deps(gateway),
        sleep: (ms) => {
          waited.push(ms);
          return noSleep();
        },
      },
      { chatId: CHAT, threadId: 501 },
    );

    expect(outcome).toBe('deleted');
    expect(waited).toEqual([2000]);
    expect(gateway.deletedThreads.map((one) => one.threadId)).toEqual([501]);
  });

  it('ветки уже нет — это сделанное, а не отказ', async () => {
    const gateway = new FakeTopicGateway({ goneThreads: new Set([502]) });

    await expect(removeThread(deps(gateway), { chatId: CHAT, threadId: 502 })).resolves.toBe(
      'gone',
    );
  });

  it('второе «подождите» подряд уже не глотается', async () => {
    // Один повтор, не цикл: если и он упёрся, темп надо снижать не здесь.
    const gateway = new FakeTopicGateway({ throttleDeletesFirst: { times: 2, retryAfterSec: 1 } });

    await expect(
      removeThread({ ...deps(gateway), sleep: noSleep }, { chatId: CHAT, threadId: 503 }),
    ).rejects.toThrow();
  });

  it('чужой отказ уходит наверх, а не глотается', async () => {
    const gateway = new FakeTopicGateway();
    const broken: typeof gateway = Object.assign(Object.create(gateway) as typeof gateway, {
      deleteThread: () => Promise.reject(new Error('сеть оборвалась')),
    });

    await expect(removeThread(deps(broken), { chatId: CHAT, threadId: 504 })).rejects.toThrow(
      'сеть оборвалась',
    );
  });
});

describe('эмоции в сводку не попадают (задача 3.48)', () => {
  /**
   * §13.7: «эмоция распознаётся как отдельный тип, но **не создаёт
   * записи**». У нас она хранится — из неё бот понимает состояние, и она
   * входит в выгрузку данных §16, — но показывать её человеку пунктом
   * списка нельзя.
   *
   * Найдено 03.09.2026 на живой сводке: в ветке «личное» строкой висело
   * «Я уже задолбался всё это в голове держать» наравне с «позвонить в
   * банк». Решение заказчика: убрать из сводок только эмоции, желания и
   * замыслы оставить.
   */

  it('эмоция не показывается, а дело, желание и замысел — да', async () => {
    await seedTopics(['личное']);
    await addItem({ topic: 'личное', text: 'Позвонить в банк' });
    await addItem({ topic: 'личное', text: 'Хочу выучить испанский', type: 'DESIRE' });
    await addItem({ topic: 'личное', text: 'Может быть, стеллаж на балкон', type: 'IDEA' });
    await addItem({ topic: 'личное', text: 'Садик оплачивается пятого', type: 'INFO' });
    await addItem({
      topic: 'личное',
      text: 'Задолбался всё это держать в голове',
      type: 'EMOTION',
    });

    const shown = await itemsOfTopic(testDb(), userId, 'личное');

    expect(shown.map((item) => item.text)).toEqual([
      'Позвонить в банк',
      'Хочу выучить испанский',
      'Может быть, стеллаж на балкон',
      'Садик оплачивается пятого',
    ]);
  });

  it('в тексте сводки эмоции нет', async () => {
    await seedTopics(['личное']);
    await addItem({ topic: 'личное', text: 'Позвонить в банк' });
    await addItem({ topic: 'личное', text: 'Я на нуле совсем', type: 'EMOTION' });

    const gateway = new FakeTopicGateway();
    await refreshSummary(deps(gateway), {
      userId,
      chatId: CHAT,
      topicName: 'личное',
      timeZone: MOSCOW,
    });

    const text = gateway.sent[0]?.text ?? '';
    expect(text).toContain('Позвонить в банк');
    expect(text).not.toContain('на нуле');
  });

  it('сфера из одной эмоции выглядит пустой, а не заполненной', async () => {
    // Иначе человек открыл бы ветку и увидел там свою же жалобу.
    await seedTopics(['личное']);
    await addItem({ topic: 'личное', text: 'Устала от всего этого', type: 'EMOTION' });

    const gateway = new FakeTopicGateway();
    await refreshSummary(deps(gateway), {
      userId,
      chatId: CHAT,
      topicName: 'личное',
      timeZone: MOSCOW,
    });

    expect(gateway.sent[0]?.text ?? '').toContain(defaultTexts.summary.empty);
  });

  it('эмоция при этом остаётся в базе: из неё бот понимает состояние', async () => {
    await seedTopics(['личное']);
    const id = await addItem({ topic: 'личное', text: 'Я на нуле совсем', type: 'EMOTION' });

    const [row] = await testDb().select().from(items).where(eq(items.id, id));
    expect(row?.type).toBe('EMOTION');
    expect(row?.status).toBe('new');
  });
});
