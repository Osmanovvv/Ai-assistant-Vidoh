import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import { items, type Batch, type EnergyLevelValue } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { textsFor } from '../../texts/index.js';
import type { AiClientDeps } from '../ai/client.js';
import { decideDegradation, type SpendLimit } from '../metering/limits.js';
import { classifyUnits, type ClassifiedItem } from '../classifier/classifier.service.js';
import { embedText } from '../embedder/embedder.service.js';
import type { EmbeddingProvider } from '../embedder/providers/types.js';
import { extractUnits } from '../extractor/extractor.service.js';
import { answerBacklogQuery } from '../backlog/query.service.js';
import { decomposeIfNeeded } from '../projects/decomposer.service.js';
import { describeProject } from '../projects/project-text.js';
import { contextOf, nextStepOf } from '../projects/projects.service.js';
import { openItemsFor, saveDraft, saveItems, type ItemToSave } from '../items/items.repo.js';
import { knownByText, splitKnown } from '../items/same-text.js';
import { describeChange, questionButtons, undoButtons } from '../resolver/change-text.js';
import { settlePendingQuestion } from '../resolver/pending.js';
import { datesInWords, rhythmInWords, suggestButtons } from '../recurrence/suggest-text.js';
import { suggestRecurrence } from '../recurrence/suggest.service.js';
import { openQuestionOf } from '../resolver/questions.repo.js';
import type { Applied } from '../resolver/patch.js';
import { resolvePatchSegment, type SegmentResult } from '../resolver/segment.js';
import { effectiveEnergy, selectForOutput } from '../output/filter.js';
import {
  createChosenTopics,
  firstStep,
  onboardingStateOf,
  questionFor,
  setStep,
  STEP,
} from '../onboarding/onboarding.service.js';
import { ANSWER_ACTION, composeOf, presentDump } from '../presenter/presenter.service.js';
import { titleUnderDayHeader } from '../items/item-text.js';
import { RETURNING_ACTION } from '../returning/returning-actions.js';
import { returningAfterPause } from '../returning/returning.service.js';
import { isQuickAdd } from '../presenter/quick-add.js';
import { saysNoStrength } from '../output/exhaustion.js';
import { isRecordCommand, weaveForExtraction } from './patch-in-place.js';
import type { QuestionSender } from '../presenter/telegram-sender.js';
import {
  finishStatus,
  showStatus,
  type StatusButton,
  type StatusSender,
  type StatusTarget,
} from '../presenter/status.service.js';
import { routeIntents, type Segment } from '../router/router.service.js';
import {
  detectByMarkers,
  detectCrisis,
  type CrisisContour,
  type CrisisOutcome,
} from '../safety/crisis.js';
import type { TopicGateway } from '../topics/gateway.js';
import { refreshSummaries } from '../topics/summary.service.js';
import { topicsFor } from '../topics/topics.repo.js';
import { topicByThread } from '../topics/topics.service.js';
import { lowerEnergy, outputContextOf } from '../users/state.repo.js';
import type { BatchHandler } from './pipeline.service.js';
import { applyThreadTopic } from './thread-topic.js';
import { statusTarget, transcribeBatch, type TranscribeDeps } from './transcribe.js';
import { titleWithoutDate } from '../resolver/title-date.js';

/**
 * Разбор выгрузки целиком: от звука до ответа человеку.
 *
 * Здесь связывается всё, что было построено по отдельности на задачах
 * 2.4–2.11: расшифровка, маршрутизатор намерений, извлечение единиц,
 * классификация, смысловые представления, сохранение, отбор действий и
 * ответ по §13.2.
 *
 * **Порядок отказов важнее порядка шагов.** На каждом шаге спрашивается
 * одно: потеряется ли текст человека, если дальше не пойдёт. Пока ответ
 * «нет» — идём дальше; как только «да» — сохраняем черновик и отвечаем
 * тем, что есть. §9 ТЗ запрещает терять сообщения, §17 разрешает
 * сохранять их неразобранными.
 *
 * **На этом этапе разбираются только новые мысли.** Правка сказанного,
 * отметка выполнения, отмена и вопрос по бэклогу требуют резолвера, а он
 * приходит на третьем этапе (§7). До тех пор такие части выгрузки
 * сохраняются черновиком и ждут: превратить «хотя нет, в пятницу» в
 * задачу «в пятницу» было бы хуже, чем не разобрать её вовсе.
 */

/** Заголовок записи: он подставляется в текст открытого вопроса (§7.3). */
async function titleOfItem(db: Database, itemId: string): Promise<string | undefined> {
  const [row] = await db.select({ text: items.text }).from(items).where(eq(items.id, itemId));
  return row?.text;
}

/** Намерения, которые этап 2 разбирает сам. */
const PARSED_INTENTS = new Set(['DUMP']);

/**
 * Намерения, с которыми работает резолвер (§7 ТЗ, задача 3.6а).
 *
 * До третьего этапа они уходили в черновик с пометкой «ждёт резолвера».
 * Резолвер появился — значит пора звать.
 *
 * `QUERY` сюда не входит: вопрос по бэклогу — не правка записи, у него
 * своя задача 3.10.
 */
const RESOLVED_INTENTS = new Set(['PATCH', 'COMPLETE', 'CANCEL']);

/**
 * Вопрос по бэклогу (§13.4, задача 3.10).
 *
 * Отвечается тем, что уже известно, и **ничего не создаёт** — ни записи,
 * ни черновика. Человек спросил, а получил три новых дела: это не ответ,
 * а встречное требование.
 */
const QUERY_INTENT = 'QUERY';

/**
 * Намерения, которые ничего не создают и ничего не ждут.
 *
 * «Привет» и «спасибо» не мысли и не дела. Черновик из них был бы мусором
 * в админке, а §13.9 требует от бота короткой реплики, а не разбора.
 */
const IGNORED_INTENTS = new Set(['SMALLTALK']);

/**
 * Ответ на уточняющий вопрос (§7.3, задача 3.6).
 *
 * Не разбирается как мысль и не уходит в черновик: это реплика про
 * открытый вопрос, а не дело. Без отдельной ветки «да, к прошлой»
 * превратилось бы в запись «да».
 */
const ANSWER_INTENT = 'ANSWER';

export interface DumpHandlerDeps {
  readonly speech: TranscribeDeps;
  /** Полная модель: извлечение, классификация, представление. */
  readonly ai: Omit<AiClientDeps, 'db'>;
  /**
   * Лёгкая модель для маршрутизатора намерений (§7.1, задача 2.4).
   *
   * Отдельный провайдер, а не подмена названия модели в запросе: имя
   * попадает в учёт расхода, и подмена сделала бы себестоимость
   * недостоверной. Если не задана, маршрутизатор идёт на полной.
   */
  readonly aiLight?: Omit<AiClientDeps, 'db'> | undefined;
  /**
   * Мягкий лимит расхода на пользователя (§10.5 ТЗ, задача 2.22).
   *
   * Задан — и при превышении извлечение с классификацией идут на лёгкой
   * модели. Человек этого не замечает (§17): ни отказа, ни
   * предупреждения, ответ приходит как обычно.
   */
  readonly spendLimit?: SpendLimit | undefined;
  /**
   * Бот сам предлагает запомнить регулярность (задача 3.8в).
   *
   * Выключено по умолчанию до калибровки на живых данных: порог «это одно
   * и то же дело» угадать нельзя, а ложное предложение раздражает.
   */
  readonly suggestRecurrence?: boolean | undefined;
  /**
   * Провайдер смысловых представлений. Без него записи сохраняются без
   * векторов: разбор дороже поиска, и терять его из-за эмбеддингов нельзя.
   */
  readonly embedder?: EmbeddingProvider | undefined;
  readonly sender?: StatusSender | undefined;
  /**
   * Отправитель вопросов онбординга (§12.2, задача 2.13).
   *
   * Онбординг начинается здесь, а не в обработчике команд, потому что
   * §12.2 привязывает его к первой выгрузке: спрашивать до неё запрещено.
   */
  readonly onboarding?: QuestionSender | undefined;
  /**
   * Ветки личного чата (§8, задачи 2.15 и 2.16).
   *
   * Без него разбор работает целиком, только сводки тем не обновляются —
   * это и есть плоский режим §8.2. Данные от этого не страдают.
   */
  readonly topics?: TopicGateway | undefined;
  readonly logger?: Logger | undefined;
  readonly now?: (() => Date) | undefined;
}

/** Ответ человеку. Молча, если отправителя нет — так работают тесты. */
async function reply(
  db: Database,
  deps: DumpHandlerDeps,
  target: StatusTarget | undefined,
  text: string,
  buttons?: readonly StatusButton[],
): Promise<void> {
  if (!deps.sender || !target) return;
  await finishStatus({ db, sender: deps.sender }, target, text, buttons);
}

/** Запоминает темы записи до и после правки: перенос затрагивает обе. */
function rememberTopics(into: Set<string>, applied: Applied): void {
  for (const topic of [applied.before.topic, applied.after.topic]) {
    if (topic !== null && topic.length > 0) into.add(topic);
  }
}

/** Обновляет сводки тронутых тем, если ветки вообще есть. */
async function refreshTouched(
  db: Database,
  deps: DumpHandlerDeps,
  target: StatusTarget | undefined,
  params: {
    readonly userId: string;
    readonly timeZone: string;
    readonly textProfile: string;
  },
  topics: ReadonlySet<string>,
): Promise<void> {
  if (!deps.topics || !target || topics.size === 0) return;

  await refreshSummaries(
    { db, gateway: deps.topics, logger: deps.logger },
    {
      userId: params.userId,
      chatId: target.chatId,
      topicNames: [...topics],
      timeZone: params.timeZone,
      profile: params.textProfile,
    },
  );
}

/**
 * Вторая и последующие реплики одного разбора — своими сообщениями.
 *
 * `reply` **правит** единственное статусное сообщение выгрузки, и для
 * первой реплики это верно: человек видит, как «Слушаю…» превращается в
 * ответ. Но второй вызов затирает первый.
 *
 * Так пропало подтверждение выполнения вместе с кнопкой отката, когда к
 * нему добавился вопрос сценария 8: человек не видел, что закрылось, и не
 * мог вернуть. Найдено ручным прогоном 31.08.2026 — тесты этого не
 * показывали, потому что фейковый отправитель копил реплики списком, а не
 * правил одну.
 */
async function alsoSay(
  deps: DumpHandlerDeps,
  target: StatusTarget | undefined,
  text: string,
  buttons?: readonly StatusButton[],
): Promise<void> {
  if (!deps.sender || !target) return;

  await deps.sender.send({
    chatId: target.chatId,
    ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
    text,
    ...(buttons === undefined ? {} : { buttons }),
  });
}

/**
 * Считает векторы для записей.
 *
 * Последовательно, а не разом: двадцать пять одновременных обращений к
 * провайдеру — верный способ получить отказ по частоте, а выгрузка и так
 * идёт десятки секунд.
 *
 * Отказ не роняет разбор. Запись без вектора найдётся хуже, запись
 * несохранённая не найдётся никогда, и досчитать вектор потом можно, а
 * восстановить разбор — нет.
 */
async function withEmbeddings(
  db: Database,
  deps: DumpHandlerDeps,
  batch: Batch,
  classified: readonly ClassifiedItem[],
): Promise<readonly ItemToSave[]> {
  const { embedder } = deps;
  if (!embedder) return classified;

  const result: ItemToSave[] = [];

  for (const item of classified) {
    try {
      const embedding = await embedText(
        { db, provider: embedder, logger: deps.logger, pricing: deps.ai.pricing },
        { text: item.text, purpose: 'document', userId: batch.userId, batchId: batch.id },
      );
      result.push({ ...item, embedding });
    } catch (error) {
      deps.logger?.warn(
        { err: error, batchId: batch.id },
        'Вектор не посчитан, запись сохраняется без него',
      );
      result.push(item);
    }
  }

  return result;
}

/**
 * §13.7: высказанное состояние уменьшает объём выдачи и больше ничего.
 *
 * **Уровень снижает только «сил нет вовсе» (задача 3.47).** Прежде любая
 * эмоция опускала уровень до «мало», а сверху ещё стоял предел «одно
 * дело» — и человек, сказавший «задолбался всё это в голове держать»,
 * получал на двадцать дел одну строку. Заказчик попросил показывать три
 * самых важных, и ТЗ это различие делает само: «вообще без сил» — одно
 * действие, «ничего не успеваю» — сокращённая выдача, а главный эталон
 * §13.2 при названной усталости показывает три.
 *
 * Короткая форма §13.7 при этом остаётся при любой эмоции: она задаётся
 * составом выгрузки в представлении, а не уровнем сил.
 */
async function applyEmotion(
  db: Database,
  deps: DumpHandlerDeps,
  userId: string,
  emotions: readonly string[],
  current: EnergyLevelValue,
  now: Date,
): Promise<EnergyLevelValue> {
  if (!emotions.some((text) => saysNoStrength(text))) return current;

  const lowered = await lowerEnergy(db, userId, 'empty', { at: now, current });
  if (lowered) {
    deps.logger?.info({ userId }, 'Уровень сил снижен: человек сказал, что сил нет');
    return 'empty';
  }

  return current;
}

export function createDumpHandler(deps: DumpHandlerDeps): BatchHandler {
  const clock = deps.now ?? ((): Date => new Date());

  return async (db, batch) => {
    const now = clock();

    // Считается всегда, а не только когда есть кому отвечать: из него
    // берётся и ветка, в которой человек написал, и чат для сводок тем.
    const target = await statusTarget(db, batch.id);
    const context = await outputContextOf(db, batch.userId);
    const texts = textsFor(context.textProfile);
    const ai = { ...deps.ai, db };
    const aiLight = { ...(deps.aiLight ?? deps.ai), db };

    const { combined, truncated } = await transcribeBatch(db, batch, deps.speech, {
      onStart: async () => {
        if (!deps.sender || !target) return;
        await showStatus({ db, sender: deps.sender }, target, texts.listening.working);
      },
    });

    /**
     * Занят ли статусный слот выгрузки.
     *
     * **Статусное сообщение одно, и `finishStatus` его правит.** Значит
     * вторая реплика за одну выгрузку затирает первую — вместе с её
     * кнопками. Один раз это уже поймали ручным прогоном 31.08.2026:
     * вопрос сценария 8 съедал подтверждение выполнения с кнопкой отката.
     * Тогда починили одно место, подставив `alsoSay`.
     *
     * **А случай был общий.** В смешанной выгрузке — правка плюс новые
     * мысли — подтверждение изменения точно так же затиралось итоговым
     * ответом §13.2, и кнопка отката исчезала. Нашлось 01.09.2026, когда
     * чинили 3.24: правка внутри выгрузки наконец стала применяться, и
     * сразу выяснилось, что человек об этом всё равно не узнает.
     *
     * Поэтому решение здесь, а не в каждом месте по отдельности: первая
     * реплика забирает статусное сообщение, каждая следующая уходит
     * своим. Через `reply` больше никто не ходит — забыть это нельзя.
     */
    /**
     * Что уже случилось за эту выгрузку.
     *
     * **Одним объектом, а не четырьмя `let`, и это не косметика.** Флаги
     * ставятся внутри замыканий `tell` и `useOutcome`, а для захваченной
     * переменной TypeScript сужение теряет и считает её навсегда
     * `false` — то есть перестаёт проверять как раз то, ради чего флаг и
     * существует. У поля объекта такого не происходит.
     */
    const happened = {
      /** Сказал ли бот человеку хоть что-то по существу. */
      said: false,
      /** Задан ли вопрос: §13.9 разрешает один на обмен. */
      asked: false,
      /** Закрылось ли хоть одно дело — для вопроса §2 сценария 8. */
      closed: false,
      /** Занят ли статусный слот: вторая реплика уходит своим сообщением. */
      statusTaken: false,
      /**
       * Ушло ли что-то из сказанного в черновик (задача 3.32).
       *
       * Нужно быстрому добавлению: односложным «Записала.» нельзя
       * отвечать на выгрузку, часть которой не разобралась.
       */
      parked: false,
    };

    const tell = async (text: string, buttons?: readonly StatusButton[]): Promise<void> => {
      if (happened.statusTaken) {
        await alsoSay(deps, target, text, buttons);
        return;
      }

      happened.statusTaken = true;
      await reply(db, deps, target, text, buttons);
    };

    /**
     * Обычный ответ, к которому договаривается предупреждение об обрезке
     * (§10.5 ТЗ).
     *
     * Отдельной репликой это не отправляется: одна выгрузка — один ответ.
     * И к кризисной реплике не договаривается тоже: там человеку не до
     * длины записи (§13.7).
     */
    const answer = async (text: string, buttons?: readonly StatusButton[]): Promise<void> => {
      const tail = `\n\n${texts.listening.tooLong}`;
      await tell(truncated ? `${text}${tail}` : text, buttons);
    };

    if (combined === '') {
      await answer(texts.listening.nothingHeard);
      return;
    }

    /**
     * §13.7, острый кризис. Первый контур считается здесь — до первого
     * обращения к модели: он ничего не стоит, а значит на настоящем
     * кризисе разбор останавливается до первой потраченной копейки.
     */
    const stopOnCrisis = async (
      outcome: CrisisOutcome,
      /** Какой контур считали: по нему в журнале видно, что именно снято. */
      contour: CrisisContour,
    ): Promise<boolean> => {
      if (!outcome.detected) {
        if (outcome.hyperbole !== undefined) {
          // Признак был и снят речевым оборотом. Это самое опасное место
          // контура: по требованию заказчицы мы гасим ложные
          // срабатывания, и надо видеть, не гасим ли лишнего. В журнал
          // идёт оборот, а не сказанное человеком.
          deps.logger?.info(
            {
              event: 'crisis_muted',
              batchId: batch.id,
              userId: batch.userId,
              contour,
              hyperbole: outcome.hyperbole,
            },
            'Признак кризиса снят речевым оборотом',
          );
        }

        return false;
      }

      // В журнал идёт факт и сработавший маркер, но не сказанное:
      // частоту ложных срабатываний оценить надо, читать чужую беду в
      // логах — нет.
      deps.logger?.warn(
        {
          event: 'crisis_detected',
          batchId: batch.id,
          userId: batch.userId,
          contour: outcome.contour ?? contour,
          marker: outcome.marker,
        },
        'Сработал контур острого кризиса, разбор остановлен',
      );

      // Ни записей, ни черновиков, ни уточняющих вопросов. Текст человека
      // при этом на месте: он сохранён до всякого разбора (инвариант 1).
      await tell(texts.safety.crisis);
      return true;
    };

    if (await stopOnCrisis(detectByMarkers(combined), 'markers')) return;

    /**
     * §10.5: мягкий лимит расхода (задача 2.22).
     *
     * Решение принимается один раз на выгрузку, а не перед каждым
     * вызовом: расход внутри одной выгрузки лимит всё равно не догонит,
     * а разбор, у которого извлечение прошло на полной модели, а
     * классификация на лёгкой, объяснить в отчёте будет нечем.
     *
     * Считается после кризисного контура: на кризисе разбора нет вовсе,
     * и лишний запрос к учёту там не нужен.
     */
    const limited = await decideDegradation(db, {
      userId: batch.userId,
      now,
      limit: deps.spendLimit,
      logger: deps.logger,
    });

    // Полная модель или лёгкая — решается здесь и дальше не меняется.
    const heavy = limited.degrade ? aiLight : ai;

    // ── Намерения ───────────────────────────────────────────────────────
    /**
     * §7.3, задача 3.6: при открытом вопросе намерение `ANSWER`
     * проверяется первым. Без этого «в пятницу» уйдёт в `DUMP` и создаст
     * задачу без задачи — маршрутизатор не может знать, о чём спрашивал
     * бот, если ему не сказать.
     */
    const pending = await openQuestionOf(db, batch.userId, now);
    const askedAbout = pending === undefined ? undefined : await titleOfItem(db, pending.itemId);

    const routed = await routeIntents(aiLight, {
      input: combined,
      userId: batch.userId,
      batchId: batch.id,
      ...(askedAbout === undefined
        ? {}
        : { openQuestion: texts.resolver.question(titleWithoutDate(askedAbout)) }),
    });

    // Второй контур: признак от модели. Маркеры уже проверены, поэтому
    // здесь решает только он.
    if (await stopOnCrisis(detectCrisis(combined, routed.crisis), 'model')) return;

    const parsed: Segment[] = [];
    const deferred: Segment[] = [];
    const answers: string[] = [];
    const questions: string[] = [];

    /**
     * Правки, сказанные **до** первой мысли этой выгрузки.
     *
     * Такая правка относится к прошлому: «нет, в пятницу» в начале
     * выгрузки — про то, что человек говорил раньше. Разбирается до
     * сохранения, чтобы попасть в прежнюю запись, а не в свежую.
     */
    const patches: Segment[] = [];

    /**
     * Правки, сказанные **после** мысли этой же выгрузки (задача 3.24).
     *
     * «Договориться с няней, чтобы приходила в 10. Нет, лучше в 10 30» —
     * поправка к тому, что произнесено секунду назад. Разбирается после
     * сохранения и **только среди записей своей выгрузки**.
     *
     * **Порядок сегментов и есть признак.** Найдено ручным прогоном на
     * боевом 02.09.2026: без этого правку перехватывал первый проход и
     * уводил в похожую запись из прошлой выгрузки — у человека оказались
     * испорчены обе, старая и новая.
     */
    const patchesAfterThought: Segment[] = [];
    /** Инвариант 10: один вопрос в реплике, и первый его занимает. */

    /**
     * Темы, которых коснулись правки, — их сводки надо обновить.
     *
     * Обновление сводок стояло ниже и звалось только с темами **новых**
     * записей. Выгрузка из одной правки, закрытия или отмены до него не
     * доходила вовсе: поправил срок — в ветке старый, закрыл дело — в
     * ветке открыто. §8 обещает «сводка ветки обновляется редактированием».
     * Найдено ручным прогоном 31.08.2026.
     *
     * Собираются обе темы — прежняя и новая: правка могла перенести
     * запись, и тогда обновить надо и ту ветку, откуда она ушла.
     */
    const touchedTopics = new Set<string>();

    /**
     * Записи, о которых человек говорил в этой выгрузке.
     *
     * Не только заведённые сейчас: поправленное и закрытое человек тоже
     * назвал вслух, и в ответе оно должно стоять впереди старого. Ровно
     * поэтому здесь набор ключей, а не номер выгрузки, — по номеру
     * правки не найти, у поправленной записи он от прошлой выгрузки.
     */
    const mentioned = new Set<string>();

    /** Закрылось ли в этой выгрузке хоть одно дело — для вопроса §2.8. */

    /**
     * Сказал ли бот человеку хоть что-то по существу.
     *
     * Нужен ради одной реплики в самом конце. «Я здесь. Расскажешь, что
     * в голове?» существует для сообщения, из которого не вышло ничего:
     * ни записи, ни правки, ни ответа. Но условие на неё стояло только
     * «новых мыслей нет» — а новых мыслей нет и когда человек задал
     * вопрос, и когда поправил запись, и когда отметил дело сделанным.
     * Бот отвечал по существу и следом добавлял «расскажешь, что в
     * голове?», то есть выглядел так, будто не понял.
     */

    /**
     * Возвращение после паузы (§13.6 ТЗ).
     *
     * Первое, что человек видит, вернувшись через две недели: не стена
     * накопившегося, а выбор. Экран занимает единственный вопрос реплики
     * — обычный ответ на эту выгрузку придёт без своего «С чего начнём?»,
     * ровно как это уже устроено у онбординга.
     *
     * Сказанное при этом разбирается как обычно: человек вернулся и
     * что-то наговорил, терять это нельзя.
     */
    if (await returningAfterPause(db, { userId: batch.userId, batchId: batch.id, now })) {
      happened.asked = true;
      happened.said = true;
      await tell(texts.returning.greeting, [
        { label: texts.returning.buttonContinue, action: RETURNING_ACTION.keep },
        { label: texts.returning.buttonFresh, action: RETURNING_ACTION.fresh },
      ]);
    }

    /** Прозвучала ли в этой выгрузке мысль до текущего сегмента. */
    let thoughtSaid = false;

    for (const segment of routed.segments) {
      if (segment.intent === ANSWER_INTENT) answers.push(segment.text);
      else if (segment.intent === QUERY_INTENT) questions.push(segment.text);
      else if (PARSED_INTENTS.has(segment.intent)) {
        parsed.push(segment);
        thoughtSaid = true;
      } else if (RESOLVED_INTENTS.has(segment.intent)) {
        (thoughtSaid ? patchesAfterThought : patches).push(segment);
      } else if (!IGNORED_INTENTS.has(segment.intent)) deferred.push(segment);
    }

    /**
     * Судьба открытого вопроса решается до разбора мыслей.
     *
     * «Это новое» возвращает сказанное обратно в разбор — оно пойдёт
     * через то же извлечение и ту же классификацию, что и остальная
     * выгрузка, без отдельного вызова модели.
     */
    const settled = await settlePendingQuestion(db, {
      userId: batch.userId,
      batchId: batch.id,
      timeZone: context.timeZone,
      ...(answers.length === 0 ? {} : { answerText: answers.join(' ') }),
      now,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    });

    if (settled.carryOver !== undefined) {
      parsed.push({ intent: 'DUMP', text: settled.carryOver });
    }

    /**
     * В ответе были слова сверх ответа — они сохранены черновиком, и
     * человеку об этом сказано (3.44). Иначе он увидит «Перенесла…» и
     * решит, что остальное бот пропустил мимо ушей.
     */
    if (settled.leftoverSaved === true) {
      happened.said = true;
      await tell(texts.resolver.leftoverSaved);
    }

    if (settled.kind === 'applied' && settled.applied !== undefined) {
      happened.said = true;
      rememberTopics(touchedTopics, settled.applied);
      mentioned.add(settled.applied.after.id);
      // §7.3: показать, что именно изменилось, и дать кнопку отмены.
      await tell(
        describeChange(settled.applied, texts, context.timeZone),
        undoButtons(settled.applied.revisionId, texts),
      );
    } else if (settled.kind === 'nothingToApply') {
      happened.said = true;
      await tell(texts.resolver.attached);
    } else if (settled.kind === 'unclear') {
      happened.said = true;
      await tell(texts.resolver.answerUnclear);
    }

    /**
     * §8.1: сообщение внутри ветки обрабатывается в контексте её темы.
     *
     * Тема ветки становится темой по умолчанию — то есть тем, куда уйдёт
     * запись, не попавшая ни в одну тему явно. Женщина, написавшая в
     * ветку «здоровье», не должна получать своё дело в «личном» только
     * потому, что не назвала сферу словами.
     *
     * Считается до разбора правок: подбор кандидатов сужается той же
     * темой, и по той же причине — правка внутри ветки почти наверняка
     * про запись из неё.
     */
    const threadTopic =
      target?.threadId === undefined
        ? undefined
        : await topicByThread(db, batch.userId, target.threadId);

    /**
     * Правки разбираются по одной и до разбора новых мыслей.
     *
     * По одной, потому что у каждой свои кандидаты и своё решение: пачкой
     * их не рассудить. До мыслей — потому что «нет, в пятницу» относится
     * к тому, что было сказано раньше, и должно попасть в ту запись, а не
     * в новую, которая появится через секунду.
     *
     * **У этого порядка есть цена, и она обнаружилась в бою** (задача
     * 3.24): правка к сказанному **в этой же выгрузке** цели не находит —
     * записи ещё нет. Поэтому такие правки не уходят в черновик сразу, а
     * ждут второго прохода, ниже.
     */

    /** Правки, которые надо перебрать среди записей своей выгрузки. */
    const searchOwnBatch: Segment[] = [...patchesAfterThought];

    /** Правки, которым не хватило и своей выгрузки: ищем по всему. */
    const searchEverywhere: Segment[] = [];

    /**
     * Что делать с исходом разбора правки.
     *
     * Отдельной функцией потому, что проходов два и обработка у них
     * одна: разъехавшись, они дали бы правку, которая на втором проходе
     * применяется молча, без реплики человеку.
     */
    const useOutcome = async (
      segment: Segment,
      outcome: SegmentResult,
      /**
       * Какой это проход. От него зависит, куда девать «цель не нашлась»:
       * `before` — до сохранения, `ownBatch` — среди своей выгрузки,
       * `wide` — последний, по всем записям.
       */
      stage: 'before' | 'ownBatch' | 'wide',
    ): Promise<void> => {
      if (outcome.kind === 'applied') {
        happened.said = true;
        rememberTopics(touchedTopics, outcome.applied);
        mentioned.add(outcome.applied.after.id);
        if (outcome.applied.action === 'complete') happened.closed = true;
        await tell(
          describeChange(outcome.applied, texts, context.timeZone),
          undoButtons(outcome.applied.revisionId, texts),
        );
        return;
      }

      if (outcome.kind === 'asked') {
        /**
         * Второй вопрос за обмен задавать нельзя (§13.9).
         *
         * На повторном проходе вопрос уже мог быть задан первым, и тогда
         * лучше черновик: два вопроса подряд — это допрос, а текст
         * человека не теряется и так.
         */
        if (happened.asked) {
          happened.parked = true;
          await saveDraft(db, {
            userId: batch.userId,
            batchId: batch.id,
            text: segment.text,
            reason: 'цель нашлась, но вопрос за эту выгрузку уже задан (§13.9)',
          });
          return;
        }

        happened.asked = true;
        happened.said = true;
        // §7.3: один короткий вопрос с двумя кнопками и заголовком
        // найденной записи в тексте.
        await tell(
          texts.resolver.question(titleWithoutDate(outcome.itemTitle)),
          questionButtons(outcome.questionId, texts),
        );
        return;
      }

      if (outcome.kind === 'newThought') {
        /**
         * Распоряжение о записи мыслью не становится (задача 3.67).
         *
         * **Найдено живым прогоном проджекта 04.09.2026.** Он прислал
         * отдельным сообщением «Перенеси дело с собакой на вторник».
         * Резолвер цели не нашёл — у человека три дела про собаку — и
         * вернул «это новая мысль». Мысль уходит в разбор, и распоряжение
         * стало **делом** «Перенеси дело с собакой на вторник» со сроком
         * на вторник. В списке дел человек увидел свою же команду.
         *
         * Резолвер тут не виноват: он честно сказал «цели не нашёл».
         * Виновата развилка — «не правка» у нас означало «значит мысль», а
         * третьего исхода не было. Теперь он есть: сказанное сохраняется
         * как есть (§16 — ничего не теряется), и человеку говорится, что
         * цель не найдена.
         *
         * Проверяются только приказы о записи, без существительного
         * «дело»: «надо доделать дело с налогами» — настоящая мысль.
         */
        if (isRecordCommand(segment.text)) {
          happened.parked = true;
          happened.said = true;

          await saveDraft(db, {
            userId: batch.userId,
            batchId: batch.id,
            text: segment.text,
            reason: 'распоряжение о записи, но цель не нашлась',
          });

          await tell(texts.resolver.targetNotFound);
          return;
        }

        /**
         * На первом проходе это ещё мысль, на втором — уже поздно:
         * извлечение и сохранение прошли, и вставить её в разбор нечем.
         */
        if (stage === 'before') {
          parsed.push(segment);
          return;
        }

        happened.parked = true;
        await saveDraft(db, {
          userId: batch.userId,
          batchId: batch.id,
          text: segment.text,
          reason: 'резолвер счёл это новой мыслью, но разбор выгрузки уже прошёл',
        });
        return;
      }

      if (outcome.retryAfterSave === true && stage !== 'wide') {
        (stage === 'before' ? searchOwnBatch : searchEverywhere).push(segment);
        return;
      }

      happened.parked = true;
      await saveDraft(db, {
        userId: batch.userId,
        batchId: batch.id,
        text: segment.text,
        reason: outcome.reason,
      });
    };

    /**
     * Разбор одной правки.
     *
     * `ownBatchOnly` ставит второй проход: он ищет цель только среди
     * записей этой выгрузки. Первый проход уже искал по всему и не
     * нашёл — значит цель либо здесь, либо её нет вовсе.
     */
    const resolveOne = async (segment: Segment, ownBatchOnly = false): Promise<SegmentResult> =>
      await resolvePatchSegment(
        {
          db,
          ai: heavy,
          ...(deps.embedder === undefined ? {} : { embedder: deps.embedder }),
          ...(deps.ai.pricing === undefined ? {} : { pricing: deps.ai.pricing }),
          ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        },
        {
          userId: batch.userId,
          batchId: batch.id,
          text: segment.text,
          timeZone: context.timeZone,
          ...(threadTopic?.name === undefined ? {} : { topic: threadTopic.name }),
          ...(ownBatchOnly ? { onlyOwnBatch: true } : {}),
          now,
        },
      );

    for (const segment of patches) {
      await useOutcome(segment, await resolveOne(segment), 'before');
    }

    for (const [order, segment] of deferred.entries()) {
      // Текст не теряется и виден в админке: разберёт его резолвер на
      // третьем этапе, когда появится, к чему применять правку.
      //
      // Порядок внутри выгрузки сохраняется: без него черновики одной
      // выгрузки лежали бы в случайном порядке — время создания у них
      // совпадает.
      await saveDraft(db, {
        userId: batch.userId,
        batchId: batch.id,
        text: segment.text,
        reason: `намерение ${segment.intent} — ждёт резолвера (этап 3)`,
        order,
      });
    }

    for (const question of questions) {
      happened.said = true;
      const answer = await answerBacklogQuery(
        {
          db,
          ...(deps.embedder === undefined ? {} : { embedder: deps.embedder }),
          ...(deps.ai.pricing === undefined ? {} : { pricing: deps.ai.pricing }),
          ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        },
        { userId: batch.userId, text: question, batchId: batch.id, now },
      );

      /**
       * Про большую цель отвечаем контекстом, а не строкой списка (3.13).
       *
       * Разложение случается здесь же, лениво: человек спросил — значит
       * цель ему интересна, и платить за разбор уже не жалко.
       * Раскладывать при создании значило бы платить за все проекты, к
       * которым никто не вернётся, а таких большинство.
       */
      if (answer.kind === 'project') {
        await decomposeIfNeeded(
          { db, ai: { db, ...deps.ai } },
          { item: answer.item, userId: batch.userId, batchId: batch.id },
        );

        await tell(describeProject(answer.item, await contextOf(db, answer.item.id), texts));

        continue;
      }

      const header =
        answer.kind === 'today'
          ? texts.backlog.today
          : answer.kind === 'about'
            ? texts.backlog.about
            : texts.backlog.nothing;

      /**
       * Шапка называет день — значит вчерашнее «завтра» в строке лишнее
       * (задача 3.78). Срезается только у дела, чей срок и есть сегодня.
       */
      const body =
        answer.kind === 'nothing'
          ? []
          : answer.items.map((item) =>
              texts.backlog.line(
                answer.kind === 'today'
                  ? titleUnderDayHeader(item, { now, timeZone: context.timeZone })
                  : item.text,
              ),
            );

      await tell([header, ...body].join('\n'));
    }

    if (parsed.length === 0) {
      // Правки без новых мыслей тоже меняют ветки — обновить надо здесь,
      // потому что ниже этой ветки обработка уже не идёт.
      await refreshTouched(
        db,
        deps,
        target,
        { userId: batch.userId, timeZone: context.timeZone, textProfile: context.textProfile },
        touchedTopics,
      );

      /**
       * Отложенное подтверждаем всегда: человек должен знать, что
       * сказанное сохранено, даже если мы уже ответили о другом.
       */
      if (deferred.length > 0) await answer(texts.answer.savedUnparsed);

      /**
       * Сценарий 8 §2: закрыв запись, бот спрашивает, продолжаем или на
       * сегодня достаточно.
       *
       * **Здесь, а не после каждого закрытого дела.** §13.9 не даёт двух
       * вопросов в реплике, а три закрытых дела подряд дали бы три
       * вопроса — продукт про выдох превратился бы в опрос. И только
       * когда разбирать больше нечего: если в выгрузке были новые мысли,
       * обычный ответ и так заканчивается «С чего начнём?», и второй
       * вопрос был бы лишним.
       *
       * Только у выполнения. У отмены §13.5 требует «подтверждение в одну
       * строку» и вопроса не хочет: человек, отказавшийся от дела, не
       * ждёт, что его спросят, чем он займётся дальше.
       */
      if (happened.closed && !happened.asked) {
        // Своим сообщением, а не правкой статусного: иначе затрёт
        // подтверждение выполнения вместе с кнопкой отката.
        await tell(texts.resolver.goOn, [
          { label: texts.resolver.buttonGoOn, action: ANSWER_ACTION.now },
          { label: texts.resolver.buttonEnough, action: ANSWER_ACTION.later },
        ]);
      } else if (deferred.length === 0 && !happened.said) {
        /**
         * «Я здесь. Расскажешь, что в голове?» — только когда сказать
         * больше нечего. После ответа на вопрос или после правки эта
         * реплика читается как «я тебя не поняла».
         */
        await answer(texts.answer.nothingToParse);
      }

      return;
    }

    const dumpText = parsed.map((segment) => segment.text).join('\n');

    /**
     * Разбору — речь с правками на своих местах (задача 3.57).
     *
     * Отдельно от `dumpText`: тот идёт в промпт классификации под словами
     * «человек сказал так» и в презентацию, и менять его — другая задача с
     * другим замером. Условия вплетения — в `patch-in-place.ts`.
     */
    const forExtraction = weaveForExtraction(parsed, routed.segments);

    // ── Единицы ─────────────────────────────────────────────────────────
    const extracted = await extractUnits(heavy, {
      input: forExtraction,
      userId: batch.userId,
      batchId: batch.id,
    });

    if (!extracted.ok) {
      await saveDraft(db, {
        userId: batch.userId,
        batchId: batch.id,
        text: dumpText,
        reason: `извлечение не удалось: ${extracted.problem}`,
      });
      await answer(texts.answer.savedUnparsed);
      return;
    }

    if (extracted.units.length === 0) {
      await answer(texts.answer.nothingToParse);
      return;
    }

    // ── Классификация ───────────────────────────────────────────────────
    /**
     * Базовые сферы появляются на первой разобранной выгрузке, а не на
     * онбординге (задача 3.43).
     *
     * До этого темы рождались только на последнем шаге опроса. Проджект
     * заказчицы застрял на предпоследнем — не ответил и стал наговаривать
     * дальше, как §12.2 и разрешает. Итог: тридцать две записи с метками
     * сфер и ни одной ветки в чате. Его слова: «он даже по сферам не
     * распределяет».
     *
     * §8.1 обещает: «женщина открывает бота и сразу видит ветки по сферам
     * жизни». §13.1 запрещает опрос до первой выгрузки. Вместе это значит
     * одно: ветки не могут ждать ответов. Базовый набор §6.4 — и так
     * то, что создаётся при пустом ответе; здесь он создаётся раньше, а
     * шаг «какие сферы важны» потом его уточняет: невыбранное уходит в
     * архив, выбранное добавляется.
     */
    const known = await topicsFor(db, batch.userId);
    const spheresCreated = known.own
      ? false
      : (await createChosenTopics(db, batch.userId, [])).created > 0;
    if (spheresCreated) {
      deps.logger?.info({ userId: batch.userId }, 'Базовые сферы созданы на первой выгрузке');
    }
    const topics = spheresCreated ? await topicsFor(db, batch.userId) : known;

    const classified = await classifyUnits(heavy, {
      units: extracted.units,
      // §3.8б: «запомни» живёт в сказанном, а не в единицах.
      spoken: dumpText,
      /**
       * А правилам дня — речь целиком (задача 3.56). Маршрутизатор
       * убирает из `dumpText` отрезки с намерением `PATCH`, и вместе с
       * ними уходит отмена дня: «Хотя нет, давай мойку лучше в пятницу».
       */
      speech: combined,
      topics: topics.names,
      defaultTopic: threadTopic?.name ?? topics.defaultName,
      timeZone: context.timeZone,
      now,
      userId: batch.userId,
      batchId: batch.id,
    });

    if (!classified.ok) {
      await saveDraft(db, {
        userId: batch.userId,
        batchId: batch.id,
        text: dumpText,
        reason: `классификация не удалась: ${classified.problem}`,
      });
      await answer(texts.answer.savedUnparsed);
      return;
    }

    /**
     * §8.1: тема ветки — умолчание, а не приказ.
     *
     * Классификация уже получила её параметром `defaultTopic`, но тот
     * срабатывает только на теме, которой у человека нет, — то есть в
     * бою никогда. Подстановка живёт здесь: см. thread-topic.ts.
     */
    const units = applyThreadTopic(classified.items, {
      threadTopic: threadTopic?.name,
      catchAllTopic: topics.defaultName,
    });

    // ── Сохранение ──────────────────────────────────────────────────────
    const toSave = await withEmbeddings(db, deps, batch, units);

    /**
     * Повтор той же выгрузки не заводит вторую запись (см. same-text.ts).
     *
     * Открытые записи всё равно читаются ниже для отбора — но читать их
     * надо **до** вставки, иначе только что вставленное само себе
     * покажется повтором.
     *
     * Сверка идёт по трёмстам свежайшим открытым записям — потолку
     * `openItemsFor`. Повтор того, что человек говорил триста записей
     * назад, пройдёт незамеченным, и это осознанный предел: тянуть в
     * память весь бэклог ради редкого случая дороже одной лишней строки.
     */
    const before = await openItemsFor(db, batch.userId);
    const split = splitKnown(toSave, knownByText(before));

    const saved = await saveItems(db, {
      userId: batch.userId,
      batchId: batch.id,
      items: split.fresh,
    });

    for (const item of [...saved, ...split.known]) mentioned.add(item.id);

    /**
     * Второй проход по правкам, чья цель не нашлась (задача 3.24).
     *
     * **Найдено на боевом 01.09.2026.** Человек в одной выгрузке сказал
     * «…приходила не в 11, а в 9», и сразу «Нет, лучше не в 9, а в 9 30».
     * Первая фраза стала записью, вторая — правкой, но правки разбираются
     * до сохранения, и цели для неё в базе ещё не было. Поправка ушла в
     * невидимый черновик, а в записи осталось промежуточное значение — 9
     * вместо 9:30. Человек об этом не узнал.
     *
     * Теперь записи сохранены, и та же правка находит цель среди них.
     *
     * **Почему второй проход, а не перестановка шагов.** Разбирать правки
     * после сохранения целиком нельзя: «нет, в пятницу» тогда попадало бы
     * в свежую запись вместо прежней — ровно то, от чего порядок и
     * защищает. Второй проход платит лишним вызовом резолвера только
     * там, где первый не справился.
     *
     * Стоит он ноль, когда таких правок нет, — а это обычный случай.
     */
    for (const segment of searchOwnBatch) {
      await useOutcome(segment, await resolveOne(segment, true), 'ownBatch');
    }

    /**
     * Последняя попытка — по всем записям человека.
     *
     * Сюда попадает правка, которая шла после мысли (а значит выглядела
     * поправкой к ней), но в своей выгрузке цели не нашла. Значит человек
     * всё-таки говорил о прошлом — например, вспомнил о старом деле в
     * середине потока.
     */
    for (const segment of searchEverywhere) {
      await useOutcome(segment, await resolveOne(segment), 'wide');
    }

    // ── Отбор и ответ ───────────────────────────────────────────────────
    const composition = composeOf(units);
    /** Слова человека о состоянии: по ним решается, сколько дел показать. */
    const emotionTexts = units.filter((unit) => unit.type === 'EMOTION').map((unit) => unit.text);
    const noStrength = emotionTexts.some((text) => saysNoStrength(text));

    const energyNow = await applyEmotion(
      db,
      deps,
      batch.userId,
      emotionTexts,
      effectiveEnergy(context.state, context.energyDefault, { now, timeZone: context.timeZone }),
      now,
    );

    const selection = selectForOutput(await openItemsFor(db, batch.userId), {
      energy: energyNow,
      now,
      timeZone: context.timeZone,
      mentioned,
      /**
       * §13.7 и §21 п.7: «сил нет вовсе» — действие в ответе ровно одно.
       *
       * Предел ставится здесь, а не только через уровень сил: требование
       * про **эту** выгрузку, и оно не должно зависеть от того, каким
       * оказался сохранённый уровень. Два дела человеку, который только
       * что сказал «сил нет», — это спор с ним.
       *
       * **Прочие состояния предела не ставят (задача 3.47).** «Задолбался»
       * и «ничего не успеваю» дают три дела: так просил заказчик, и так
       * же поступает главный эталон §13.2, где усталость названа прямо.
       */
      ...(noStrength ? { cap: 1 } : {}),
    });

    /**
     * §12.2: онбординг идёт после первой выгрузки. Начинается он, когда
     * разбор действительно состоялся: спрашивать сферы жизни у человека,
     * чья первая выгрузка оказалась «привет», рано.
     *
     * Свой вопрос ответ при этом не задаёт: его место занимает первый
     * вопрос онбординга, иначе у человека окажется два открытых вопроса
     * подряд, чего §13.9 не допускает.
     */
    const onboarding = await onboardingStateOf(db, batch.userId);

    /**
     * Пока опрос идёт, разбор своего вопроса не задаёт.
     *
     * Человек мог наговорить ещё раз, не ответив на предыдущий вопрос
     * онбординга. Тот вопрос никуда не делся, и добавить к нему второй
     * значит нарушить §13.9 — пусть и двумя репликами, а не одной.
     */
    const onboardingOpen = onboarding.step > 0 && onboarding.step < STEP.done;

    /**
     * Застрявший опрос дозадаётся, а не только начинается (задача 3.43).
     *
     * Прежде вопрос уходил только с нуля. Кто не ответил и стал говорить
     * дальше, оставался на своём шаге навсегда: 2.13 обещала, что
     * «незаданные вопросы дождутся своей очереди», а очередь не
     * наступала. Так проджект заказчицы простоял сутки на вопросе про
     * вечер — и без последнего шага у него не появилось ни одной сферы.
     *
     * Один вопрос на реплику при этом соблюдён: свой вопрос разбор в
     * это время не задаёт (см. выше), место занимает вопрос опроса.
     */
    const startOnboarding =
      deps.onboarding !== undefined &&
      target !== undefined &&
      (onboarding.step === 0 || onboardingOpen)
        ? {
            sender: deps.onboarding,
            target,
            step: onboarding.step === 0 ? firstStep(onboarding.name) : onboarding.step,
          }
        : undefined;

    /**
     * §13.3: короткое добавление не порождает выдачу действий.
     *
     * Решается здесь, а не в промпте: правило, живущее в промпте, плавает
     * от версии к версии, и «Записала» приходило бы через раз. К форме
     * ответа человек привыкает быстрее, чем к чему бы то ни было ещё.
     */
    const quickAdd = isQuickAdd({
      /**
       * Во время онбординга режим не включается.
       *
       * §13.3 просит не открывать разговор, а онбординг — это разговор,
       * который уже идёт: его вопрос приходит вместе с этой же репликой.
       * «Записала.» проглотило бы контекст, и человек получил бы вопрос
       * про сферы жизни без всякого повода. Поймали два старых теста.
       */
      asked: happened.asked || startOnboarding !== undefined || onboardingOpen,
      /**
       * Часть сказанного не разобралась — значит не быстрое добавление
       * (задача 3.32, найдено живым прогоном через Telegram 02.09.2026).
       *
       * Человек повторил выгрузку целиком: одно дело узналось как уже
       * имеющееся, а поправка к нему ушла в черновик. Осталась одна
       * запись и маркер «ещё» в тексте — и бот ответил «Записала.» на то,
       * чего не записывал, промолчав о неразобранном.
       *
       * §13.3 задумано для «добавь ещё X» — короткой просьбы и ничего
       * больше. Если в выгрузке осталось непонятое, короткой репликой
       * отвечать нельзя: она делает вид, что всё в порядке.
       */
      parked: happened.parked,
      /**
       * Считается всё, что вышло из выгрузки, а не только заведённое.
       *
       * Отсев повторов не должен менять **разговор** — только базу. Иначе
       * «добавь ещё купить витамины» на уже имеющемся деле переставало бы
       * быть быстрым добавлением и отвечало полным разбором: человек
       * сказал одно дело, а получил список.
       */
      created: saved.length + split.known.length,
      hidden: selection.hidden,
      emotions: composition.emotions,
      spoken: dumpText,
    });

    /**
     * §13.2: большая цель урезается до посильного первого шага.
     *
     * В выдаче проект занимает одну строку, и это должна быть строка
     * шага, а не заголовок цели. «Спланировать годовщину родителей» в
     * ответ на «что сегодня» — это не действие, а напоминание о горе.
     *
     * Раскладывать здесь не станем: разложение ленивое и случается при
     * обращении к проекту. Неразложенный проект показывается как есть —
     * так же, как показывался до третьего этапа.
     */
    const actions: string[] = [];

    for (const item of selection.shown) {
      if (!item.isProject) {
        actions.push(item.text);
        continue;
      }

      const step = await nextStepOf(db, item.id);
      actions.push(step?.text ?? item.text);
    }

    const presented = await presentDump(ai, {
      composition,
      actions,
      hidden: selection.hidden,
      profile: context.textProfile,
      userId: batch.userId,
      batchId: batch.id,
      /**
       * Вопрос уже занят — своего ответ не задаёт.
       *
       * Так было у онбординга; с §13.6 сюда добавился экран возвращения.
       * Инвариант «один вопрос» продукт понимает как один на обмен, а не
       * на реплику: два вопроса подряд разными сообщениями — тот же
       * допрос.
       */
      omitQuestion: happened.asked || startOnboarding !== undefined || onboardingOpen,
      quickAdd,
    });

    deps.logger?.info(
      {
        batchId: batch.id,
        segments: routed.segments.length,
        deferred: deferred.length,
        units: extracted.units.length,
        saved: split.fresh.length,
        known: split.known.length,
        shown: selection.shown.length,
        hidden: selection.hidden,
        corrections: classified.corrections,
        acknowledgementReplaced: presented.replaced,
      },
      'Выгрузка разобрана',
    );

    // §13.2: под разбором три кнопки, и одна из них ведёт к остальным
    // делам. Без неё человек не знал, куда они делись.
    await answer(presented.reply.text, presented.reply.buttons);

    /**
     * §8.2: сводка темы обновляется правкой закреплённого сообщения.
     *
     * **После ответа человеку, а не до.** Обновление сводок — это до трёх
     * обращений к Telegram с паузами между ними, и заставлять человека
     * ждать их, чтобы увидеть свой разбор, — значит перепутать главное с
     * подсобным. Ответ уходит первым.
     *
     * Обновляются только затронутые темы: трогать девять веток из-за
     * одной новой записи значит без нужды упираться в ограничение частоты.
     *
     * Отказ здесь разбор не роняет: сводка — удобство, записи — суть.
     */
    if (deps.topics && target) {
      await refreshSummaries(
        { db, gateway: deps.topics, logger: deps.logger },
        {
          userId: batch.userId,
          chatId: target.chatId,
          /**
           * Сферы только что появились — ветки создаются **все**, включая
           * пустые: человек должен увидеть свою структуру целиком, а не
           * только те сферы, куда что-то попало. То же правило, что на
           * онбординге. Дальше — только затронутые.
           */
          topicNames: spheresCreated
            ? [...topics.names]
            : [...new Set([...toSave.map((item) => item.topic), ...touchedTopics])],
          timeZone: context.timeZone,
          profile: context.textProfile,
        },
      );
    }

    /**
     * Бот замечает повторяемость (задача 3.8в).
     *
     * **Предложение конкурирует за единственный вопрос и проигрывает.**
     * Инвариант 10: один вопрос в реплике. Уточняющий вопрос резолвера
     * всегда важнее — там цена ошибки выше, там портится существующая
     * запись. Если он уже задан, предложение не задаётся вовсе и не
     * встаёт в очередь: дело регулярное, оно повторится, и случай
     * представится снова.
     *
     * Вопрос онбординга занимает то же единственное место, поэтому блок
     * стоит после него, а не до: иначе человек получил бы два вопроса в
     * одном обмене, чего §13.9 не допускает.
     */
    if (deps.suggestRecurrence === true && !happened.asked && !startOnboarding && !onboardingOpen) {
      for (const item of saved) {
        const suggestion = await suggestRecurrence(
          { db, ...(deps.logger === undefined ? {} : { logger: deps.logger }) },
          { userId: batch.userId, item, now },
        );

        if (suggestion === undefined) continue;

        await tell(
          texts.resolver.noticed(
            suggestion.title,
            datesInWords(suggestion.dates, context.timeZone),
            rhythmInWords(suggestion.rhythm),
          ),
          suggestButtons(suggestion.suggestionId, texts),
        );

        // Одно предложение на выгрузку, даже если совпадений несколько.
        break;
      }
    }

    if (startOnboarding) {
      const question = questionFor(startOnboarding.step, { texts, name: onboarding.name });

      if (question) {
        await setStep(db, batch.userId, startOnboarding.step);
        await startOnboarding.sender.ask({
          chatId: startOnboarding.target.chatId,
          threadId: startOnboarding.target.threadId,
          text: question.text,
          rows: question.rows,
        });
      }
    }
  };
}
