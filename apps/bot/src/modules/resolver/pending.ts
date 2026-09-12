import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import type { ResolverAnswer } from '../ai/schemas/index.js';
import { hasDraft, saveDraft } from '../items/items.repo.js';
import { answerRemainder, readAnswer } from './answer.js';
import { applyDecision, type Applied } from './patch.js';
import {
  answerQuestion,
  closeOpenQuestion,
  openQuestionOf,
  unfinishedSeparateOf,
} from './questions.repo.js';

/**
 * Судьба открытого вопроса при новой выгрузке (§7.3 ТЗ, задача 3.6).
 *
 * Две ветки, обе из ТЗ:
 *
 * - человек **ответил голосом** — «да, к прошлой», «это новое», «не
 *   знаю». Голосовой ответ обязан работать так же, как нажатие кнопки:
 *   весь продукт про то, чтобы говорить, а не нажимать;
 * - человек **не ответил и прислал новое** — «вопрос снимается, сегмент
 *   трактуется как новая запись, и бот к нему больше не возвращается:
 *   продукт не имеет права превращаться в допрос».
 *
 * **Запись заводится только там, где человек её попросил.** «Это новое»
 * — попросил, и сказанное уходит в разбор вместе с текущей выгрузкой.
 * «Не знаю» и молчание — не попросил, и сказанное сохраняется
 * черновиком: превратить «нет, в пятницу» в задачу «в пятницу» хуже, чем
 * не разобрать вовсе. Тот же довод второй этап уже применил к правкам.
 */

export type PendingKind =
  /** Открытого вопроса не было. */
  | 'none'
  /** «К прошлой»: изменение применено, есть что отменять. */
  | 'applied'
  /** «К прошлой», но применить не вышло — см. `why`. */
  | 'nothingToApply'
  /** «Это новое»: сказанное пойдёт в разбор этой выгрузки. */
  | 'separate'
  /** Ответ есть, но прочитать его не вышло. */
  | 'unclear'
  /** Ответа не было: вопрос снят новой выгрузкой. */
  | 'superseded';

export interface PendingResult {
  readonly kind: PendingKind;
  readonly applied?: Applied | undefined;
  /**
   * Почему «к прошлой» не применилось (ревизия этапа 3, A3): запись уже
   * так, срок отвергнут или записи нет. Конвейер подбирает по этому
   * слово — раньше на всё отвечал «Добавила к прошлой».
   */
  readonly why?: 'unchanged' | 'refused' | 'gone' | undefined;
  /**
   * Сказанное, которое надо разобрать вместе с этой выгрузкой.
   *
   * Не отдельным вызовом модели: выгрузка всё равно сейчас разбирается,
   * и лишний вызов стоил бы денег ради того же результата.
   */
  readonly carryOver?: string | undefined;
  /**
   * В ответе были слова сверх ответа, и они сохранены черновиком (3.44).
   *
   * «Да, к прошлой, и ещё купить чехол»: правка применена, а «купить
   * чехол» не выброшено — §9.1. Черновиком, а не записью: остаток
   * ответа может быть и пояснением («к прошлой, той что про врача»), и
   * выдавать его за дело нельзя.
   */
  readonly leftoverSaved?: boolean | undefined;
}

export interface SettleParams {
  readonly userId: string;
  readonly batchId: string;
  readonly timeZone: string;
  /** Текст сегмента с намерением `ANSWER`. Нет — человек не отвечал. */
  readonly answerText?: string | undefined;
  readonly now?: Date | undefined;
  readonly logger?: Logger | undefined;
}

export async function settlePendingQuestion(
  db: Database,
  params: SettleParams,
): Promise<PendingResult> {
  const now = params.now ?? new Date();

  /**
   * Ответ есть, а вопроса, на который он отвечал, уже нет.
   *
   * Гонка, которую код описывает сам ниже: кнопку нажали, пока шли
   * расшифровка и маршрутизация. Саму правку применила та кнопка — её
   * повторять нельзя. А вот сказанное **сверх** ответа («да, к прошлой,
   * и ещё купить чехол») до этой правки просто выбрасывалось: ни записи,
   * ни черновика, ни строки в журнале. §9.1 запрещает ровно это.
   *
   * Оба места потери сведены к одному телу: страж иначе покрывал бы одну
   * ветку и молчал про вторую.
   */
  const rescueOrphanAnswer = async (): Promise<PendingResult> => {
    const said = params.answerText;
    if (said === undefined) return { kind: 'none' };

    /**
     * Молчим, когда терять нечего.
     *
     * Голое «да» без вопроса — не отказ: содержания в нём нет, кнопка
     * своё сделала. Строка в журнале на каждый такой случай обесценила бы
     * ту, ради которой журнал и читают.
     */
    const orphaned = answerRemainder(said);
    if (orphaned === '') return { kind: 'none' };

    /**
     * Дважды не кладём.
     *
     * Выгрузка возвращается в очередь при нашем простое и разбирается
     * снова — до пяти раз. Без этой проверки человек получил бы пять
     * копий черновика и пять реплик «Остальное сохранила отдельно».
     */
    if (await hasDraft(db, { batchId: params.batchId, text: orphaned })) {
      return { kind: 'none' };
    }

    await saveDraft(db, {
      userId: params.userId,
      batchId: params.batchId,
      text: orphaned,
      reason: 'слова из ответа на уже снятый вопрос — сохранены отдельно',
    });

    params.logger?.warn(
      { userId: params.userId, batchId: params.batchId },
      'Ответ пришёл без открытого вопроса — слова сверх ответа сохранены черновиком',
    );

    return { kind: 'none', leftoverSaved: true };
  };

  const open = await openQuestionOf(db, params.userId, now);

  if (!open) {
    /**
     * Открытого вопроса нет — но, может быть, прошлый заход этой же
     * выгрузки не довёз ответ до разбора (задача 3.79).
     *
     * Так бывает при нашем простое: вопрос помечен «это новое», а разбор
     * сорвался — модель недоступна или перейдён потолок расхода. Выгрузка
     * вернулась в очередь, и на втором заходе отрезок из ответа пропал бы
     * молча: остальное разобралось, а он нет.
     */
    const unfinished = await unfinishedSeparateOf(db, {
      userId: params.userId,
      batchId: params.batchId,
    });

    if (unfinished === undefined) return await rescueOrphanAnswer();

    params.logger?.info(
      { userId: params.userId, batchId: params.batchId },
      'Ответ «это новое» с прошлого захода возвращён в разбор',
    );

    return { kind: 'separate', carryOver: unfinished };
  }

  /** Сказанное не пропадает ни в одном исходе (§9.1). */
  const park = async (reason: string): Promise<void> => {
    await saveDraft(db, {
      userId: params.userId,
      batchId: open.batchId,
      text: open.segment,
      reason,
    });
  };

  if (params.answerText === undefined) {
    await closeOpenQuestion(db, params.userId, 'superseded', now);
    await park('вопрос снят новой выгрузкой — ответа не было');

    params.logger?.info({ userId: params.userId }, 'Открытый вопрос снят новой выгрузкой');
    return { kind: 'superseded' };
  }

  const reading = readAnswer(params.answerText);

  if (reading === 'unclear') {
    // Ответ был, но что он значит — неизвестно. Переспрашивать §7.3
    // запрещает, угадывать тем более.
    await closeOpenQuestion(db, params.userId, 'superseded', now);
    await park('ответ на вопрос не прочитан');

    /**
     * Содержание за оговоркой не пропадает (ревизия этапа 3, B3).
     *
     * «Не помню, но перенеси врача на среду»: признак неуверенности
     * читается раньше содержания, и «перенеси врача на среду» не шло ни
     * в разбор, ни в черновик. Разбирать его как мысль нельзя —
     * распоряжение стало бы записью (3.44), — но сохранить и сказать об
     * этом можно.
     */
    if (answerRemainder(params.answerText) !== '') {
      await saveDraft(db, {
        userId: params.userId,
        batchId: open.batchId,
        text: params.answerText,
        reason: 'ответ с оговоркой не прочитан — слова сохранены',
      });
      return { kind: 'unclear', leftoverSaved: true };
    }

    return { kind: 'unclear' };
  }

  /**
   * Это была мысль, а не ответ (3.44): маршрутизатор ошибся. Вопрос
   * снимается, как при любой новой выгрузке без ответа, сказанное тогда
   * сохраняется, а сама реплика уходит в разбор — через `carryOver`.
   */
  if (reading === 'content') {
    await closeOpenQuestion(db, params.userId, 'superseded', now);
    await park('вопрос снят новой мыслью — ответа не было');

    params.logger?.info({ userId: params.userId }, 'Ответом оказалась новая мысль, вопрос снят');
    return { kind: 'superseded', carryOver: params.answerText };
  }

  /** Слова сверх ответа — в черновик, чтобы не пропали (§9.1, 3.44). */
  const leftover = answerRemainder(params.answerText);
  const keepLeftover = async (): Promise<boolean> => {
    if (leftover === '') return false;
    await saveDraft(db, {
      userId: params.userId,
      batchId: open.batchId,
      text: leftover,
      reason: 'слова из ответа на вопрос — сохранены отдельно',
    });
    return true;
  };

  /**
   * Между чтением и ответом вопрос мог снять кто-то ещё — например
   * нажатие кнопки, пришедшее пока шла расшифровка.
   *
   * Дальше всё как при ответе без вопроса: саму правку применила та
   * кнопка, а слова сверх ответа спасать было некому — `keepLeftover`
   * объявлен выше, но сюда не доходил, и текст пропадал молча.
   */
  if (reading === 'separate') {
    const marked = await answerQuestion(db, {
      questionId: open.id,
      userId: params.userId,
      outcome: 'separate',
      now,
    });
    if (marked.kind === 'stale') return await rescueOrphanAnswer();

    return { kind: 'separate', carryOver: open.segment, leftoverSaved: await keepLeftover() };
  }

  /**
   * Пометка ответа и применение — одной транзакцией (ревизия этапа 3,
   * B1). Раньше вопрос помечался «привязан» до применения: сорвётся
   * применение — вопрос закрыт, правка не сделана, а повторный заход её
   * не находит. Теперь при срыве откатывается и пометка.
   */
  const applying = await db.transaction(async (tx) => {
    const marked = await answerQuestion(tx, {
      questionId: open.id,
      userId: params.userId,
      outcome: 'attached',
      now,
    });
    if (marked.kind === 'stale') return { kind: 'stale' } as const;

    return await applyDecision(tx, {
      userId: params.userId,
      itemId: open.itemId,
      action: open.action === 'complete' || open.action === 'cancel' ? open.action : 'update',
      /**
       * Режим правки из вопроса — §7.4 (задача 3.82).
       *
       * Голосовой ответ и нажатие кнопки обязаны вести себя одинаково:
       * §7.3 требует этого прямо. Без режима оба применялись заменой, и
       * подробность из вопроса про дополнение выбрасывалась.
       */
      ...(open.mode === 'append' ? { mode: 'append' as const } : {}),
      changes: open.changes as ResolverAnswer['changes'],
      spoken: open.segment,
      timeZone: params.timeZone,
      now,
      reason: 'человек подтвердил голосом',
      changedBy: 'user',
    });
  });

  if (applying.kind === 'stale') return await rescueOrphanAnswer();

  const leftoverSaved = await keepLeftover();

  return applying.kind === 'applied'
    ? { kind: 'applied', applied: applying.applied, leftoverSaved }
    : { kind: 'nothingToApply', why: applying.kind, leftoverSaved };
}
