import type { Logger } from 'pino';
import type { z } from 'zod';

import type { AiStage } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { withRetry, withTimeout, type RetryOptions } from '../../infra/retry.js';
import { meterCall } from '../metering/ai-calls.repo.js';
import type { ModelPricing } from '../metering/pricing.js';
import type { PromptRegistry } from './prompts/registry.js';
import type { LlmProvider } from './providers/types.js';

/**
 * Обращение к языковой модели со строгой схемой (задача 2.3).
 *
 * Здесь сходятся три вещи: активная версия промпта из базы, схема ответа
 * из кода и учёт расхода. Каждый вызов помечается версией промпта — иначе
 * жалобу «бот стал хуже» не с чем сопоставить (§10.3 ТЗ).
 *
 * Два разных вида неудачи разводятся намеренно:
 *
 * **Модель недоступна** — сеть, таймаут, перегрузка. Такое пробрасывается
 * наружу временной ошибкой, и дальше работает то, что уже построено на
 * первом этапе: выгрузка возвращается в очередь, текст человека не
 * теряется, досмотр подберёт её, если задание потерялось (§10.2, §17).
 *
 * **Модель ответила, но не по схеме.** Повторяем один раз с усиленной
 * инструкцией, и если снова мимо — не бросаем исключение, а честно
 * возвращаем неудачу вместе с сырым ответом. Вызывающий код сохранит
 * запись черновиком без классификации и пометит для ручного разбора.
 * Терять текст нельзя ни при каких обстоятельствах, а сохранить его
 * неразобранным — можно.
 */

export interface AiClientDeps {
  readonly db: Database;
  readonly provider: LlmProvider;
  readonly prompts: PromptRegistry;
  readonly retry?: RetryOptions | undefined;
  readonly timeoutMs?: number | undefined;
  readonly pricing?: Readonly<Record<string, ModelPricing>> | undefined;
  readonly logger?: Logger | undefined;
}

export interface StructuredRequest {
  readonly stage: AiStage;
  /** Что разбираем: склеенный текст выгрузки. */
  readonly input: string;
  readonly userId?: string | undefined;
  readonly batchId?: string | undefined;
  readonly temperature?: number | undefined;
  readonly maxTokens?: number | undefined;
}

interface Success<T> {
  readonly ok: true;
  readonly value: T;
  readonly promptVersion: string;
  /** Сколько заходов потребовалось. Больше одного — повод посмотреть промпт. */
  readonly attempts: number;
}

interface Failure {
  readonly ok: false;
  readonly promptVersion: string;
  readonly attempts: number;
  /** Сырой ответ модели: он пойдёт в черновик для ручного разбора. */
  readonly raw: string;
  /** Чем именно ответ не подошёл. */
  readonly problem: string;
}

export type StructuredOutcome<T> = Success<T> | Failure;

/**
 * Сколько раз пробовать получить ответ по схеме.
 *
 * Два: первый заход обычный, второй — с усиленной инструкцией. Третий
 * заход на том же промпте почти наверняка даст то же самое, а платить
 * за него будет заказчик.
 */
const SCHEMA_ATTEMPTS = 2;

const DEFAULT_TIMEOUT_MS = 120_000;

const REINFORCEMENT =
  'Предыдущий ответ не прошёл проверку. Ошибка: {problem}. ' +
  'Верни строго JSON по заданной схеме: без пояснений, без текста до и ' +
  'после, без обрамления в кодовый блок. Никаких полей, которых нет в схеме.';

/**
 * Снимает обрамление в кодовый блок, если модель его добавила.
 *
 * Тройные кавычки вокруг JSON — очень частая привычка языковых моделей.
 * Содержимое при этом верное, и отвергать такой ответ значило бы терять
 * годный разбор из-за оформления.
 */
function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;

  return trimmed
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/```\s*$/u, '')
    .trim();
}

interface ParseOutcome<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly problem: string;
}

function parseAnswer<T>(schema: z.ZodType, text: string): ParseOutcome<T> {
  let payload: unknown;
  try {
    payload = JSON.parse(stripFence(text));
  } catch {
    return { ok: false, problem: 'ответ не разбирается как JSON' };
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') ?? '';
    return {
      ok: false,
      problem: `ответ не соответствует схеме${path === '' ? '' : ` (поле ${path})`}: ${first?.message ?? 'неизвестно'}`,
    };
  }

  return { ok: true, value: parsed.data as T, problem: '' };
}

export async function requestStructured<T>(
  deps: AiClientDeps,
  request: StructuredRequest,
): Promise<StructuredOutcome<T>> {
  const active = await deps.prompts.get(request.stage);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let raw = '';
  let problem = 'модель не ответила ни разу';

  for (let attempt = 1; attempt <= SCHEMA_ATTEMPTS; attempt++) {
    const prompt =
      attempt === 1
        ? active.prompt
        : `${active.prompt}\n\n${REINFORCEMENT.replace('{problem}', problem)}`;

    // Каждый заход — отдельная строка учёта: он потрачен и оплачен
    // независимо от того, подошёл ответ или нет (§10.5 ТЗ).
    const completion = await meterCall(
      deps.db,
      {
        stage: request.stage,
        model: deps.provider.name,
        promptVersion: active.version,
        userId: request.userId,
        batchId: request.batchId,
      },
      async () => {
        const result = await withRetry(
          () =>
            withTimeout(
              () =>
                deps.provider.complete({
                  prompt,
                  input: request.input,
                  jsonSchema: active.jsonSchema,
                  temperature: request.temperature,
                  maxTokens: request.maxTokens,
                }),
              timeoutMs,
              'запрос к модели',
            ),
          deps.retry ?? {},
        );

        return {
          value: result,
          usage: { tokensIn: result.tokensIn, tokensOut: result.tokensOut },
        };
      },
      { pricing: deps.pricing },
    );

    raw = completion.text;

    const parsed = parseAnswer<T>(active.schema, raw);
    if (parsed.ok && parsed.value !== undefined) {
      if (attempt > 1) {
        deps.logger?.info(
          { stage: request.stage, promptVersion: active.version },
          'Ответ по схеме получен со второго захода',
        );
      }
      return { ok: true, value: parsed.value, promptVersion: active.version, attempts: attempt };
    }

    problem = parsed.problem;
    deps.logger?.warn(
      { stage: request.stage, promptVersion: active.version, attempt, problem },
      'Модель ответила не по схеме',
    );
  }

  return {
    ok: false,
    promptVersion: active.version,
    attempts: SCHEMA_ATTEMPTS,
    raw,
    problem,
  };
}
