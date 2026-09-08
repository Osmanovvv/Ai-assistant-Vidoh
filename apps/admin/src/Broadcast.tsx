import { useCallback, useEffect, useState } from 'react';

import {
  broadcastPreview,
  broadcasts,
  cancelBroadcast,
  createBroadcast,
  reasonOf,
  resumeBroadcast,
  retryBroadcast,
  startBroadcast,
  stopBroadcast,
  type BroadcastRow,
  type BroadcastsPage,
} from './api.js';
/**
 * Слова об обрезке берутся у «Ошибок», а не пишутся заново.
 *
 * Там эта строка уже написана для шести журналов, и один способ сказать
 * «показано не всё» лучше двух: второй расходится молча — так и вышло
 * внутри самих «Ошибок», где строка досталась одному журналу из шести.
 */
import { Trimmed } from './Errors.js';

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
  /**
   * Два отказа — два состояния (ревизия панели).
   *
   * `problem` — не смогли **прочитать** рассылки: показывать нечего.
   * `refused` — сервер отказал **действию**: список на месте, набранный
   * текст на месте, и гасить раздел нельзя. Прежде состояние было одно,
   * и «слишком длинно» уносило с экрана и список, и поле ввода — вместе
   * с самим текстом, который человек только что набрал.
   */
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [refused, setRefused] = useState<string | undefined>(undefined);

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
    setRefused(undefined);
    setPreview(undefined);
    setDraft(undefined);

    void broadcastPreview(segment)
      .then((found) => {
        setPreview({ recipients: found.recipients, title: found.title });
      })
      .catch((error: unknown) => {
        setRefused(reasonOf(error, 'Не удалось посчитать получателей'));
      });
  };

  const make = (): void => {
    setRefused(undefined);
    void createBroadcast({ text, segment })
      .then((made) => {
        setDraft({ id: made.id, recipients: made.recipients });
        load();
      })
      .catch((error: unknown) => {
        /**
         * Сервер называет причину, и она поправимая: «слишком длинно:
         * 4200 знаков, Telegram принимает 4096». Человек это исправит, а
         * «не удалось составить рассылку» — нет.
         */
        setRefused(reasonOf(error, 'Не удалось составить рассылку'));
      });
  };

  const send = (id: string): void => {
    setRefused(undefined);
    void startBroadcast(id)
      .then(() => {
        setDraft(undefined);
        setText('');
        setPreview(undefined);
        load();
      })
      .catch((error: unknown) => {
        setRefused(reasonOf(error, 'Не удалось запустить рассылку'));
      });
  };

  const stop = (id: string): void => {
    setRefused(undefined);
    void stopBroadcast(id)
      .then(load)
      .catch((error: unknown) => {
        setRefused(reasonOf(error, 'Не удалось остановить'));
      });
  };

  const resume = (id: string): void => {
    setRefused(undefined);
    void resumeBroadcast(id)
      .then(load)
      .catch((error: unknown) => {
        setRefused(reasonOf(error, 'Не удалось продолжить'));
      });
  };

  /**
   * Отмена черновика — выход из случайно составленного.
   *
   * Без неё единственным выходом была отправка всем: строка со статусом
   * «черновик» не имела ни одного действия, а «Отправить» жила в памяти
   * браузера и стиралась уходом в другой раздел.
   */
  const drop = (id: string): void => {
    setRefused(undefined);

    void cancelBroadcast(id)
      .then(() => {
        setDraft(undefined);
        load();
      })
      .catch((error: unknown) => {
        setRefused(reasonOf(error, 'Не удалось отменить'));
        // Перечитываем: отказ чаще всего значит, что строка устарела.
        load();
      });
  };

  const again = (id: string): void => {
    setRefused(undefined);
    void retryBroadcast(id)
      .then(load)
      .catch((error: unknown) => {
        /**
         * «Повторять можно только законченную рассылку» — это состояние,
         * а не поломка: человек нажал у идущей. Прежде он читал
         * «не удалось повторить» и шёл искать причину в коде.
         */
        setRefused(reasonOf(error, 'Не удалось повторить'));
      });
  };

  return (
    <div data-testid="broadcast">
      {refused !== undefined && (
        <p className="отказ" data-testid="broadcast-refused" role="alert">
          {refused}
        </p>
      )}

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
        {/*
          Число рассылок в заголовке — правка ревизии панели.

          Запрос отдаёт **последние двадцать**, а заголовок обещал
          «прошлые рассылки»: итога не было, страниц не было, оговорки
          не было. После двадцать первой рассылки предыдущие исчезали
          молча — вместе с единственным путём к «Повторить неудачные» и
          вместе с ответом на вопрос «а это письмо мы уже отправляли?».
        */}
        <h3 className="разрез__имя">
          Прошлые рассылки {page.total > 0 && `— всего ${String(page.total)}`}
        </h3>

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
                    onSend={send}
                    onDrop={drop}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Trimmed shown={page.rows.length} total={page.total} />
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
  onSend,
  onDrop,
}: {
  readonly row: BroadcastRow;
  readonly segments: Readonly<Record<string, string>>;
  readonly onStop: (id: string) => void;
  readonly onResume: (id: string) => void;
  readonly onRetry: (id: string) => void;
  readonly onSend: (id: string) => void;
  readonly onDrop: (id: string) => void;
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
        {/*
          Черновик — не тупик (ревизия панели).

          Прежде у строки со статусом «черновик» не рисовалось ни одной
          кнопки: «Отправить» жила в памяти браузера и стиралась уходом в
          другой раздел или обновлением страницы. Строка при этом уже
          существовала вместе с тысячей строк доставки, и выйти из
          ошибочного черновика можно было только отправкой всем.
        */}
        {row.status === 'draft' && (
          <>
            <button
              type="button"
              className="период__кнопка"
              data-testid={`broadcast-send-${row.id}`}
              onClick={() => {
                onSend(row.id);
              }}
            >
              Отправить
            </button>{' '}
            <button
              type="button"
              className="период__кнопка"
              data-testid={`broadcast-cancel-${row.id}`}
              onClick={() => {
                onDrop(row.id);
              }}
            >
              Отменить
            </button>
          </>
        )}{' '}
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
        {/*
          **И про просьбу остановиться условие тоже спрашивает** (ревизия
          панели).

          Сервер требует ещё и пустую метку `stop_requested_at`, а условие
          показа про неё не знало: у законченной рассылки с непустой меткой
          кнопка висела активной и отвечала 409 на каждое нажатие. Само это
          состояние теперь не заводится — `finishBroadcast` разбирает
          метку, — но условие показа обязано совпадать с условием сервера:
          иначе они разойдутся снова на первой же строке, пришедшей из
          базы, заполненной до этой правки.
        */}
        {row.counts.failed > 0 &&
          row.stopRequestedAt === null &&
          (row.status === 'done' || row.status === 'failed') && (
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
