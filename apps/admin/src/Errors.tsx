import { useCallback, useEffect, useState } from 'react';

import { access, errors, restartBatch, type AccessView, type ErrorsPage } from './api.js';

/**
 * Журнал сбоев (§15 ТЗ, задача 4.10).
 *
 * §15: «журнал неуспешных вызовов и сбоев с возможностью повторного
 * запуска».
 *
 * **Первым делом — сорвавшиеся разборы, а не вызовы модели.** Вызов
 * модели видит только разработчик; сорвавшийся разбор видит человек: он
 * сказал мысль и не получил ответа. §17 обещает ему «честное короткое
 * сообщение о задержке», а текст этого сообщения ссылается на админку,
 * из которой разбор перезапускают. Кнопка «Перезапустить» — исполнение
 * того обещания.
 *
 * **Текстов расшифровок здесь нет нарочно.** Видно, у кого сорвался
 * разбор и на чём; сказанное человеком — в его карточке, где доступ к
 * нему пишется в журнал §16. Журнал ошибок читают часто и мимоходом, и
 * чужим мыслям в нём делать нечего.
 */

const DAYS = [1, 7, 30] as const;

/**
 * Сумма в наименьших единицах — человеку.
 *
 * Рубли в копейках, звёзды штуками: делить звёзды на сто значило бы
 * показать «1.50 ⭐» там, где их полторы сотни.
 */
function minor(value: number, currency: string): string {
  return currency === 'XTR' ? `${String(value)} ⭐` : `${(value / 100).toFixed(2)} ₽`;
}

function when(iso: string | null): string {
  if (iso === null) return '';

  return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

export function ErrorsPanel(): React.ReactElement {
  const [days, setDays] = useState<number>(7);
  const [page, setPage] = useState<ErrorsPage | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [said, setSaid] = useState<string | undefined>(undefined);
  const [seen, setSeen] = useState<AccessView | undefined>(undefined);

  const load = useCallback(() => {
    void errors(days)
      .then(setPage)
      .catch(() => {
        setProblem('Не удалось прочитать журнал');
      });

    /**
     * Журнал доступа читается **отдельным** запросом и своим состоянием.
     *
     * Его отказ не должен прятать сорвавшиеся разборы: они срочные, а
     * журнал доступа — для разбора инцидента. Поэтому неудача здесь
     * говорит словами в своём разрезе, а не отказом на всю страницу.
     */
    void access(days)
      .then(setSeen)
      .catch(() => {
        setSeen(undefined);
      });
  }, [days]);

  useEffect(load, [load]);

  if (problem !== undefined) {
    return (
      <p className="отказ" role="alert">
        {problem}
      </p>
    );
  }

  if (page === undefined) return <p className="разрез__пусто">Читаю…</p>;

  const restart = (id: string): void => {
    setSaid(undefined);

    void restartBatch(id)
      .then(() => {
        setSaid('Разбор поставлен в очередь заново.');
        load();
      })
      .catch(() => {
        setProblem('Не удалось перезапустить');
      });
  };

  return (
    <div data-testid="errors">
      <div className="период">
        {DAYS.map((one) => (
          <button
            key={one}
            type="button"
            className={one === days ? 'период__кнопка период__кнопка--выбран' : 'период__кнопка'}
            onClick={() => {
              setDays(one);
            }}
          >
            {one === 1 ? 'сутки' : `${String(one)} дней`}
          </button>
        ))}
      </div>

      {said !== undefined && (
        <p className="оговорка" data-testid="restart-done" role="status">
          {said}
        </p>
      )}

      <div className="разрез">
        <h3 className="разрез__имя">
          Сорвавшиеся разборы {page.batchesTotal > 0 && `— всего ${String(page.batchesTotal)}`}
        </h3>

        {page.batches.length === 0 ? (
          <p className="разрез__пусто" data-testid="no-failed-batches">
            Сорвавшихся разборов за этот срок нет.
          </p>
        ) : (
          <div className="таблица-обёртка">
            <table className="таблица">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>У кого</th>
                  <th className="таблица__число">Попыток</th>
                  <th className="таблица__число">Знаков</th>
                  <th>На чём сорвался</th>
                  <th>Что сделать</th>
                </tr>
              </thead>
              <tbody>
                {page.batches.map((row) => (
                  <tr key={row.id} data-testid={`failed-batch-${row.id}`}>
                    <td>{when(row.openedAt)}</td>
                    <td>{row.who}</td>
                    <td className="таблица__число">{row.attempts}</td>
                    <td className="таблица__число">{row.length}</td>
                    <td className="панель__кто">{row.error ?? ''}</td>
                    <td>
                      <button
                        type="button"
                        className="период__кнопка"
                        data-testid={`restart-${row.id}`}
                        onClick={() => {
                          restart(row.id);
                        }}
                      >
                        Перезапустить
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="разрез">
        <h3 className="разрез__имя">
          Неуспешные вызовы модели {page.callsTotal > 0 && `— всего ${String(page.callsTotal)}`}
        </h3>

        {page.calls.length === 0 ? (
          <p className="разрез__пусто">Неуспешных вызовов за этот срок нет.</p>
        ) : (
          <div className="таблица-обёртка">
            <table className="таблица">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Этап</th>
                  <th>Модель</th>
                  <th>Версия промпта</th>
                  <th className="таблица__число">Мс</th>
                  <th>Заплатили</th>
                  <th>Что случилось</th>
                </tr>
              </thead>
              <tbody>
                {page.calls.map((row) => (
                  <tr key={row.id}>
                    <td>{when(row.at)}</td>
                    <td>{row.stage}</td>
                    <td>{row.model}</td>
                    <td>{row.promptVersion ?? ''}</td>
                    <td className="таблица__число">{row.latencyMs}</td>
                    <td>{row.paid ? 'да' : 'нет'}</td>
                    <td className="панель__кто">{row.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {page.payments.length > 0 && (
        <div className="разрез">
          <h3 className="разрез__имя" data-testid="failed-payments">
            Неудачные платежи — {page.paymentsTotal} за период
          </h3>

          <p className="оговорка">
            Самое дорогое в этом журнале: человек мог заплатить и не получить доступ. Разбирается
            руками — повторить списание нельзя, это значило бы взять деньги второй раз.
          </p>

          <div className="таблица-обёртка">
            <table className="таблица">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Кто</th>
                  <th>Рельс</th>
                  <th>Тариф</th>
                  <th className="таблица__число">Ждали</th>
                  <th className="таблица__число">Пришло</th>
                  <th>Что случилось</th>
                </tr>
              </thead>
              <tbody>
                {page.payments.map((row) => (
                  <tr key={row.id}>
                    <td>{when(row.at)}</td>
                    <td>{row.who}</td>
                    <td>{row.rail === 'telegram:stars' ? 'звёзды' : 'карта'}</td>
                    <td>
                      {row.plan === 'monthly' ? 'месяц' : 'год'}
                      {row.kind === 'renewal' ? ', продление' : ''}
                    </td>
                    <td className="таблица__число">{minor(row.expectedMinor, row.currency)}</td>
                    <td className="таблица__число">{row.received ?? '—'}</td>
                    <td className="панель__кто">
                      {row.errorCode === null ? '' : `${String(row.errorCode)}: `}
                      {row.errorText ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {page.sends.length > 0 && (
        <div className="разрез">
          {/*
            Итог за период — как у соседних разрезов (ревизия этапа 4).

            Прежде список был обрезан пятьюдесятью без числа и не
            подчинялся выбранному периоду: пятьдесят строк читались как
            полный список, а строка месячной давности была видна при
            выборе «сутки».
          */}
          <h3 className="разрез__имя">
            Не дошедшие письма рассылки — {String(page.sendsTotal)} за период
          </h3>

          <div className="таблица-обёртка">
            <table className="таблица">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Кому</th>
                  <th>Что случилось</th>
                </tr>
              </thead>
              <tbody>
                {page.sends.map((row) => (
                  <tr key={row.id}>
                    <td>{when(row.at)}</td>
                    <td>{row.tgId}</td>
                    <td className="панель__кто">{row.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="оговорка">
            Повторить их можно в разделе рассылки — кнопкой «Повторить неудачные» у нужной рассылки.
          </p>
        </div>
      )}

      {/*
        Сорвавшиеся напоминания — пятый источник (§18, ревизия этапа 4).

        Прежде их не было в журнале вовсе, и о их отсутствии не было
        сказано словами: человек не получал утреннего письма, а панель
        молчала. Повтора у них нет нарочно — время прошло, и вечернее
        письмо на следующий день не то напоминание, о котором просили;
        об этом сказано в списке оговорок ниже.
      */}
      {page.reminders.length > 0 && (
        <div className="разрез">
          <h3 className="разрез__имя">
            Сорвавшиеся напоминания — {String(page.remindersTotal)} за период
          </h3>

          <div className="таблица-обёртка">
            <table className="таблица" data-testid="failed-reminders">
              <thead>
                <tr>
                  <th>Когда должно было прийти</th>
                  <th>Кому</th>
                  <th>Какое</th>
                </tr>
              </thead>
              <tbody>
                {page.reminders.map((row) => (
                  <tr key={row.id}>
                    <td>{when(row.at)}</td>
                    <td className="панель__кто">{row.firstName ?? row.tgId ?? '—'}</td>
                    <td>{row.kind}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {page.missing.map((note) => (
        <p className="оговорка" key={note}>
          {note}
        </p>
      ))}

      {/*
        Журнал доступа к персональным данным (§16, обещание задачи 4.10).

        Ревизия этапа нашла обещание неисполненным: «сам журнал как раздел
        панели — это 4.10, где живут журналы». Задачу закрыли, раздел не
        появился, читателей у таблицы не было ни одного. Журнал, который
        никто не читает, исполняет §16 на бумаге: он отвечает на вопрос
        «кто смотрел данные этого человека» только тому, у кого есть SQL к
        боевой базе.

        Имён здесь нет нарочно: раздел про обращения, а не про людей.
        Покажи мы имена — журнал доступа сам стал бы вторым списком людей.
      */}
      <div className="разрез">
        <h3 className="разрез__имя">
          Кто смотрел персональные данные{' '}
          {seen !== undefined && seen.total > 0 && `— всего ${String(seen.total)}`}
        </h3>

        {seen === undefined ? (
          <p className="разрез__пусто">Журнал доступа прочитать не удалось.</p>
        ) : seen.rows.length === 0 ? (
          <p className="разрез__пусто" data-testid="no-access">
            За этот срок к персональным данным не обращались.
          </p>
        ) : (
          <div className="таблица-обёртка">
            <table className="таблица" data-testid="access">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Кто смотрел</th>
                  <th>Куда</th>
                  <th>На кого</th>
                  <th className="таблица__число">Людей в ответе</th>
                </tr>
              </thead>
              <tbody>
                {seen.rows.map((row) => (
                  <tr key={`${row.at}${row.route}${row.login}`}>
                    <td>{when(row.at)}</td>
                    <td>{row.login}</td>
                    <td className="панель__кто">{row.route}</td>
                    <td className="панель__кто">{row.subjectUserId ?? '—'}</td>
                    {/*
                      «Не установлено» словом, а не прочерком и не единицей.
                      Прежде в столбце стояла единица от умолчания базы:
                      журнал утверждал «в ответ попал один человек» про
                      страницу из двадцати. Пустая клетка читается как факт.
                    */}
                    <td className="таблица__число">{row.subjects ?? 'не установлено'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {seen !== undefined && seen.rows.length < seen.total && (
          <p className="оговорка">
            Показаны последние {String(seen.rows.length)} из {String(seen.total)}.
          </p>
        )}
      </div>
    </div>
  );
}
