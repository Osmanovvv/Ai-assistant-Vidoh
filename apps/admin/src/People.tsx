import { useEffect, useState } from 'react';

import {
  overview,
  peoplePage,
  personCard,
  type Funnel,
  type Money,
  type Overview,
  type PeoplePage,
  type PersonCard,
  type PersonRow,
  type Revenue,
} from './api.js';

/**
 * Обзор, список людей и карточка (§15 ТЗ, задача 4.6).
 *
 * **Карточка собрана вокруг вопроса, а не вокруг таблиц базы.** Условие
 * готовности задачи — «по жалобе „бот неправильно понял“ можно за минуту
 * найти выгрузку, версию промпта и результат», поэтому порядок такой:
 * что человек сказал → что из этого вышло → каким промптом → что потом
 * поправили. Ровно тем путём, которым 31.08.2026 пришлось идти через ssh
 * и SQL.
 *
 * **Обзор честно говорит, чего в нём нет.** Пустая колонка читается как
 * «ноль», то есть как факт, — поэтому вместо неё объяснение. Выручка и
 * переход в оплату появились с задачей 4.2; переход не считается, пока
 * неизвестен размер пробного периода, и об этом сказано словами.
 *
 * **Выручка не сведена в одно число нарочно.** Рубли и звёзды — разные
 * деньги: курс звезды задаёт Telegram, он меняется, и «итого» пришлось
 * бы придумать. Плюс из звёзд Telegram берёт свою долю.
 */

const PAGE = 20;

function money(list: readonly Money[]): string {
  if (list.length === 0) return '—';

  return list
    .map((one) => {
      const amount = (one.micros / 1_000_000).toFixed(2);
      return one.currency === 'usd' ? `$${amount}` : `${amount} ₽`;
    })
    .join(' + ');
}

/** Выручка суммами: «399.00 ₽» или «399.00 ₽ + 150 ⭐». */
function earned(list: readonly Revenue[]): string {
  if (list.length === 0) return '—';

  return list
    .map((one) =>
      one.currency === 'XTR' ? `${String(one.minor)} ⭐` : `${(one.minor / 100).toFixed(2)} ₽`,
    )
    .join(' + ');
}

/**
 * Сколько было платежей — отдельной строкой под суммой.
 *
 * Не украшение: одна оплата на три тысячи и тридцать по сотне — разные
 * новости, а сумма у них похожая. Но и не часть большого числа: «399.00 ₽
 * (1)» без подписи читается как непонятная приписка.
 */
function payments(list: readonly Revenue[]): string {
  const total = list.reduce((sum, one) => sum + one.payments, 0);

  if (total === 0) return 'платежей не было';

  const tail = total % 100;
  const last = total % 10;

  const word =
    tail >= 11 && tail <= 14
      ? 'платежей'
      : last === 1
        ? 'платёж'
        : last < 5
          ? 'платежа'
          : 'платежей';

  return `${String(total)} ${word}`;
}

/**
 * Переход из пробного в оплату — двумя числами, а не процентом.
 *
 * Процент от трёх человек выглядит как знание, знанием не являясь.
 * Поэтому «2 из 7», а доля пусть считается в голове того, кто смотрит.
 */
function conversionText(value: Funnel): string {
  return `${String(value.total.paidAfterTrial)} из ${String(value.total.trialOver)}`;
}

/** Подписка человека в одну строку — для списка. */
function subscriptionText(row: PersonRow): string {
  const subscription = row.subscription;

  if (subscription === undefined) return '—';

  const plan = subscription.plan === 'monthly' ? 'месяц' : 'год';
  const rail = subscription.rail === 'telegram:stars' ? 'звёзды' : 'карта';

  /**
   * «Кончилась» отличается от «не платил», и это разные строки.
   * Разбирающий жалобу обязан их различать: у первого доступ был.
   */
  if (!subscription.live) return `кончилась ${when(subscription.paidUntil)}`;

  const renew = subscription.autoRenew ? 'продлевается' : 'без продления';
  const trouble = subscription.status === 'past_due' ? ', продление не прошло' : '';

  return `${plan}, ${rail}, до ${when(subscription.paidUntil)} — ${renew}${trouble}`;
}

/** Дата в местном виде. Пусто — прочерк, а не «Invalid Date». */
function when(value: string | null): string {
  if (value === null) return '—';

  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString('ru-RU');
}

// ── Обзор ─────────────────────────────────────────────────────────────

export function OverviewPanel(): React.ReactElement {
  const [report, setReport] = useState<Overview | undefined>(undefined);
  const [problem, setProblem] = useState(false);

  useEffect(() => {
    void overview(30)
      .then(setReport)
      .catch(() => {
        setProblem(true);
      });
  }, []);

  if (problem) {
    return (
      <p className="отказ" role="alert">
        Не удалось собрать обзор
      </p>
    );
  }

  if (report === undefined) return <p className="разрез__пусто">Считаю…</p>;

  return (
    <div data-testid="overview">
      <section className="итоги">
        <div className="итог">
          <span className="итог__имя">Всего людей</span>
          <span className="итог__число">{report.totalUsers}</span>
        </div>
        <div className="итог">
          <span className="итог__имя">Новых за 30 дней</span>
          <span className="итог__число">{report.newUsers}</span>
        </div>
        <div className="итог">
          <span className="итог__имя">Активных за 30 дней</span>
          <span className="итог__число">{report.activeUsers}</span>
        </div>
        <div className="итог">
          <span className="итог__имя">Выгрузок разобрано</span>
          <span className="итог__число">{report.dumps}</span>
        </div>
        <div className="итог">
          <span className="итог__имя">Расход на модели</span>
          <span className="итог__число">{money(report.spend)}</span>
        </div>
        <div className="итог">
          <span className="итог__имя">Выручка за 30 дней</span>
          <span className="итог__число" data-testid="revenue">
            {earned(report.revenue)}
          </span>
          {/* Блоком, а не строкой: иначе «498.00 ₽2 платежа» слипается. */}
          <span
            className="панель__кто"
            data-testid="payments"
            style={{ display: 'block', marginTop: 2 }}
          >
            {payments(report.revenue)}
          </span>
        </div>
        <div className="итог">
          <span className="итог__имя">Платят сейчас</span>
          <span className="итог__число" data-testid="payers">
            {report.payers}
          </span>
        </div>
        <div className="итог">
          <span className="итог__имя">Из пробного в оплату</span>
          <span className="итог__число" data-testid="conversion">
            {conversionText(report.funnel)}
          </span>
        </div>
      </section>

      <FunnelBlock value={report.funnel} />

      {report.missing.map((note) => (
        <p className="оговорка" key={note}>
          {note}
        </p>
      ))}
    </div>
  );
}

/**
 * Воронка и разрез по источникам (§15 и §14, задача 4.4).
 *
 * **Ни одного процента.** Четыре числа в ряд и знаменатель рядом:
 * процент от трёх человек выглядит как знание, знанием не являясь. На
 * боевом людей двое.
 *
 * **Источник без названия называется словом.** Пустая ячейка читается
 * как «нет данных», а человек-то есть: он пришёл по прямой ссылке.
 */
function FunnelBlock({ value }: { readonly value: Funnel }): React.ReactElement {
  const rows = [{ ...value.total, source: 'ВСЕ' }, ...value.bySource];

  return (
    <div className="разрез" data-testid="funnel">
      <h3 className="разрез__имя">Воронка по источникам</h3>

      <div className="таблица-обёртка">
        <table className="таблица">
          <thead>
            <tr>
              <th>Источник</th>
              <th className="таблица__число">Регистрация</th>
              <th className="таблица__число">Первая выгрузка</th>
              <th className="таблица__число">Конец пробного</th>
              <th className="таблица__число">Оплата</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.source ?? `прямой-${String(index)}`}>
                <td>
                  {index === 0 ? 'Все вместе' : (row.source ?? 'без источника (прямой заход)')}
                </td>
                <td className="таблица__число">{row.registered}</td>
                <td className="таблица__число">{row.firstDump}</td>
                <td className="таблица__число">{row.trialOver}</td>
                <td className="таблица__число">{row.paidAfterTrial}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {value.momentsSince !== null && (
        <p className="панель__кто" data-testid="moments-since">
          Моменты конца пробного периода ведутся с {when(value.momentsSince)}
          {value.trialLimits.length > 0
            ? `; встреченные пределы: ${value.trialLimits.join(', ')}`
            : ''}
          .
        </p>
      )}

      {value.missing.map((note) => (
        <p className="оговорка" key={note}>
          {note}
        </p>
      ))}
    </div>
  );
}

// ── Список и карточка ─────────────────────────────────────────────────

export function PeoplePanel(): React.ReactElement {
  const [page, setPage] = useState<PeoplePage | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState(false);

  useEffect(() => {
    setProblem(false);

    void peoplePage({ limit: PAGE, offset, ...(query === '' ? {} : { query }) })
      .then(setPage)
      .catch(() => {
        setProblem(true);
      });
  }, [offset, query]);

  if (openId !== undefined) {
    return (
      <Card
        userId={openId}
        onBack={() => {
          setOpenId(undefined);
        }}
      />
    );
  }

  if (problem) {
    return (
      <p className="отказ" role="alert">
        Не удалось собрать список
      </p>
    );
  }

  return (
    <div data-testid="people">
      <div className="период">
        <input
          className="поле__ввод"
          style={{ maxWidth: 240 }}
          name="q"
          placeholder="Имя или @имя"
          value={query}
          onChange={(event) => {
            setOffset(0);
            setQuery(event.target.value);
          }}
        />
        {page !== undefined && (
          <span className="панель__кто">
            {offset + 1}–{Math.min(offset + PAGE, page.total)} из {page.total}
          </span>
        )}
      </div>

      {page === undefined ? (
        <p className="разрез__пусто">Считаю…</p>
      ) : page.rows.length === 0 ? (
        <p className="разрез__пусто">Никого не нашлось.</p>
      ) : (
        <div className="таблица-обёртка">
          <table className="таблица">
            <thead>
              <tr>
                <th>Кто</th>
                <th>Источник</th>
                <th>Зарегистрирован</th>
                <th>Был</th>
                <th className="таблица__число">Выгрузок</th>
                <th className="таблица__число">Пробных</th>
                <th>Подписка</th>
                <th className="таблица__число">Расход</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <button
                      type="button"
                      className="кнопка кнопка--тихая"
                      style={{ width: 'auto', padding: 0, textAlign: 'left' }}
                      onClick={() => {
                        setOpenId(row.id);
                      }}
                    >
                      {row.title}
                    </button>
                    {row.blocked && <span className="панель__кто"> заблокировал бота</span>}
                  </td>
                  <td>{row.source ?? '—'}</td>
                  <td>{when(row.registeredAt)}</td>
                  <td>{when(row.lastActiveAt)}</td>
                  <td className="таблица__число">{row.dumps}</td>
                  <td className="таблица__число">{row.trialSpent}</td>
                  <td data-testid={`subscription-${row.id}`}>{subscriptionText(row)}</td>
                  <td className="таблица__число">{money(row.spend)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {page !== undefined && page.total > PAGE && (
        <div className="период" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="период__кнопка"
            disabled={offset === 0}
            onClick={() => {
              setOffset(Math.max(0, offset - PAGE));
            }}
          >
            Назад
          </button>
          <button
            type="button"
            className="период__кнопка"
            disabled={offset + PAGE >= page.total}
            onClick={() => {
              setOffset(offset + PAGE);
            }}
          >
            Дальше
          </button>
        </div>
      )}
    </div>
  );
}

function Card({
  userId,
  onBack,
}: {
  readonly userId: string;
  readonly onBack: () => void;
}): React.ReactElement {
  const [card, setCard] = useState<PersonCard | undefined>(undefined);
  const [problem, setProblem] = useState(false);

  useEffect(() => {
    void personCard(userId)
      .then(setCard)
      .catch(() => {
        setProblem(true);
      });
  }, [userId]);

  if (problem) {
    return (
      <div>
        <button type="button" className="период__кнопка" onClick={onBack}>
          Назад к списку
        </button>
        <p className="отказ" role="alert">
          Не удалось собрать карточку
        </p>
      </div>
    );
  }

  if (card === undefined) return <p className="разрез__пусто">Собираю…</p>;

  return (
    <div data-testid="card">
      <div className="период">
        <button type="button" className="период__кнопка" onClick={onBack}>
          Назад к списку
        </button>
        <span className="панель__кто">
          {card.person.title}
          {card.person.username === null ? '' : ` · @${card.person.username}`} · выгрузок{' '}
          {card.person.dumps} · расход {money(card.person.spend)} · подписка{' '}
          {subscriptionText(card.person)}
        </span>
      </div>

      <section className="разрез">
        <h2 className="разрез__имя">Выгрузки</h2>

        {card.dumps.length === 0 ? (
          <p className="разрез__пусто">Выгрузок пока не было.</p>
        ) : (
          card.dumps.map((dump) => (
            <article className="выгрузка" key={dump.id}>
              <header className="выгрузка__шапка">
                <span>{when(dump.openedAt)}</span>
                <span className="панель__кто">
                  {dump.status}
                  {dump.trialCounted ? ' · пробная' : ''}
                  {dump.prompts.length === 0
                    ? ''
                    : ` · ${dump.prompts
                        .map((one) => `${one.stage}: ${one.version ?? 'без версии'}`)
                        .join(', ')}`}
                </span>
              </header>

              {/* Что человек сказал — первым, до всякого разбора. */}
              <p className="выгрузка__слова">{dump.said ?? '(текста нет)'}</p>

              {dump.error !== null && <p className="оговорка">Сбой разбора: {dump.error}</p>}

              {dump.results.length === 0 ? (
                <p className="разрез__пусто">Записей из неё не вышло.</p>
              ) : (
                <ul className="выгрузка__итог">
                  {dump.results.map((item) => (
                    <li key={item.id}>
                      {item.text}
                      <span className="панель__кто">
                        {item.isDraft
                          ? ` — черновик: ${item.draftReason ?? 'без причины'}`
                          : ` — ${item.type}${item.topic === null ? '' : `, ${item.topic}`}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))
        )}
      </section>

      <section className="разрез">
        <h2 className="разрез__имя">Применённые изменения</h2>

        {card.changes.length === 0 ? (
          <p className="разрез__пусто">Изменений не было.</p>
        ) : (
          <div className="таблица-обёртка">
            <table className="таблица">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Запись</th>
                  <th>Кто</th>
                  <th>Почему</th>
                </tr>
              </thead>
              <tbody>
                {card.changes.map((change) => (
                  <tr key={change.id}>
                    <td>{when(change.at)}</td>
                    <td>{change.itemText ?? '(запись удалена)'}</td>
                    <td>{change.changedBy}</td>
                    <td>
                      {change.reason ?? '—'}
                      {change.reverted ? ' (откачено)' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="разрез">
        <h2 className="разрез__имя">Заданные вопросы</h2>

        {card.questions.length === 0 ? (
          <p className="разрез__пусто">Вопросов не задавалось.</p>
        ) : (
          <div className="таблица-обёртка">
            <table className="таблица">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>О чём спросили</th>
                  <th>Чем кончилось</th>
                </tr>
              </thead>
              <tbody>
                {card.questions.map((question) => (
                  <tr key={question.id}>
                    <td>{when(question.at)}</td>
                    <td>{question.segment}</td>
                    <td>{question.outcome ?? 'открыт'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
