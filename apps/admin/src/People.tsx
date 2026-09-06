import { useEffect, useState } from 'react';

import {
  overview,
  peoplePage,
  personCard,
  type Money,
  type Overview,
  type PeoplePage,
  type PersonCard,
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
 * **Обзор честно говорит, чего в нём нет.** §15 просит переход в оплату
 * и выручку; их не существует до задачи 4.2. Пустая колонка читается как
 * «ноль», то есть как факт, — поэтому вместо неё объяснение.
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
      </section>

      {report.missing.map((note) => (
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
        <table className="таблица">
          <thead>
            <tr>
              <th>Кто</th>
              <th>Источник</th>
              <th>Зарегистрирован</th>
              <th>Был</th>
              <th className="таблица__число">Выгрузок</th>
              <th className="таблица__число">Пробных</th>
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
                <td className="таблица__число">{money(row.spend)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
          {card.person.dumps} · расход {money(card.person.spend)}
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
        )}
      </section>

      <section className="разрез">
        <h2 className="разрез__имя">Заданные вопросы</h2>

        {card.questions.length === 0 ? (
          <p className="разрез__пусто">Вопросов не задавалось.</p>
        ) : (
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
        )}
      </section>
    </div>
  );
}
