import { useCallback, useEffect, useState } from 'react';

import {
  broadcastPreview,
  broadcasts,
  createBroadcast,
  resumeBroadcast,
  retryBroadcast,
  startBroadcast,
  stopBroadcast,
  type BroadcastRow,
  type BroadcastsPage,
} from './api.js';

/**
 * Рассылка (§15 ТЗ, задача 4.10).
 *
 * §15: «рассылка всем или сегменту с предпросмотром и подтверждением».
 * Условие готовности задачи названо числом: тысяча адресатов не ловит
 * 429 и останавливается по кнопке.
 *
 * **Предпросмотр и подтверждение — не вежливость, а единственный
 * заслон.** Отправленное сообщение не отзывается: тысяча человек уже
 * прочла. Поэтому здесь два шага, и на втором показано ровно то, что
 * уйдёт, и ровно скольким. Одна кнопка «разослать» рядом с полем ввода
 * однажды отправила бы черновик.
 *
 * **Кнопка «Остановить» видна, пока рассылка идёт**, и просит
 * остановиться, а не объявляет об остановке: воркер может быть в
 * середине отправки. Панель покажет «останавливаю», а «остановлена» —
 * только когда он действительно встал. Врать про остановку хуже, чем
 * подождать секунду.
 */

const STATUS: Record<string, string> = {
  draft: 'черновик',
  running: 'идёт',
  stopped: 'остановлена',
  done: 'разослана',
  failed: 'сорвалась',
};

function when(iso: string | null): string {
  if (iso === null) return '';

  return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

export function BroadcastPanel(): React.ReactElement {
  const [page, setPage] = useState<BroadcastsPage | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const [text, setText] = useState('');
  const [segment, setSegment] = useState('all');
  const [preview, setPreview] = useState<
    { readonly recipients: number; readonly title: string } | undefined
  >(undefined);
  const [draft, setDraft] = useState<
    { readonly id: string; readonly recipients: number } | undefined
  >(undefined);

  const load = useCallback(() => {
    void broadcasts()
      .then(setPage)
      .catch(() => {
        setProblem('Не удалось прочитать рассылки');
      });
  }, []);

  useEffect(load, [load]);

  /**
   * Пока рассылка идёт, страница обновляется сама.
   *
   * Человек, нажавший «Остановить», должен увидеть, что она встала, а
   * не гадать. Пять секунд — редко для сервера и достаточно часто для
   * глаз.
   */
  const running = page?.rows.some((row) => row.status === 'running') ?? false;

  useEffect(() => {
    if (!running) return undefined;

    const timer = setInterval(load, 5_000);
    return () => {
      clearInterval(timer);
    };
  }, [running, load]);

  if (problem !== undefined) {
    return (
      <p className="отказ" role="alert">
        {problem}
      </p>
    );
  }

  if (page === undefined) return <p className="разрез__пусто">Читаю…</p>;

  const look = (): void => {
    setPreview(undefined);
    setDraft(undefined);

    void broadcastPreview(segment)
      .then((found) => {
        setPreview({ recipients: found.recipients, title: found.title });
      })
      .catch(() => {
        setProblem('Не удалось посчитать получателей');
      });
  };

  const make = (): void => {
    void createBroadcast({ text, segment })
      .then((made) => {
        setDraft({ id: made.id, recipients: made.recipients });
        load();
      })
      .catch(() => {
        setProblem('Не удалось составить рассылку');
      });
  };

  const send = (id: string): void => {
    void startBroadcast(id)
      .then(() => {
        setDraft(undefined);
        setText('');
        setPreview(undefined);
        load();
      })
      .catch(() => {
        setProblem('Не удалось запустить рассылку');
      });
  };

  const stop = (id: string): void => {
    void stopBroadcast(id)
      .then(load)
      .catch(() => {
        setProblem('Не удалось остановить');
      });
  };

  const resume = (id: string): void => {
    void resumeBroadcast(id)
      .then(load)
      .catch(() => {
        setProblem('Не удалось продолжить');
      });
  };

  const again = (id: string): void => {
    void retryBroadcast(id)
      .then(load)
      .catch(() => {
        setProblem('Не удалось повторить');
      });
  };

  return (
    <div data-testid="broadcast">
      <p className="оговорка">
        Отправленное не отзывается. Сначала предпросмотр — сколько человек получит письмо, — потом
        подтверждение. Заблокировавшие бота пропускаются, темп держится под лимитом Telegram.
      </p>

      <div className="разрез">
        <h3 className="разрез__имя">Новая рассылка</h3>

        <textarea
          className="поле__ввод"
          data-testid="broadcast-text"
          rows={6}
          placeholder="Что написать людям"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setDraft(undefined);
          }}
        />

        <div className="период">
          <select
            className="поле__ввод"
            data-testid="broadcast-segment"
            style={{ maxWidth: 320 }}
            value={segment}
            onChange={(event) => {
              setSegment(event.target.value);
              setPreview(undefined);
              setDraft(undefined);
            }}
          >
            {Object.entries(page.segments).map(([key, title]) => (
              <option key={key} value={key}>
                {title}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="период__кнопка"
            data-testid="broadcast-preview"
            onClick={look}
          >
            Посмотреть, скольким уйдёт
          </button>
        </div>

        {preview !== undefined && (
          <div className="оговорка" data-testid="preview-result" role="status">
            <p style={{ margin: '0 0 8px' }}>
              Получателей: <strong>{preview.recipients}</strong> ({preview.title}). Заблокировавшие
              бота сюда не входят.
            </p>

            {preview.recipients === 0 ? (
              <p style={{ margin: 0 }}>Отправлять некому.</p>
            ) : (
              <button
                type="button"
                className="период__кнопка"
                data-testid="broadcast-make"
                disabled={text.trim() === ''}
                onClick={make}
              >
                Составить рассылку
              </button>
            )}
          </div>
        )}

        {draft !== undefined && (
          <div className="отказ" data-testid="broadcast-confirm" role="alert">
            <p style={{ margin: '0 0 8px' }}>
              Готово к отправке: <strong>{draft.recipients}</strong> человек получат это сообщение.
              Отозвать его будет нельзя.
            </p>

            <pre className="хвост">{text}</pre>

            <button
              type="button"
              className="период__кнопка"
              data-testid="broadcast-send"
              onClick={() => {
                send(draft.id);
              }}
            >
              Отправить
            </button>
          </div>
        )}
      </div>

      <div className="разрез">
        <h3 className="разрез__имя">Прошлые рассылки</h3>

        {page.rows.length === 0 ? (
          <p className="разрез__пусто">Рассылок ещё не было.</p>
        ) : (
          <div className="таблица-обёртка">
            <table className="таблица">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Кому</th>
                  <th>Что</th>
                  <th>Состояние</th>
                  <th className="таблица__число">Ушло</th>
                  <th className="таблица__число">Пропущено</th>
                  <th className="таблица__число">Не дошло</th>
                  <th className="таблица__число">Осталось</th>
                  <th>Что сделать</th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row) => (
                  <Row
                    key={row.id}
                    row={row}
                    segments={page.segments}
                    onStop={stop}
                    onResume={resume}
                    onRetry={again}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  row,
  segments,
  onStop,
  onResume,
  onRetry,
}: {
  readonly row: BroadcastRow;
  readonly segments: Readonly<Record<string, string>>;
  readonly onStop: (id: string) => void;
  readonly onResume: (id: string) => void;
  readonly onRetry: (id: string) => void;
}): React.ReactElement {
  const stopping = row.status === 'running' && row.stopRequestedAt !== null;

  return (
    <tr data-testid={`broadcast-row-${row.id}`}>
      <td>{when(row.createdAt)}</td>
      <td>{segments[row.segment] ?? row.segment}</td>
      <td style={{ maxWidth: 320 }}>{row.text}</td>
      <td data-testid={`broadcast-status-${row.id}`}>
        {stopping ? 'останавливаю' : (STATUS[row.status] ?? row.status)}
      </td>
      <td className="таблица__число">{row.counts.sent}</td>
      <td className="таблица__число">{row.counts.skipped}</td>
      <td className="таблица__число">{row.counts.failed}</td>
      {/*
        «Осталось» считает и взятые строки — правка ревизии этапа.

        Строка, взятая воркером и не дошедшая до отметки, лежит отдельно
        и прежде не попадала ни в одну колонку: панель показывала
        «осталось ноль» у рассылки, которая ещё не дошла до всех.
      */}
      <td className="таблица__число" data-testid={`broadcast-left-${row.id}`}>
        {row.counts.pending + row.counts.sending}
      </td>
      <td>
        {row.status === 'running' && (
          <button
            type="button"
            className="период__кнопка"
            data-testid={`broadcast-stop-${row.id}`}
            disabled={stopping}
            onClick={() => {
              onStop(row.id);
            }}
          >
            {stopping ? 'Останавливаю…' : 'Остановить'}
          </button>
        )}{' '}
        {row.status === 'stopped' && row.counts.pending + row.counts.sending > 0 && (
          <button
            type="button"
            className="период__кнопка"
            data-testid={`broadcast-resume-${row.id}`}
            onClick={() => {
              onResume(row.id);
            }}
          >
            Продолжить
          </button>
        )}{' '}
        {/*
                      Кнопка только у **законченной** рассылки — правка
                      ревизии четвёртого этапа.

                      Прежде она рисовалась по одному признаку «есть
                      неудачные», без оглядки на состояние, и у
                      остановленной рассылки была активна. Нажатие
                      снимало просьбу остановиться и досылало **всех**
                      оставшихся: человек нажимал «Остановить», потом
                      «Повторить неудачные» у трёх адресов — и письмо
                      уходило восьмистам. Отказ теперь и на сервере, но
                      кнопка, которая отказывает, учит не верить панели.
                    */}
        {row.counts.failed > 0 && (row.status === 'done' || row.status === 'failed') && (
          <button
            type="button"
            className="период__кнопка"
            data-testid={`broadcast-retry-${row.id}`}
            onClick={() => {
              onRetry(row.id);
            }}
          >
            Повторить неудачные
          </button>
        )}
      </td>
    </tr>
  );
}
