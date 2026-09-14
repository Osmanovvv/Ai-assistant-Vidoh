import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import { topics } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { appendTopics, normalizeTopicName } from './topics.repo.js';

/**
 * Сферы по содержанию (правка заказчицы 14.09.2026, п. 1.1).
 *
 * §6.4 её ТЗ запрещал заводить сферы без спроса: модель называла тему не
 * из списка — запись молча уходила в общую, а спросить «добавить?» бот
 * мог только в конце опроса. 14.09 она решила иначе: «ВЫДОХ сам
 * определяет сферу по содержанию; если явно нужна новая — может создать
 * её автоматически; если не уверен — лучше сохранить без сферы».
 *
 * «Явно нужна новая» здесь значит одно: модель, видя список сфер
 * человека, всё равно назвала другую. Промпт не менялся — он и раньше
 * давал список и просил выбрать из него; отклонение от списка и есть её
 * уверенность. Сомнение отдельно не измеряется: в сомнении модель берёт
 * из списка, и запись остаётся там.
 *
 * Чего здесь не делается:
 *
 * - **Выключенная человеком сфера не возвращается.** Он снял «покупки»
 *   в настройках — это его решение (§6.4: сферы исправляет человек), и
 *   модель, назвав «покупки» для нового дела, его не отменяет: дело в
 *   общую. `appendTopics` умеет возвращать архивную тему по имени — этот
 *   путь для согласия человека, не для догадки модели.
 * - **Предел числа сфер держится** (настройка «Сколько тем»): сверх него
 *   запись остаётся в общей, сфера не заводится.
 * - **Имя не проверяется заново:** классификация отдаёт уже причёсанное
 *   (`topicNameFrom`), мусор до сюда не доходит.
 */
export interface WantsTopic {
  readonly topic: string;
  readonly wantedTopic?: string | undefined;
}

export interface AdoptResult<T extends WantsTopic> {
  readonly units: readonly T[];
  /** Заведённые сферы — в порядке первого упоминания. */
  readonly created: readonly string[];
  /** Названные, но не заведённые: предел или выключены человеком. */
  readonly declined: readonly string[];
}

export async function adoptWantedTopics<T extends WantsTopic>(
  db: Executor,
  params: {
    readonly userId: string;
    readonly units: readonly T[];
    readonly maxTopics?: number | undefined;
    readonly logger?: Logger | undefined;
  },
): Promise<AdoptResult<T>> {
  const wanted: string[] = [];
  const seen = new Set<string>();

  for (const unit of params.units) {
    if (unit.wantedTopic === undefined) continue;
    const key = normalizeTopicName(unit.wantedTopic);
    if (seen.has(key)) continue;
    seen.add(key);
    wanted.push(unit.wantedTopic);
  }

  if (wanted.length === 0) return { units: params.units, created: [], declined: [] };

  const archived = new Set(
    (
      await db
        .select({ name: topics.name })
        .from(topics)
        .where(and(eq(topics.userId, params.userId), eq(topics.isArchived, true)))
    ).map((row) => normalizeTopicName(row.name)),
  );

  const candidates = wanted.filter((name) => !archived.has(normalizeTopicName(name)));
  const { added } =
    candidates.length === 0
      ? { added: [] as readonly string[] }
      : await appendTopics(db, params.userId, candidates, params.maxTopics);

  const adopted = new Map(added.map((name) => [normalizeTopicName(name), name]));
  const declined = wanted.filter((name) => !adopted.has(normalizeTopicName(name)));

  const units = params.units.map((unit) => {
    if (unit.wantedTopic === undefined) return unit;
    const name = adopted.get(normalizeTopicName(unit.wantedTopic));
    return name === undefined ? unit : { ...unit, topic: name };
  });

  if (added.length > 0 || declined.length > 0) {
    params.logger?.info(
      { userId: params.userId, created: added, declined },
      'Сферы по содержанию: заведены и отклонены',
    );
  }

  return { units, created: added, declined };
}
