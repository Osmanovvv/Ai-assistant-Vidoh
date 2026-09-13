import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import type { PaymentProvider } from '../billing/provider.js';
import { stopAllRenewals } from '../billing/subscription.service.js';
import type { Rail } from '../billing/tariffs.js';
import type { TopicGateway } from '../topics/gateway.js';
import { removeThread } from '../topics/topics.service.js';
import { deleteUserData, type DeletionReport } from './privacy.service.js';

export interface EraseDeps {
  readonly db: Database;
  readonly logger: Logger;
  /**
   * Шлюз веток нужен удалению: без него база чистится, а в чате остаются
   * ветки тем с закреплёнными сводками — то есть со списком дел человека,
   * которого только что стёрли.
   */
  readonly topics: TopicGateway;
  /** Провайдеры оплаты — чтобы отменить продление ДО удаления (§16, §14). */
  readonly providers?: Partial<Record<Rail, PaymentProvider>> | undefined;
}

export interface EraseOutcome {
  readonly report: DeletionReport;
  readonly renewals: { readonly stopped: readonly Rail[]; readonly failed: readonly Rail[] };
  readonly threads: { readonly deleted: number; readonly gone: number; readonly failed: number };
}

/**
 * Стирание человека целиком — один путь на два входа: /delete_my_data и
 * удаление после 24 месяцев тишины (решение заказчицы 12.09.2026, ответ
 * 15). Разъехавшись, они дали бы два разных «всё удалено»: одно с
 * ветками в чате, другое — с идущими списаниями.
 *
 * Порядок: продления → база → ветки.
 *
 * Продление отменяется **до** удаления и **до** транзакции: ключ отмены
 * уходит каскадом вместе с человеком, а держать замок на его строках,
 * пока отвечает Telegram, значило бы поставить право на удаление в
 * зависимость от чужой доступности.
 *
 * Ветки чистятся после базы, поштучно и в try/catch: главное — удалить
 * данные. Откажет Telegram (режим тем выключен, ветку снесли руками, у
 * бота нет прав) — человек всё равно остаётся удалённым: несработавшая
 * уборка чата — неопрятность, несработавшее удаление — нарушение §16.
 */
export async function eraseUser(
  deps: EraseDeps,
  params: {
    readonly userId: string;
    readonly tgId: number;
    /** Чат, где живут ветки. Личный чат — это и есть `tgId`. */
    readonly chatId: number | undefined;
    /** Для журнала: «по его запросу» или «после 24 месяцев тишины». */
    readonly why: string;
  },
): Promise<EraseOutcome> {
  const { db, logger } = deps;

  const renewals =
    deps.providers === undefined
      ? { stopped: [], failed: [] }
      : await stopAllRenewals(db, {
          userId: params.userId,
          tgId: params.tgId,
          providers: deps.providers,
          logger,
        });

  const report = await deleteUserData(db, params.userId);
  logger.info(
    {
      tgId: params.tgId,
      messages: report.messages,
      dumps: report.dumps,
      threads: report.threadIds.length,
      renewalsStopped: renewals.stopped.length,
      renewalsLeft: renewals.failed.length,
    },
    `Данные пользователя удалены ${params.why}`,
  );

  /**
   * Итог уборки — в журнал на уровне `info`, отказы — `warn`.
   * Раньше отказ писался как `debug`, то есть в бою был невидим: когда
   * 03.09.2026 человек после удаления увидел ветки на месте, ответить,
   * удалял ли их бот, было нечем — пришлось звать Telegram напрямую.
   * (Удалял: ветки были уже сняты, а клиент показывал кэш.)
   */
  const threads = { deleted: 0, gone: 0, failed: 0 };

  if (params.chatId !== undefined) {
    for (const threadId of report.threadIds) {
      try {
        const outcome = await removeThread(
          { db, gateway: deps.topics, logger },
          { chatId: params.chatId, threadId },
        );
        if (outcome === 'deleted') threads.deleted++;
        else threads.gone++;
      } catch (error) {
        threads.failed++;
        logger.warn({ err: error, threadId }, 'Ветка не удалилась, данные это не меняет');
      }
    }

    logger.info({ tgId: params.tgId, ...threads }, 'Ветки после удаления данных');
  }

  return { report, renewals, threads };
}
