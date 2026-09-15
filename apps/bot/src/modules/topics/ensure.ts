import type { Executor } from '../../infra/db.js';
import { ensureTopics, normalizeTopicName } from './topics.repo.js';

/**
 * Сферы под записи (заказчица, 16.09.2026).
 *
 * До этого первая разобранная выгрузка заводила базовый набор из пяти
 * сфер и все пять веток разом — «человек видит структуру целиком»
 * (задача 3.43). Заказчица по своему видео: «про здоровье ничего не
 * говорила, про личное тоже, а он сразу насоздавал много тем… кто не в
 * теме — зачем это?». Теперь сфера появляется вместе с первой записью в
 * неё: базовые имена остаются подсказкой модели, а ветка — только там,
 * где есть что показать.
 *
 * Запись, чьей сфере не хватило места под пределом из настроек, уходит в
 * тему по умолчанию — та заводится и сверх предела, иначе записи негде
 * было бы лежать.
 */
export interface Placed {
  readonly topic: string;
}

export async function settleTopics<T extends Placed>(
  db: Executor,
  params: {
    readonly userId: string;
    readonly units: readonly T[];
    readonly defaultTopic: string;
    readonly maxTopics?: number | undefined;
  },
): Promise<{ readonly units: readonly T[]; readonly created: readonly string[] }> {
  if (params.units.length === 0) return { units: params.units, created: [] };

  const wanted = [
    ...new Map(params.units.map((unit) => [normalizeTopicName(unit.topic), unit.topic])).values(),
  ];
  const first = await ensureTopics(db, params.userId, wanted, params.maxTopics);

  const homeless = params.units.some((unit) => !first.present.has(normalizeTopicName(unit.topic)));
  const second = homeless
    ? await ensureTopics(db, params.userId, [params.defaultTopic], params.maxTopics)
    : undefined;

  const present = new Set([...first.present, ...(second?.present ?? [])]);
  const units = params.units.map((unit) =>
    present.has(normalizeTopicName(unit.topic)) ? unit : { ...unit, topic: params.defaultTopic },
  );

  return { units, created: [...first.created, ...(second?.created ?? [])] };
}
