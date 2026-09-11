import type {
  EmbedRequest,
  EmbedResult,
  EmbeddingProvider,
} from '../../embedder/providers/types.js';
import { PermanentEmbeddingError } from '../../embedder/providers/types.js';
import type { CompletionRequest, CompletionResult, LlmProvider } from '../providers/types.js';
import { PermanentLlmError } from '../providers/types.js';
import { relativise } from './dates.js';
import { keyOf, vectorKeyOf, type CassettePlayer, type CassetteRecorder } from './store.js';

/**
 * Провайдеры на записи: пишут живые ответы или воспроизводят их без сети
 * (задача 3.80).
 *
 * **Имя провайдера отличается от живого нарочно.** Оно попадает в учёт
 * расхода (`ai_calls.model`), и если воспроизведённый прогон записался бы
 * как `yandex:yandexgpt/latest`, отчёт о расходе показал бы деньги,
 * которых никто не платил. После 05.09.2026 это последнее, чего хочется:
 * отчёт, завышающий расход, врёт так же, как занижающий.
 *
 * Поэтому у записи своё имя и своя цена — ноль. Строки учёта при этом
 * пишутся как обычно (§10.5), и видно, что вызовы были.
 */

/** Имя, под которым воспроизведённые вызовы попадают в учёт. */
export const CASSETTE_LLM_MODEL = 'cassette:llm';
export const CASSETTE_EMBEDDER_MODEL = 'cassette:embedder';

/** Что делает провайдер: пишет живое или воспроизводит записанное. */
export type CassetteMode = 'record' | 'replay';

export interface RecordingDeps {
  readonly live: LlmProvider;
  readonly recorder: CassetteRecorder;
  readonly recordedAt: Date;
  /** Версия промпта: входит в ключ, иначе запись переживёт правку промпта. */
  readonly promptVersionOf?: ((prompt: string) => string | undefined) | undefined;
}

/**
 * Записывающий: спрашивает живую модель и складывает ответ.
 *
 * Имя оставляет **живое**: расход-то настоящий, за него платят. Подмена
 * имени сделала бы себестоимость записи невидимой.
 */
export class RecordingLlmProvider implements LlmProvider {
  readonly name: string;

  constructor(private readonly deps: RecordingDeps) {
    this.name = deps.live.name;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const result = await this.deps.live.complete(request);

    this.deps.recorder.add({
      key: keyOf({ ...requestParts(request), recordedAt: this.deps.recordedAt }),
      stage: request.stage,
      input: relativise(request.input, this.deps.recordedAt),
      answer: relativise(result.text, this.deps.recordedAt),
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      ...(result.modelVersion === undefined ? {} : { modelVersion: result.modelVersion }),
    });

    return result;
  }
}

/**
 * Воспроизводящий: отвечает из записи и **никогда не выдумывает**.
 *
 * Промах — остановка прогона с внятным сообщением. Ответ не на тот
 * запрос сделал бы прогон зелёным по неверной причине, а это хуже
 * красного: красное чинят, а зелёному верят.
 */
export class ReplayLlmProvider implements LlmProvider {
  readonly name = CASSETTE_LLM_MODEL;

  constructor(
    private readonly player: CassettePlayer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  complete(request: CompletionRequest): Promise<CompletionResult> {
    const key = keyOf({ ...requestParts(request), recordedAt: this.player.recordedAt });
    const found = this.player.answerFor(key, this.now());

    if (found === undefined) {
      return Promise.reject(
        new PermanentLlmError(
          `в записи нет ответа на этот запрос (ключ ${key.slice(0, 8)}, вход «${request.input.slice(0, 60)}…»). ` +
            'Запись устарела: перезапишите её живым прогоном — E2E_CASSETTE=record',
        ),
      );
    }

    return Promise.resolve({
      text: found.answer,
      model: CASSETTE_LLM_MODEL,
      // Токенов у воспроизведения нет: денег не потрачено, и показывать
      // их значило бы придумать расход.
      tokensIn: 0,
      tokensOut: 0,
      ...(found.modelVersion === undefined ? {} : { modelVersion: found.modelVersion }),
    });
  }
}

export class RecordingEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;

  constructor(
    private readonly live: EmbeddingProvider,
    private readonly recorder: CassetteRecorder,
  ) {
    this.name = live.name;
    this.dimensions = live.dimensions;
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    const result = await this.live.embed(request);

    this.recorder.addVector({
      key: vectorKeyOf(request.text, request.purpose),
      text: request.text,
      purpose: request.purpose,
      /**
       * Вектор округляется до шести знаков.
       *
       * Точности хватает с запасом — поиск сравнивает косинусы, — а файл
       * записи иначе разрастается втрое на ровном месте.
       */
      vector: result.vector.map((one) => Number(one.toFixed(6))),
      model: result.model,
      tokens: result.tokens,
    });

    return result;
  }
}

/**
 * Воспроизводящий вектора.
 *
 * Записываются они потому, что от них зависит **поиск кандидатов**:
 * подставь сюда выдуманные числа — и резолвер получит другой список
 * записей, то есть другой вход, то есть промах по записи. Прогон стал бы
 * недетерминированным, а весь смысл записи — в повторяемости.
 */
export class ReplayEmbeddingProvider implements EmbeddingProvider {
  readonly name = CASSETTE_EMBEDDER_MODEL;
  readonly dimensions: number;

  constructor(
    private readonly player: CassettePlayer,
    dimensions: number,
  ) {
    this.dimensions = dimensions;
  }

  embed(request: EmbedRequest): Promise<EmbedResult> {
    const key = vectorKeyOf(request.text, request.purpose);
    const found = this.player.vectorFor(key);

    if (found === undefined) {
      return Promise.reject(
        new PermanentEmbeddingError(
          `в записи нет вектора для «${request.text.slice(0, 60)}…» (${request.purpose}). ` +
            'Перезапишите запись живым прогоном — E2E_CASSETTE=record',
        ),
      );
    }

    return Promise.resolve({ vector: found.vector, model: CASSETTE_EMBEDDER_MODEL, tokens: 0 });
  }
}

/**
 * Что из запроса влияет на ответ. Вынесено, чтобы ключ считался одинаково.
 *
 * Этап берётся из запроса, а не угадывается по схеме. Прежде провайдер
 * читал его из `title` схемы, но боевая схема (`toJsonSchema`) имени не
 * несёт — и в настоящей записи у каждой строки стоял «неизвестный», а
 * разбирать промахи по этапам, ради чего поле и заведено, было нельзя.
 * Проверки этого не видели: задавали схему руками, с `title`.
 */
function requestParts(request: CompletionRequest): {
  stage: string;
  prompt: string;
  input: string;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  schema?: unknown;
} {
  return {
    stage: request.stage,
    prompt: request.prompt,
    input: request.input,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    schema: request.jsonSchema,
  };
}
