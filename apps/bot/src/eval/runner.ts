import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import { aiCalls, batches, items, messagesRaw, topics, users } from '../db/schema.js';
import type { AiClientDeps } from '../modules/ai/client.js';
import type { ClassifiedItems } from '../modules/ai/schemas/classifier.js';
import type { ExtractedUnits } from '../modules/ai/schemas/extractor.js';
import { attachMessageToBatch } from '../modules/buffer/buffer.service.js';
import type { ClassifiedItem } from '../modules/classifier/classifier.service.js';
import type { EmbeddingProvider } from '../modules/embedder/providers/types.js';
import { createDumpHandler, type PipelineEvent } from '../modules/pipeline/dump.handler.js';
import type { StatusSender } from '../modules/presenter/status.service.js';
import type { RecurrenceRule } from '../modules/recurrence/recurrence.js';
import { SettingsRegistry } from '../modules/settings/settings.repo.js';
import { MockSpeechProvider } from '../modules/speech/providers/mock.js';
import { upsertUser } from '../modules/users/users.repo.js';
import { defaultTexts } from '../texts/index.js';
import type { EvalCase } from './dataset.js';
import { match, type MatchResult } from './matcher.js';

/**
 * Прогон одного случая набора (задача 2.19) — **через боевой обработчик
 * выгрузки**, а не своей копией конвейера (20.09.2026).
 *
 * До этого стенд собирал путь сам: маршрутизатор → извлечение →
 * классификация. Шесть раз он из-за этого мерил не то, что работает в
 * бою; последний случай — четыре «потери» из восьми на живом наборе были
 * отрезками, которые бой возвращает в разбор вторым проходом резолвера,
 * а стенд считал пропавшими. Своя копия пути всегда отстаёт от боя,
 * потому что бой правят, а копию — когда вспомнят.
 *
 * Теперь случай идёт так же, как сообщение человека: заводится
 * пользователь стенда с часовым поясом и сферами случая, его сообщение
 * ложится в выгрузку, выгрузку разбирает `createDumpHandler` с теми же
 * зависимостями, что в бою, и сравнивается **то, что легло в базу**.
 * Внутренности — отрезки, единицы, сырой ответ классификации — стенд
 * узнаёт наблюдателем конвейера, а не пересчитывает.
 *
 * Цена: там, где бой зовёт резолвер (правки, отметки), стенд зовёт его
 * тоже. Это и есть замер боя; дешевле было бы мерить не бой.
 */

/**
 * След разбора: что дошло до каждого этапа (прогон 17.09.2026).
 *
 * Отчёт хранил только числа, и когда правило названного месяца не
 * сработало на живой расшифровке, объяснить промах было нечем: слова
 * единицы, текст модели и её цитата срока нигде не оставались. След
 * пишется рядом с отчётом и читается руками — в замеры не идёт.
 */
export interface CaseTrace {
  /** Вход извлечения — отрезки `DUMP`, склеенные как в бою. */
  readonly dumpText: string;
  readonly units: readonly ExtractedUnits['units'][number][];
  /** Ответ классификации до правок кода. */
  readonly fromModel: readonly ClassifiedItems['items'][number][];
  /** Записи после правок кода классификации. */
  readonly items: readonly ClassifiedItem[];
}

export interface RoutedSegment {
  readonly intent: string;
  readonly text: string;
}

export interface CaseOutcome {
  readonly id: string;
  readonly note: string;
  /** Пояс человека: без него дату срока не с чем сравнивать. */
  readonly timeZone: string;
  readonly result: MatchResult;
  /** §13.7: сработал ли кризисный контур и ожидалось ли это. */
  readonly crisis: { readonly detected: boolean; readonly expected: boolean };
  /** Разбор не удался целиком — считается отдельно от промахов. */
  readonly failed?: string | undefined;
  readonly promptVersions: {
    readonly router?: string | undefined;
    readonly extractor?: string | undefined;
    readonly classifier?: string | undefined;
  };
  /** Есть только у случая, дошедшего до записей. */
  readonly trace?: CaseTrace | undefined;
  /**
   * Отрезки маршрутизатора — у всякого случая, где он ответил
   * (прогон 20.09.2026).
   *
   * След начинается с `dumpText`, а потери случаются раньше: отрезок
   * ушёл в `PATCH`, склеился с соседним, пропал. На живом наборе так
   * потерялись три единицы из восьми, и объяснить их без повторного
   * платного прогона было нечем. Поэтому отрезки хранятся и тогда, когда
   * до записей не дошло, — именно тогда они и нужны.
   */
  readonly routed?: readonly RoutedSegment[] | undefined;
}

export interface RunnerDeps {
  readonly ai: AiClientDeps;
  /** Лёгкая модель для маршрутизатора, если она отличается (задача 2.4). */
  readonly aiLight?: AiClientDeps | undefined;
  /** Вектора — как в бою: отсев повторов и кандидаты резолвера. */
  readonly embedder?: EmbeddingProvider | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * Пользователи стенда: свой на каждый случай, заводится заново перед
 * каждым прогоном.
 *
 * Идентификаторы заведомо не заняты живыми людьми — у Telegram таких не
 * бывает. Свой на случай, а не один на всех: у случая своя обстановка
 * (пояс, сферы), а записи прошлого случая стали бы кандидатами резолвера
 * для следующего — чего в бою у этих выгрузок не было.
 */
const STAND_TG_BASE = 999_000_700;
const STAND_TG_LIMIT = 999_000_999;
const STAND_CHAT = 999_000_700;

/** Цепочка причин ошибки — в одну строку, как в прежнем прогонщике. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'неизвестный отказ';
}

/** Пользователь стенда для случая: чистый, с поясом и сферами случая. */
async function standUser(deps: RunnerDeps, item: EvalCase, index: number): Promise<string> {
  const db = deps.ai.db;
  const tgId = STAND_TG_BASE + index;

  if (tgId > STAND_TG_LIMIT) {
    throw new Error(
      `набор больше ${String(STAND_TG_LIMIT - STAND_TG_BASE + 1)} случаев — не поместился в пользователей стенда`,
    );
  }

  /**
   * Прежний пользователь этого случая удаляется целиком — с записями,
   * выгрузками, сферами: каскад по `users.id`. Учёт расхода при этом
   * остаётся (у `ai_calls` связь гасится в `null`), и цена прогона по
   * нему считается как прежде. Только пользователи стенда: у живого
   * человека такого `tg_id` быть не может.
   */
  await db.delete(users).where(eq(users.tgId, tgId));

  const user = await upsertUser(db, { tgId, firstName: `стенд ${item.id}` });
  await db.update(users).set({ timezone: item.timeZone }).where(eq(users.id, user.id));

  await db.insert(topics).values(
    item.topics.map((name, order) => ({
      userId: user.id,
      name,
      sortOrder: order,
      isDefault: name === item.defaultTopic,
    })),
  );

  return user.id;
}

/** Сообщение случая — в выгрузку, как от человека. */
async function batchOf(
  deps: RunnerDeps,
  userId: string,
  item: EvalCase,
  index: number,
  now: Date,
): Promise<typeof batches.$inferSelect> {
  const db = deps.ai.db;
  // Номер сообщения — свой на каждый прогон: пара (чат, сообщение) уникальна.
  const messageNumber = now.getTime() % 1_000_000_000;

  const [message] = await db
    .insert(messagesRaw)
    .values({
      userId,
      updateId: messageNumber,
      tgChatId: STAND_CHAT + index,
      tgMessageId: messageNumber,
      kind: 'text',
      text: item.text,
      receivedAt: now,
    })
    .returning({ id: messagesRaw.id });

  if (message === undefined) throw new Error('сообщение случая не легло в базу');

  const attached = await attachMessageToBatch(db, { userId, messageId: message.id, now });

  // Как очередь: выгрузка берётся в работу. Не через очередь, потому что
  // той нужен Redis, а стенду — нет.
  const [batch] = await db
    .update(batches)
    .set({ status: 'processing', processingAt: now })
    .where(eq(batches.id, attached.batchId))
    .returning();

  if (batch === undefined) throw new Error('выгрузка случая не нашлась');

  return batch;
}

/** Отправитель, который запоминает сказанное человеку — для кризиса. */
function recordingSender(): { readonly sender: StatusSender; readonly texts: string[] } {
  const texts: string[] = [];
  let counter = 0;

  return {
    texts,
    sender: {
      send: ({ text }) => {
        texts.push(text);
        counter += 1;
        return Promise.resolve(counter);
      },
      edit: ({ text }) => {
        texts.push(text);
        return Promise.resolve('edited' as const);
      },
    },
  };
}

/** Записи выгрузки в виде, который сравнивает набор. */
function classifiedOf(rows: readonly (typeof items.$inferSelect)[]): ClassifiedItem[] {
  return rows.flatMap((row) => {
    if (row.type === null || row.priority === null || row.topic === null) return [];

    const rule = row.recurrenceRule as RecurrenceRule | null;
    const recurrence =
      rule === null && row.recurrenceText === null
        ? undefined
        : {
            ...(rule === null ? {} : { rule }),
            ...(row.recurrenceText === null ? {} : { text: row.recurrenceText }),
            ...(row.recurrenceSource === null ? {} : { source: row.recurrenceSource }),
          };

    return [
      {
        text: row.text,
        type: row.type,
        priority: row.priority,
        topic: row.topic,
        isProject: row.isProject,
        ...(row.deadlineAt === null || row.deadlineAccuracy === null
          ? {}
          : { deadline: { at: row.deadlineAt, accuracy: row.deadlineAccuracy } }),
        ...(recurrence === undefined ? {} : { recurrence }),
      },
    ];
  });
}

/** Версии промптов — из учёта: что именно спрашивали по этой выгрузке. */
async function promptVersionsOf(
  deps: RunnerDeps,
  batchId: string,
): Promise<CaseOutcome['promptVersions']> {
  const rows = await deps.ai.db
    .select({ stage: aiCalls.stage, version: aiCalls.promptVersion })
    .from(aiCalls)
    .where(eq(aiCalls.batchId, batchId));

  const versions: { router?: string; extractor?: string; classifier?: string } = {};
  for (const row of rows) {
    if (row.version === null) continue;
    if (row.stage === 'router' || row.stage === 'extractor' || row.stage === 'classifier') {
      versions[row.stage] = row.version;
    }
  }

  return versions;
}

/** Отказ разбора — по черновикам обработчика: он пишет причину словами. */
function failureOf(drafts: readonly (typeof items.$inferSelect)[]): string | undefined {
  const reason = drafts
    .map((draft) => draft.draftReason ?? '')
    .find((one) => one.includes('не удал'));
  return reason === undefined || reason === '' ? undefined : reason;
}

/**
 * Прогоняет один случай.
 *
 * Отказ разбора не роняет прогон: набор из десяти случаев не должен
 * останавливаться на первом сбое сети, иначе мерить придётся по
 * настроению провайдера.
 */
export async function runCase(deps: RunnerDeps, item: EvalCase, index = 0): Promise<CaseOutcome> {
  const now = new Date(item.now);
  const db = deps.ai.db;
  const events: PipelineEvent[] = [];
  const said = recordingSender();

  const lost = (failed?: string): CaseOutcome => ({
    id: item.id,
    note: item.note,
    timeZone: item.timeZone,
    result: {
      matched: [],
      missed: [...item.expected.units],
      extra: [],
      ambiguous: [],
      retracted: [],
    },
    crisis: { detected: false, expected: item.expected.crisis },
    ...(failed === undefined ? {} : { failed }),
    promptVersions: {},
  });

  let batch: typeof batches.$inferSelect;
  try {
    const userId = await standUser(deps, item, index);
    batch = await batchOf(deps, userId, item, index, now);
  } catch (error) {
    deps.logger?.error({ err: error, id: item.id }, 'Обстановка случая не завелась');
    return lost(`обстановка: ${describe(error)}`);
  }

  const { db: _db, ...ai } = deps.ai;
  const light =
    deps.aiLight === undefined ? undefined : (({ db: _light, ...rest }) => rest)(deps.aiLight);

  const handle = createDumpHandler({
    // Голос стенд не разбирает: случаи — расшифровки, снятые с боя.
    speech: {
      provider: new MockSpeechProvider(),
      download: () => Promise.reject(new Error('стенд набора не скачивает голосовые')),
    },
    ai,
    ...(light === undefined ? {} : { aiLight: light }),
    ...(deps.embedder === undefined ? {} : { embedder: deps.embedder }),
    sender: said.sender,
    settings: new SettingsRegistry({ db, ttlMs: 0 }),
    now: () => now,
    observe: (event) => {
      events.push(event);
    },
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });

  let failed: string | undefined;
  try {
    await handle(db, batch);
    await db
      .update(batches)
      .set({ status: 'done', processedAt: now, error: null })
      .where(eq(batches.id, batch.id));
  } catch (error) {
    deps.logger?.error({ err: error, id: item.id }, 'Случай не прогнался');
    failed = describe(error);
  }

  const routed = events.find((event) => event.kind === 'routed');
  const routedPart = routed === undefined ? {} : { routed: routed.segments };

  const crisisDetected = said.texts.includes(defaultTexts.safety.crisis);
  const versions = await promptVersionsOf(deps, batch.id);

  const rows = await db
    .select()
    .from(items)
    .where(and(eq(items.sourceBatchId, batch.id)))
    .orderBy(items.createdAt, items.sourceOrder);
  const saved = rows.filter((row) => !row.isDraft);
  const drafts = rows.filter((row) => row.isDraft);

  const problem = failed ?? failureOf(drafts);

  if (problem !== undefined) {
    return {
      ...lost(problem),
      crisis: { detected: crisisDetected, expected: item.expected.crisis },
      promptVersions: versions,
      ...routedPart,
    };
  }

  /** След — из наблюдателя: основной проход и поздние мысли вместе. */
  const extracted = events.filter((event) => event.kind === 'extracted');
  const classified = events.filter((event) => event.kind === 'classified');
  const trace: CaseTrace | undefined =
    extracted.length === 0
      ? undefined
      : {
          dumpText: extracted.map((event) => event.dumpText).join('\n'),
          units: extracted.flatMap((event) => event.units),
          fromModel: classified.flatMap((event) => event.fromModel),
          items: classified.flatMap((event) => event.items),
        };

  return {
    id: item.id,
    note: item.note,
    timeZone: item.timeZone,
    result: match(item.expected.units, classifiedOf(saved), item.expected.retracted),
    crisis: { detected: crisisDetected, expected: item.expected.crisis },
    promptVersions: versions,
    ...routedPart,
    ...(trace === undefined ? {} : { trace }),
  };
}

export async function runDataset(
  deps: RunnerDeps,
  cases: readonly EvalCase[],
): Promise<CaseOutcome[]> {
  const outcomes: CaseOutcome[] = [];

  for (const [index, item] of cases.entries()) {
    deps.logger?.info({ id: item.id }, 'Случай');
    outcomes.push(await runCase(deps, item, index));
  }

  return outcomes;
}
