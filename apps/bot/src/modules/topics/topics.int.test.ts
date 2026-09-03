import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { items, topics } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { defaultTexts } from '../../texts/index.js';
import { upsertUser } from '../users/users.repo.js';
import { FakeTopicGateway } from './fake-gateway.js';
import { buildSummary, itemsOfTopic, refreshSummary, refreshSummaries } from './summary.service.js';
import { appendTopics, archiveTopicsExcept, createTopics, listTopics } from './topics.repo.js';
import {
  ensureThread,
  forgetThread,
  moveItemToTopic,
  removeThread,
  topicByThread,
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
  await createTopics(
    testDb(),
    userId,
    names.map((name) => ({ name, isDefault: name === 'личное' })),
  );
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

    expect(gateway.created[0]).toEqual({ name: 'здоровье', iconEmojiId: 'icon-1' });
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

    await forgetThread(deps(gateway), created.threadId!);

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

    expect(text).toContain(defaultTexts.summary.header('здоровье'));
    expect(text).toContain('04.09');
    expect(text).toContain('— купить лекарство');
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

describe('закреплённая сводка', () => {
  it('первый раз отправляется и закрепляется', async () => {
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
    expect(gateway.pinned).toHaveLength(1);
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
    expect(gateway.pinned).toHaveLength(1);
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

describe('невыбранные сферы уходят в архив и возвращаются (задача 3.43)', () => {
  /**
   * Базовые сферы теперь появляются на первой выгрузке, до опроса. Значит
   * к шагу «какие сферы важны» у человека уже есть темы, которых он мог
   * не выбрать, — и его ответ обязан их убрать, иначе выбор пуст.
   */

  it('архивирует всё, кроме выбранного и темы по умолчанию', async () => {
    await seedTopics(['семья', 'здоровье', 'работа', 'покупки', 'личное']);
    await testDb().update(topics).set({ tgThreadId: 41 }).where(eq(topics.name, 'работа'));

    const archived = await archiveTopicsExcept(testDb(), userId, ['семья', 'здоровье']);

    expect(archived.map((topic) => topic.name).sort()).toEqual(['покупки', 'работа']);
    // Ветку архивной темы предстоит убрать из чата — её номер возвращается.
    expect(archived.find((topic) => topic.name === 'работа')?.tgThreadId).toBe(41);

    const alive = (await listTopics(testDb(), userId)).map((topic) => topic.name).sort();
    expect(alive).toEqual(['здоровье', 'личное', 'семья']);

    // В базе строка остаётся: записи темы никуда не деваются (§8.2).
    const row = await topicRow('работа');
    expect(row?.isArchived).toBe(true);
    expect(row?.tgThreadId).toBeNull();
  });

  it('«ё» и регистр в выборе не архивируют лишнего', async () => {
    await seedTopics(['семья', 'здоровье', 'личное']);

    const archived = await archiveTopicsExcept(testDb(), userId, ['Семья', 'Здоровье']);

    expect(archived).toHaveLength(0);
  });

  it('согласие добавить сферу возвращает её из архива, а не плодит двойника', async () => {
    // §6.4: невыбранная сфера ушла в архив, бот предложил её создать,
    // человек согласился. Прежде вставка упиралась в уникальность имени и
    // молча ничего не делала.
    await seedTopics(['семья', 'здоровье', 'покупки', 'личное']);
    await archiveTopicsExcept(testDb(), userId, ['семья', 'здоровье']);

    const result = await appendTopics(testDb(), userId, ['покупки']);

    expect(result.added).toEqual(['покупки']);
    const alive = await listTopics(testDb(), userId);
    expect(alive.map((topic) => topic.name).sort()).toEqual([
      'здоровье',
      'личное',
      'покупки',
      'семья',
    ]);
    // Одна строка, а не две: имя уникально на человека.
    const rows = await testDb().select().from(topics).where(eq(topics.name, 'покупки'));
    expect(rows).toHaveLength(1);
    // Вернувшаяся сфера встаёт в конец списка, как и любая добавленная.
    expect(alive.at(-1)?.name).toBe('покупки');
  });

  it('вернувшаяся сфера получает новую ветку при первой же сводке', async () => {
    await seedTopics(['семья', 'покупки', 'личное']);
    await testDb().update(topics).set({ tgThreadId: 77 }).where(eq(topics.name, 'покупки'));
    await archiveTopicsExcept(testDb(), userId, ['семья']);
    await appendTopics(testDb(), userId, ['покупки']);

    const gateway = new FakeTopicGateway();
    await refreshSummary(deps(gateway), {
      userId,
      chatId: CHAT,
      topicName: 'покупки',
      timeZone: MOSCOW,
    });

    expect(gateway.created.map((thread) => thread.name)).toEqual(['покупки']);
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
