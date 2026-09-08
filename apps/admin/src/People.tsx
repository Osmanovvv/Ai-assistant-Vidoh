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
 * переход в оплату появились с задачей 4.2. Настоящая причина оговорок
 * названа ревизией четвёртого этапа: моменты конца пробного периода
 * ведутся **с выкладки 4.4** и задним числом не досыпаются, поэтому
 * третий шаг воронки говорит только о людях, у которых пробный кончился
 * после неё. Прежде здесь стояло «переход не считается, пока неизвестен
 * размер пробного периода» — обещание, которого код не исполнял: размер
 * известен всегда, у него есть умолчание.
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

/**
 * Только дата, без времени.
 *
 * Для «моменты ведутся с …» секунды не значат ничего: человек читает
 * это как «с седьмого сентября». А снимок экрана с секундами засева
 * краснел бы на каждом прогоне — то есть страж превратился бы в шум,
 * который перестают читать.
 */
function day(value: string | null): string {
  if (value === null) return '—';

  const at = new Date(value);

  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleDateString('ru-RU');
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
          <span className="итог__имя">Всего людей за всё время</span>
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
          <span className="итог__имя">Выгрузок разобрано за 30 дней</span>
          <span className="итог__число">{report.dumps}</span>
        </div>
        <div className="итог">
          <span className="итог__имя">Расход на модели за 30 дней</span>
          <span className="итог__число">{money(report.spend)}</span>
          {/*
            Оговорка про вызовы без цены — правка ревизии этапа.

            Модели нет в прайс-листе, цена не записана, и вызов молча
            выпадал из суммы: расход показывался как факт, хотя был
            нижней границей. Раздел расходов такую оговорку печатает,
            обзор молчал — и два числа про одно и то же расходились.
          */}
          {report.unpricedCalls > 0 && (
            <span
              className="панель__кто"
              data-testid="unpriced"
              style={{ display: 'block', marginTop: 2 }}
            >
              не меньше: у {report.unpricedCalls} вызовов цена неизвестна
            </span>
          )}
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
        {report.refunded.length > 0 && (
          <div className="итог">
            <span className="итог__имя">Возвращено за 30 дней</span>
            <span className="итог__число" data-testid="refunded">
              {earned(report.refunded)}
            </span>
            {/* Отдельной величиной, а не вычетом: «заработали и вернули»
                и «не заработали» — разные новости с одной суммой. */}
            <span className="панель__кто" style={{ display: 'block', marginTop: 2 }}>
              {payments(report.refunded)}
            </span>
          </div>
        )}
        <div className="итог">
          <span className="итог__имя">Платят сейчас (на эту минуту)</span>
          <span className="итог__число" data-testid="payers">
            {report.payers}
          </span>
        </div>
        <div className="итог">
          <span className="итог__имя">Из пробного в оплату за всё время</span>
          <span className="итог__число" data-testid="conversion">
            {conversionText(report.funnel)}
          </span>
        </div>
      </section>

      {/*
        Оговорки печатает **только** воронка — правка ревизии этапа.

        Прежде тот же список печатался и здесь: `overview` пробрасывает
        `funnel.missing` наверх, а `FunnelBlock` печатает его сам. Человек
        читал каждую оговорку дважды и решал, что это про разные числа.
      */}
      <FunnelBlock value={report.funnel} />
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
              {/*
                Две разные колонки вместо одной — правка ревизии этапа.

                «Ещё выбирает» прежде считалось как «момента нет, трата
                есть, не платил» — и в него попадали люди, которым бот
                уже отказывает: момент пишется с выкладки 4.4, а снижение
                предела из панели мгновенно переводит человека за
                границу. Заказчица читала «двадцать думают» там, где
                двадцать упёрлись в отказ.
              */}
              <th className="таблица__число">Ещё выбирает</th>
              <th className="таблица__число">Отказ без момента</th>
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
                <td className="таблица__число">{row.trialStillRunning}</td>
                <td className="таблица__число" data-testid={`funnel-unrecorded-${String(index)}`}>
                  {row.trialOverUnrecorded}
                </td>
                <td className="таблица__число">{row.paidAfterTrial}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {value.momentsSince !== null && (
        <p className="панель__кто" data-testid="moments-since">
          Моменты конца пробного периода ведутся с {day(value.momentsSince)}
          {value.trialLimits.length > 0
            ? `; встреченные пределы: ${value.trialLimits.join(', ')}`
            : ''}
          .
        </p>
      )}

      {rows[0] !== undefined && rows[0].trialOverUnrecorded > 0 && (
        <p className="оговорка">
          «Отказ без момента» — люди, у которых пробные выгрузки кончились, а когда именно, сказать
          нечем: моменты ведутся с выкладки и задним числом не досыпаются, а снижение предела
          переводит человека за границу сразу. Бот им уже отказывает.
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
                {/*
                  Период назван у каждой колонки — правка ревизии этапа.

                  Рядом стояли числа за 30 дней и за всё время без
                  подписи, и разбирающий складывал одно с другим.
                */}
                <th className="таблица__число">Выгрузок за всё время</th>
                <th className="таблица__число">Пробных за всё время</th>
                <th>Подписка</th>
                <th className="таблица__число">Расход за всё время</th>
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

      {/*
        Сказанное вне выгрузок — правка ревизии четвёртого этапа.

        Сообщение, пришедшее после отказа гейта, сохраняется и не
        попадает ни в выгрузку, ни в записи. Прежде его не видел никто:
        человек, которому реплика обещала «всё сказанное на месте», шёл
        проверять и не находил своих слов, а разбирающий жалобу не мог
        даже подтвердить, что слова дошли.
      */}
      {card.orphans.length > 0 && (
        <section className="разрез" data-testid="orphans">
          <h2 className="разрез__имя">
            Сказано вне выгрузок
            {card.orphansTotal > card.orphans.length
              ? ` — показаны последние ${String(card.orphans.length)} из ${String(card.orphansTotal)}`
              : ''}
          </h2>

          <p className="оговорка">
            Эти сообщения сохранены, но разбора у них нет: так бывает после отказа гейта — пробные
            разборы кончились, а слова человек всё равно сказал.
          </p>

          <div className="таблица-обёртка">
            <table className="таблица">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Что сказано</th>
                </tr>
              </thead>
              <tbody>
                {card.orphans.map((one) => (
                  <tr key={one.id}>
                    <td>{when(one.at)}</td>
                    <td className="панель__кто">
                      {one.text ?? (one.kind === 'voice' ? '(голосовое, не расшифровано)' : '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="разрез">
        {/*
          Сколько выгрузок всего — правка ревизии четвёртого этапа.

          Список обрезан двадцатью, и прежде об этом не было сказано
          ничего: разбирающий жалобу читал его как полный — «сказала три
          раза за месяц» вместо «двадцать первый раз не показан».
        */}
        <h2 className="разрез__имя">
          Выгрузки
          {card.dumpsTotal > card.dumps.length
            ? ` — показаны последние ${String(card.dumps.length)} из ${String(card.dumpsTotal)}`
            : ''}
        </h2>

        {card.dumpsTotal > card.dumps.length && (
          <p className="оговорка">
            Более старые выгрузки из панели пока не открыть. Если нужны — они в базе, по коду
            человека.
          </p>
        )}

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
              {/*
                «Текста нет» больше не утверждается как факт (ревизия
                этапа). Склейка пишется в начале разбора: у выгрузки,
                сорвавшейся до него, поле пусто — а сообщения человека на
                месте, они сохраняются до всякого разбора. Теперь сервер
                поднимает их сам, и пустота осталась только там, где
                сообщений действительно нет.
              */}
              <p className="выгрузка__слова">
                {dump.said === null || dump.said === ''
                  ? '(сообщений в этой выгрузке нет)'
                  : dump.said}
              </p>

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
