import { GrammyError } from 'grammy';
import type { Logger } from 'pino';

import type { Executor } from '../../infra/db.js';
import { isBlockedError } from '../users/blocked.js';
import { markBlocked } from '../users/users.repo.js';
import {
  LEASE_MS,
  broadcastById,
  claimDelivery,
  countsOf,
  finishBroadcast,
  markDelivery,
  nextPending,
  releaseDelivery,
  stopRequested,
} from './broadcast.repo.js';

/**
 * Отправка рассылки (§15 ТЗ, задача 4.10).
 *
 * §15 требует «отдельный воркер с throttling под глобальный лимит
 * Telegram, пропуск заблокировавших, возможность остановить на
 * середине». Условие готовности названо числом: тысяча адресатов **не
 * ловит 429** и встаёт по кнопке.
 *
 * **Почему это отдельный воркер, а не проход планировщика.** У
 * планировщика лимит свой и мягкий: двадцать напоминаний в минуту с
 * паузой в 120 мс. Рассылка идёт в тысячу адресов подряд и упирается уже
 * не в вежливость, а в глобальный лимит бота — около тридцати сообщений
 * в секунду на всё, включая ответы живым людям в это же время. Смешать
 * их значило бы: либо рассылка ползёт сутки, либо разбор чужой мысли
 * ждёт, пока она кончится.
 *
 * **Темп задан числом в настройках, а не константой.** Лимит Telegram не
 * документирован точно и меняется; §15 как раз про то, чтобы такие числа
 * правились без выкладки (задача 4.9). Умолчание — двадцать в секунду:
 * треть запаса оставлена живым людям, которые пишут боту в эту же
 * минуту.
 *
 * **Ограничение частоты — это не пауза после отправки.** Пауза после
 * отправки складывается с временем самого запроса: при паузе 50 мс и
 * запросе 200 мс выходит четыре сообщения в секунду вместо двадцати, и
 * рассылка на тысячу идёт четыре минуты вместо одной. Здесь выдерживается
 * **интервал между началами** отправок: медленный запрос съедает свою
 * паузу сам.
 *
 * **429 не считается неудачей получателя.** Он означает «мы слишком
 * быстро», а не «этому человеку не доставить»: строка остаётся
 * неотправленной, а воркер ждёт столько, сколько попросил Telegram.
 * Пометить такую строку `failed` значило бы потерять человека из-за
 * своей же спешки.
 */

/** Кому и что отправляем. Интерфейс — чтобы проверки не звали Telegram. */
export interface BroadcastSender {
  send(params: { readonly tgId: number; readonly text: string }): Promise<void>;
}

export interface BroadcastClock {
  /** Сколько миллисекунд прошло. В проверках — поддельные. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const REAL_CLOCK: BroadcastClock = {
  now: () => Date.now(),
  sleep: async (ms) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  },
};

/**
 * Сколько сообщений отправляем за один заход воркера.
 *
 * Заход не должен идти долго: BullMQ держит замок задания тридцать
 * секунд, и задание, не уложившееся в него, считается зависшим и
 * запускается вторым воркером — то есть присылает людям второе
 * сообщение. Двести штук при двадцати в секунду — десять секунд, с
 * запасом; остаток берёт следующий заход.
 */
export const CHUNK = 200;

/** Умолчание темпа: сообщений в секунду. Правится настройкой. */
export const DEFAULT_PER_SECOND = 20;

export interface BroadcastStep {
  /** Отправлено в этом заходе. */
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
  /**
   * Осталось незаконченных: неотправленные **и взятые**. Ноль — конец.
   *
   * Взятые считаются с ревизии четвёртого этапа: строка, взятая и не
   * дошедшая до отметки, в `pending` не попадает, и рассылка
   * объявлялась «разослана», хотя человек письма не получил.
   */
  readonly left: number;
  /** Надо ли заходить снова. */
  readonly more: boolean;
  /**
   * Через сколько заходить снова, если раньше нет смысла.
   *
   * Пусто — «можно сразу». Стоит там, где остались только взятые
   * строки: перезахватить их получится лишь по истечении срока взятия,
   * и заход раньше вернул бы пустую порцию.
   */
  readonly afterMs?: number | undefined;
  /** Встала по кнопке. */
  readonly stopped: boolean;
}

export interface BroadcastDeps {
  readonly db: Executor;
  readonly sender: BroadcastSender;
  readonly logger?: Logger | undefined;
  readonly clock?: BroadcastClock | undefined;
  /** Сообщений в секунду. Без него — умолчание. */
  readonly perSecond?: number | undefined;
  readonly chunk?: number | undefined;
}

/** Сколько ждать после 429, если Telegram не сказал сам. */
const BLIND_BACKOFF_MS = 1_000;

/** Пауза из ответа Telegram при 429, в миллисекундах. */
function retryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof GrammyError)) return undefined;
  if (error.error_code !== 429) return undefined;

  const seconds = error.parameters.retry_after;

  return typeof seconds === 'number' ? seconds * 1_000 : BLIND_BACKOFF_MS;
}

/**
 * Один заход воркера: порция сообщений с выдержкой темпа.
 *
 * Возвращает, что случилось, и надо ли заходить снова. Решение о повторе
 * оставлено вызывающему: очередь — его дело, а не наше.
 */
export async function sendChunk(deps: BroadcastDeps, broadcastId: string): Promise<BroadcastStep> {
  const clock = deps.clock ?? REAL_CLOCK;
  const perSecond = Math.max(1, deps.perSecond ?? DEFAULT_PER_SECOND);
  const spacingMs = Math.ceil(1_000 / perSecond);
  const chunk = deps.chunk ?? CHUNK;

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  /** Когда началась прошлая отправка: от неё считается интервал. */
  let previousStart: number | undefined;

  const state = await broadcastById(deps.db, broadcastId);

  if (state === undefined) {
    // Рассылку удалили из-под нас — заходить снова незачем.
    return { sent, skipped, failed, left: 0, more: false, stopped: false };
  }

  /**
   * Текст читается один раз: после старта он неизменен.
   *
   * Иначе половина людей получила бы одно сообщение, половина другое, и
   * разобраться в жалобе «мне пришло не то» было бы нечем.
   */
  const text = state.text;

  /**
   * Порция берётся одним запросом, а не по строке.
   *
   * По строке выходило три запроса на сообщение — три тысячи на тысячу
   * адресатов. От двойной отправки защищает не это, а взятие строки
   * перед каждой отправкой (см. ниже).
   */
  const batch = await nextPending(deps.db, broadcastId, chunk);

  for (const delivery of batch) {
    /**
     * Просьба остановиться читается **перед каждой** отправкой.
     *
     * Не раз в порцию: порция — это двести сообщений, и человек,
     * нажавший «Остановить», ждал бы их все. §15 просит остановить на
     * середине, а не «на границе порции». Запрос дешёвый — одно поле.
     */
    if (await stopRequested(deps.db, broadcastId)) {
      await finishBroadcast(deps.db, broadcastId, 'stopped');
      const counts = await countsOf(deps.db, broadcastId);

      return {
        sent,
        skipped,
        failed,
        left: counts.pending + counts.sending,
        more: false,
        stopped: true,
      };
    }

    // Выдержка темпа: интервал считается от **начала** прошлой отправки.
    if (previousStart !== undefined) {
      const waited = clock.now() - previousStart;
      if (waited < spacingMs) await clock.sleep(spacingMs - waited);
    }

    previousStart = clock.now();

    /**
     * Строка берётся себе **перед** отправкой.
     *
     * Не после: отметка после отправки не защищает ни от чего — оба
     * воркера уже написали человеку, и вторая отметка лишь скрывает это
     * от отчёта. Ложь здесь означает «строку уже взял другой», и тогда
     * отправлять нельзя.
     *
     * Два воркера — не выдумка: очередь пускает одного, но задание, не
     * уложившееся в замок BullMQ, считается зависшим и запускается
     * вторым.
     */
    if (!(await claimDelivery(deps.db, delivery.id))) continue;

    try {
      await deps.sender.send({ tgId: delivery.tgId, text });
      await markDelivery(deps.db, delivery.id, { status: 'sent' });
      sent++;
    } catch (error) {
      const backoff = retryAfterMs(error);

      if (backoff !== undefined) {
        /**
         * Мы слишком быстро. Строка остаётся неотправленной.
         *
         * Заход прекращается, а не продолжается после сна: раз лимит
         * задет, темп надо пересмотреть, а не доскакать порцию до конца.
         * Следующий заход начнётся с той же строки.
         */
        deps.logger?.warn(
          { broadcastId, waitMs: backoff },
          'Telegram ограничил частоту рассылки, жду',
        );

        // Строка возвращается в очередь: 429 — не вина получателя.
        await releaseDelivery(deps.db, delivery.id);
        await clock.sleep(backoff);

        const counts = await countsOf(deps.db, broadcastId);

        return {
          sent,
          skipped,
          failed,
          left: counts.pending + counts.sending,
          more: true,
          stopped: false,
        };
      }

      if (isBlockedError(error)) {
        // Заблокировал или удалил чат: пропуск, а не неудача. И пометка
        // в профиле, чтобы следующая рассылка его уже не считала.
        await markBlocked(deps.db, delivery.tgId);
        await markDelivery(deps.db, delivery.id, { status: 'skipped' });
        skipped++;
        continue;
      }

      const message = error instanceof Error ? error.message : String(error);
      await markDelivery(deps.db, delivery.id, { status: 'failed', error: message });
      failed++;

      deps.logger?.error({ err: error, broadcastId }, 'Сообщение рассылки не ушло');
    }
  }

  const counts = await countsOf(deps.db, broadcastId);

  /**
   * **Взятая строка держит рассылку открытой** (ревизия четвёртого этапа).
   *
   * Прежде решение принималось по одному `pending`, а строка, взятая и
   * не дошедшая до отметки (воркер умер между взятием и отправкой —
   * выкладка посреди рассылки штатна), лежит в `sending` и в `pending`
   * не считается. Рассылка объявлялась «разослана», человек письма не
   * получал, и узнать об этом было неоткуда: перезахват возможен лишь
   * через пять минут, а заход к тому времени уже закрыт.
   *
   * Теперь такая строка удерживает заход: `more: true`, и следующий
   * заход её перезахватит, когда истечёт срок взятия.
   */
  const left = counts.pending + counts.sending;

  if (left === 0) {
    await finishBroadcast(deps.db, broadcastId, 'done');
  }

  return {
    sent,
    skipped,
    failed,
    left,
    more: left > 0,
    /**
     * Сколько ждать до следующего захода.
     *
     * Пусто — «можно сразу»: есть неотправленные. Иначе остались только
     * взятые строки, и брать их снова раньше срока бессмысленно —
     * `nextPending` их не отдаст.
     */
    ...(counts.pending === 0 && counts.sending > 0 ? { afterMs: LEASE_MS } : {}),
    stopped: false,
  };
}
