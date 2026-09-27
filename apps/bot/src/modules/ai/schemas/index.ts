import { z } from 'zod';

import type { AiStage } from '../../../db/schema.js';

import { answererSchema, ANSWERER_SCHEMA_NAME } from './answerer.js';
import { readerSchema, READER_SCHEMA_NAME } from './reader.js';

import {
  classifierSchema,
  classifierV2Schema,
  CLASSIFIER_SCHEMA_NAME,
  CLASSIFIER_V2_SCHEMA_NAME,
  DEADLINE_ACCURACY,
  ITEM_TYPES,
  PRIORITIES,
} from './classifier.js';
import { decomposerSchema, DECOMPOSER_SCHEMA_NAME } from './decomposer.js';
import { extractorSchema, EXTRACTOR_SCHEMA_NAME } from './extractor.js';
import {
  presenterSchema,
  presenterV2Schema,
  PRESENTER_SCHEMA_NAME,
  PRESENTER_V2_SCHEMA_NAME,
} from './presenter.js';
import {
  resolverSchema,
  RESOLVER_ACTIONS,
  RESOLVER_MODES,
  RESOLVER_SCHEMA_NAME,
  RESOLVER_V1_SCHEMA_NAME,
  RESOLVER_V2_SCHEMA_NAME,
  resolverV1Schema,
  resolverV2Schema,
} from './resolver.js';
import { INTENTS, routerSchema, ROUTER_SCHEMA_NAME } from './router.js';

/**
 * Каталог схем строгого ответа (задача 2.2).
 *
 * Инвариант 5: на каждый структурный этап — своя схема, и ответ модели,
 * ей не соответствующий, отвергается до попадания в бизнес-логику.
 *
 * Схема живёт в одном экземпляре: Zod-описание в коде. Из него же
 * порождается JSON Schema для запроса к модели. Держать два описания —
 * одно для проверки, другое для запроса — значит однажды их разойтись
 * и получить ответ, который модель считает валидным, а мы нет.
 *
 * Имя схемы включает номер версии. Промпт можно откатить, а схема
 * ответа при этом может не совпасть — поэтому версия хранится вместе
 * с промптом, а расхождение ловится при загрузке (см. prompts/registry).
 */

export const SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  [ROUTER_SCHEMA_NAME]: routerSchema,
  [EXTRACTOR_SCHEMA_NAME]: extractorSchema,
  [CLASSIFIER_SCHEMA_NAME]: classifierSchema,
  // На вторую версию ссылаются classifier@4 и @5, лежащие в базе:
  // выкинуть её значит закрыть себе откат.
  [CLASSIFIER_V2_SCHEMA_NAME]: classifierV2Schema,
  // Первая версия — признание от модели, до 16.09.2026; presenter@1 в
  // базе ссылается на неё, откат должен оставаться возможным.
  [PRESENTER_SCHEMA_NAME]: presenterSchema,
  [PRESENTER_V2_SCHEMA_NAME]: presenterV2Schema,
  [ANSWERER_SCHEMA_NAME]: answererSchema,
  [READER_SCHEMA_NAME]: readerSchema,
  [DECOMPOSER_SCHEMA_NAME]: decomposerSchema,
  [RESOLVER_SCHEMA_NAME]: resolverSchema,
  // Первая версия ещё активна в бою до заливки промптов, и откат к ней
  // возможен: схему выкидывать нельзя.
  [RESOLVER_V1_SCHEMA_NAME]: resolverV1Schema,
  [RESOLVER_V2_SCHEMA_NAME]: resolverV2Schema,
};

export type SchemaName = keyof typeof SCHEMAS;

/**
 * Этапы, без промпта которых бот работает (22.09.2026).
 *
 * `presenter` — живая строка поверх ответа, `answerer` — ответ на вопрос
 * прозой: оба при отсутствии активной версии модель **не зовут вовсе** и
 * отвечают словарём. Сторож промптов при выкладке должен говорить о них
 * предупреждением, а не «разбор работать не будет, бот упадёт на первой
 * выгрузке»: неправду в выкладке перестанут читать вместе с настоящими
 * отказами. Остальные этапы обязательны — без них выгрузка гибнет.
 */
export const OPTIONAL_STAGES: ReadonlySet<AiStage> = new Set<AiStage>([
  'presenter',
  'answerer',
  // Без промпта ответ на вопрос бота узнаёт только код, как до 28.09.2026.
  'reader',
]);

/**
 * Какая схема действует на каком этапе сейчас.
 *
 * Нужна заливке промптов: имя файла задаёт этап, а схему по нему находит
 * этот справочник. В самой записи версии схема хранится своя, поэтому
 * старые версии продолжают ссылаться на старые схемы — здесь только
 * текущий выбор для новых.
 */
export const SCHEMA_BY_STAGE: Readonly<Partial<Record<AiStage, string>>> = {
  router: ROUTER_SCHEMA_NAME,
  extractor: EXTRACTOR_SCHEMA_NAME,
  classifier: CLASSIFIER_SCHEMA_NAME,
  presenter: PRESENTER_V2_SCHEMA_NAME,
  resolver: RESOLVER_SCHEMA_NAME,
  decomposer: DECOMPOSER_SCHEMA_NAME,
  answerer: ANSWERER_SCHEMA_NAME,
  reader: READER_SCHEMA_NAME,
};

export class UnknownSchemaError extends Error {
  constructor(name: string) {
    super(
      `Схема «${name}» в коде не найдена. Известны: ${Object.keys(SCHEMAS).join(', ') || '(ни одной)'}`,
    );
    this.name = 'UnknownSchemaError';
  }
}

export function findSchema(name: string): z.ZodType {
  const schema = SCHEMAS[name];
  if (!schema) throw new UnknownSchemaError(name);
  return schema;
}

/**
 * JSON Schema для запроса к модели.
 *
 * `target: 'draft-7'` и снятый `$schema`: Yandex SpeechKit и YandexGPT
 * принимают схему без служебных полей, а лишний ключ в корне — лишний
 * повод получить отказ на ровном месте.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = json;
  return rest;
}

/**
 * Устойчивое строковое представление схемы для сравнения.
 *
 * Порядок ключей в объекте от версии библиотеки может измениться, а
 * смысл схемы — нет. Сравнивать надо смысл, иначе обновление зависимости
 * начнёт валить загрузку промптов на ровном месте.
 */
export function canonicalJson(value: unknown): string {
  // JSON.stringify(undefined) возвращает undefined, а не строку. Типы об
  // этом молчат, поэтому случай разбирается явно.
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);

  return `{${entries.join(',')}}`;
}

export { extractorSchema, EXTRACTOR_SCHEMA_NAME };
export { decomposerSchema, DECOMPOSER_SCHEMA_NAME };
export type { DecomposedSteps } from './decomposer.js';
export { routerSchema, ROUTER_SCHEMA_NAME, INTENTS };
export {
  classifierSchema,
  CLASSIFIER_SCHEMA_NAME,
  CLASSIFIER_V2_SCHEMA_NAME,
  ITEM_TYPES,
  PRIORITIES,
  DEADLINE_ACCURACY,
};
export { presenterSchema, presenterV2Schema, PRESENTER_SCHEMA_NAME, PRESENTER_V2_SCHEMA_NAME };
export { resolverSchema, RESOLVER_SCHEMA_NAME, RESOLVER_ACTIONS, RESOLVER_MODES };
export type { ExtractedUnits } from './extractor.js';
export type { Intent, RoutedSegments } from './router.js';
export type { ClassifiedItems, DeadlineAccuracy, ItemType, Priority } from './classifier.js';
export type { PresenterAcknowledgement, PresenterLine } from './presenter.js';
export type { ResolverAction, ResolverAnswer, ResolverMode } from './resolver.js';
export { answererSchema, ANSWERER_SCHEMA_NAME };
export { readerSchema, READER_SCHEMA_NAME, READER_KINDS } from './reader.js';
export type { ReaderReading } from './reader.js';
export type { LiveAnswer } from './answerer.js';
