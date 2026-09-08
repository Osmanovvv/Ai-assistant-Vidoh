import { useCallback, useEffect, useState } from 'react';

import {
  activatePrompt,
  createHotfix,
  NotMeasured,
  promptText,
  prompts,
  reasonOf,
  runEval,
  type EvalRun,
  type FreshnessReason,
  type PromptRow,
  type PromptsPage,
} from './api.js';

/**
 * Промпты (§15 ТЗ, задача 4.8).
 *
 * §15: «Просмотр версий, включение версии, откат. Изменение промпта без
 * выкладки новой версии приложения».
 *
 * **Главное на этом экране — не список, а заслон.** §10.3 требует
 * прогонять контрольный набор на любом изменении промпта. Пока промпты
 * менялись только выкладкой, заслон стоял в скрипте заливки; §15 открыл
 * вторую дверь, и через неё регрессия дошла бы до людей, минуя всё.
 * 28.08.2026 такое уже случилось: выложили `router@3`, потом `router@4`
 * без прогона, и промпт терял три единицы из сорока трёх.
 *
 * Поэтому непрогнанная версия здесь не «предупреждает», а **не
 * включается**. Рядом с отказом стоит кнопка прогона: заслон, который
 * только запрещает, обходят — заслон, рядом с которым лежит способ
 * сделать правильно, соблюдают. Обойти отказ всё же можно, но только
 * набрав слово подтверждения, и это запишется в версию навсегда.
 *
 * **Тексты промптов не грузятся списком.** Это основное ноу-хау
 * продукта; в списке только длина, текст — по отдельному запросу на
 * конкретную версию.
 */

/** Человеческие имена стадий. Ключи из базы — не для глаз. */
const STAGES: Record<string, string> = {
  router: 'Маршрутизатор',
  extractor: 'Извлечение',
  classifier: 'Классификация',
  resolver: 'Резолвер',
  presenter: 'Ответ человеку',
  decomposer: 'Разбиение проекта',
  speech: 'Речь',
  embedder: 'Векторы',
};

/**
 * Имя стадии для человека. Ключ из базы — только если имени нет.
 *
 * Одним помощником на все места вывода: имена стояли в таблице и в
 * заголовке текста, а список «набор не мерит» и причины отказа печатали
 * ключи — «presenter», «router: включается…». Заказчица и проджект
 * читали в одном месте «Ответ человеку», в другом «presenter» и должны
 * были догадаться, что это одно и то же.
 */
function stageName(key: string): string {
  return STAGES[key] ?? key;
}

/**
 * Причина отказа словами: ключ стадии переведён, а не напечатан.
 *
 * Стадия приходит отдельным полем (`FreshnessReason`) — сервер её не
 * склеивает нарочно: человеческие имена есть только здесь.
 */
function reasonLine(reason: FreshnessReason): string {
  return typeof reason === 'string' ? reason : `${stageName(reason.stage)}: ${reason.text}`;
}

/** Слово, которым подтверждают включение без прогона. */
const WORD = 'включаю без прогона';

function when(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

/** Как идут дела у прогона. Отдельно, чтобы не разрастался главный вид. */
function RunState({ run }: { readonly run: EvalRun }): React.ReactElement | null {
  if (run.kind === 'idle') return null;

  const about = run.measuring === undefined ? 'активные версии' : run.measuring.version;

  if (run.kind === 'running') {
    return (
      <p className="оговорка" data-testid="run-state" role="status">
        Идёт прогон набора на {about}, начат в {when(run.startedAt)}. Это минуты, и это стоит денег
        — второй прогон не запустится, пока не кончится этот.
      </p>
    );
  }

  /**
   * Что именно случилось — по исходу, а не по булеву «удался ли».
   *
   * Ревизия четвёртого этапа: «прогон не начался, потому что кончились
   * деньги» показывалось как «порог не пройден». Это обвинение промпта в
   * том, чего он не делал: правку идут искать в промпте, а надо — в
   * потолке расхода. Скрипты различают случаи давно, кодами возврата;
   * панель складывала их в одно слово.
   */
  const SAID: Record<string, string> = {
    passed: 'порог пройден',
    failed: 'порог не пройден',
    'not-started':
      'прогон не начался — потолок расхода. Поднимите потолок или дождитесь новых суток; ' +
      'промпт тут не при чём',
    'bad-call': 'прогон вызван неверно — это наша ошибка, а не качество промпта',
    broken: 'прогон не удалось запустить — промпт тут не при чём',
  };

  return (
    <div className={run.ok ? 'оговорка' : 'отказ'} data-testid="run-state" role="status">
      <p style={{ margin: 0 }}>
        Прогон на {about} закончился {when(run.finishedAt)}:{' '}
        {SAID[run.outcome] ?? (run.ok ? 'порог пройден' : 'порог не пройден')}.
      </p>
      {run.tail !== '' && (
        <pre className="хвост" data-testid="run-tail">
          {run.tail}
        </pre>
      )}
    </div>
  );
}

export function PromptsPanel(): React.ReactElement {
  const [page, setPage] = useState<PromptsPage | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState<PromptRow | undefined>(undefined);
  const [text, setText] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [refusal, setRefusal] = useState<
    { readonly row: PromptRow; readonly reasons: readonly FreshnessReason[] } | undefined
  >(undefined);
  const [word, setWord] = useState('');
  const [done, setDone] = useState<string | undefined>(undefined);
  /**
   * Запрос на прогон **в пути** — свой признак, а не загруженное состояние.
   *
   * Кнопка гасилась по `page.run.kind === 'running'`, то есть по тому,
   * что уже пришло с сервера: между нажатием и ответом она оставалась
   * живой. Второе нажатие получало 409 «прогон уже идёт» — и это была
   * правда: прогон запущен и уже тратит деньги.
   */
  const [asking, setAsking] = useState(false);
  /**
   * Неудача **одного действия**, а не поломка раздела.
   *
   * Прежде отказ прогона уходил в `problem`, и ранний возврат заменял
   * весь раздел одной красной строкой «Не удалось запустить прогон»: без
   * таблицы, без отказа, без кнопки. Выйти можно было только сменой
   * вкладки — и сообщение при этом было неправдой наоборот.
   */
  const [runProblem, setRunProblem] = useState<string | undefined>(undefined);
  /**
   * Отказ действия — включения версии или сохранения правки.
   *
   * Та же болезнь, что была у прогона, и лечится тем же: сервер называет
   * причину («набор на этой версии не прогнан», «правка не отличается от
   * основы»), а панель писала своё «не удалось включить версию» и
   * ранним возвратом заменяла раздел одной красной строкой. Человек
   * терял и таблицу, и набранный текст правки, и повода не узнавал.
   */
  const [refused, setRefused] = useState<string | undefined>(undefined);
  /**
   * Отказ чтения **одной** версии, а не раздела.
   *
   * Своё состояние, потому что место у него своё: окно версии открыто, и
   * сказать про неудачу надо в нём. Без этого окно оставалось на «Читаю…»
   * навсегда — молчание вместо причины.
   */
  const [textProblem, setTextProblem] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    void prompts()
      .then(setPage)
      .catch((error: unknown) => {
        // Ранний возврат здесь на месте: не прочитан сам раздел, и
        // показывать было бы нечего. Но причину называет сервер.
        setProblem(reasonOf(error, 'Не удалось прочитать промпты'));
      });
  }, []);

  useEffect(load, [load]);

  /**
   * Пока прогон идёт, страница сама спрашивает, как дела.
   *
   * Иначе человек, нажавший кнопку, остался бы перед неподвижным
   * экраном на несколько минут и нажал бы ещё раз.
   */
  const runKind = page?.enabled === true ? page.run.kind : undefined;

  useEffect(() => {
    if (runKind !== 'running') return undefined;

    const timer = setInterval(load, 5_000);
    return () => {
      clearInterval(timer);
    };
  }, [runKind, load]);

  if (problem !== undefined) {
    return (
      <p className="отказ" role="alert">
        {problem}
      </p>
    );
  }

  if (page === undefined) return <p className="разрез__пусто">Читаю…</p>;

  if (!page.enabled) {
    /**
     * Раздел выключен нарочно — и здесь об этом сказано словами.
     *
     * Прежде на этом месте стояло красное «Не удалось прочитать
     * промпты»: путей `/api/prompts*` без отчётов прогонов не
     * объявлялось вовсе, запрос ловила отдача файлов панели, и разбор
     * ответа спотыкался. Человек читал это как поломку панели и шёл
     * искать её в журналах — а раздела просто нет, по причине, которую
     * сервер называет. Красная строка осталась только для настоящего
     * сбоя.
     */
    return (
      <div data-testid="prompts-off">
        <p className="оговорка">Раздела промптов сейчас нет: {page.why}.</p>
        <p className="оговорка" style={{ marginBottom: 8 }}>
          Отчёты кладёт на сервер заливка промптов с машины разработчика:
        </p>
        <pre className="хвост" data-testid="prompts-off-how">
          {page.how}
        </pre>
        <p className="оговорка">
          Сам контрольный набор на сервер не едет и не должен: в нём живые расшифровки людей (§16).
          Прогон и включение версий делаются оттуда же, с машины разработчика.
        </p>
      </div>
    );
  }

  const show = (row: PromptRow): void => {
    setOpen(row);
    setText(undefined);
    setDraft(undefined);
    setRefusal(undefined);
    setRefused(undefined);
    setTextProblem(undefined);

    void promptText(row.stage, row.version)
      .then((found) => {
        setText(found.prompt);
      })
      .catch((error: unknown) => {
        setTextProblem(reasonOf(error, 'Не удалось прочитать текст версии'));
      });
  };

  const activate = (row: PromptRow, acknowledged: boolean): void => {
    setDone(undefined);
    setRefusal(undefined);
    setRunProblem(undefined);
    setRefused(undefined);

    void activatePrompt({ stage: row.stage, version: row.version, acknowledged })
      .then(() => {
        setDone(row.version);
        setWord('');
        load();
      })
      .catch((error: unknown) => {
        if (error instanceof NotMeasured) {
          setRefusal({ row, reasons: error.reasons });
          return;
        }

        setRefused(reasonOf(error, 'Не удалось включить версию'));
      });
  };

  const measure = (row: PromptRow): void => {
    setAsking(true);
    setRunProblem(undefined);

    void runEval({ stage: row.stage, version: row.version })
      .then(() => {
        load();
      })
      .catch((error: unknown) => {
        /**
         * Причину называет сервер — «прогон уже идёт», — и она
         * единственная, по которой понятно, что делать: ждать, а не
         * жать снова. Своё «не удалось запустить» на её месте было
         * неправдой наоборот: прогон запущен и уже тратит деньги.
         */
        setRunProblem(reasonOf(error, 'Не удалось запустить прогон'));

        // И перечитать состояние: на странице оно устарело — за этим и
        // было второе нажатие.
        load();
      })
      .finally(() => {
        setAsking(false);
      });
  };

  const save = (): void => {
    if (open === undefined || draft === undefined || draft.trim() === '') return;

    setRefused(undefined);

    void createHotfix({ stage: open.stage, basedOn: open.version, prompt: draft })
      .then((made) => {
        setDone(made.version);
        setOpen(undefined);
        setDraft(undefined);
        load();
      })
      .catch((error: unknown) => {
        // Окно и черновик остаются: человек правит набранное, а не
        // набирает заново.
        setRefused(reasonOf(error, 'Не удалось сохранить правку'));
      });
  };

  const running = page.run.kind === 'running';

  return (
    <div data-testid="prompts">
      <p className="оговорка">
        Правка создаёт новую версию, а не меняет старую: опубликованное неизменно, иначе жалобу
        «неделю назад было лучше» не с чем сверить. Включается версия отдельным действием — и только
        с прогнанным набором (§10.3).
      </p>

      {page.freshness.ok ? (
        <p className="оговорка" data-testid="freshness-ok">
          Набор на включённых сейчас версиях прогнан
          {page.freshness.runs.length === 0 ? '' : `: ${page.freshness.runs.join(', ')}`}.
          {page.freshness.unmeasured.length > 0 &&
            ` Набор не мерит: ${page.freshness.unmeasured.map(stageName).join(', ')} — эти включаются без измерения.`}
        </p>
      ) : (
        <div className="отказ" data-testid="freshness-bad" role="alert">
          <p style={{ margin: 0 }}>Включённое сейчас набором не подтверждено:</p>
          <ul>
            {page.freshness.reasons.map(reasonLine).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      <RunState run={page.run} />

      {done !== undefined && (
        <p className="оговорка" data-testid="prompt-done" role="status">
          Готово: {done}
        </p>
      )}

      {refused !== undefined && (
        <p className="отказ" data-testid="prompt-refused" role="alert">
          {refused}
        </p>
      )}

      <div className="таблица-обёртка">
        <table className="таблица">
          <thead>
            <tr>
              <th>Этап</th>
              <th>Версия</th>
              <th className="таблица__число">Знаков</th>
              <th>Заведена</th>
              <th>Примечание</th>
              <th>Что сделать</th>
            </tr>
          </thead>
          <tbody>
            {page.versions.map((row) => (
              <tr key={`${row.stage}/${row.version}`} data-testid={`version-${row.version}`}>
                <td>{stageName(row.stage)}</td>
                <td>
                  {row.version}
                  {row.isActive && (
                    <span className="метка" data-testid={`active-${row.stage}`}>
                      {' '}
                      включена
                    </span>
                  )}
                </td>
                <td className="таблица__число">{row.length}</td>
                <td>{when(row.createdAt)}</td>
                <td className="панель__кто">{row.note ?? ''}</td>
                <td>
                  <button
                    type="button"
                    className="период__кнопка"
                    onClick={() => {
                      show(row);
                    }}
                  >
                    Текст
                  </button>{' '}
                  {!row.isActive && (
                    <button
                      type="button"
                      className="период__кнопка"
                      data-testid={`activate-${row.version}`}
                      onClick={() => {
                        activate(row, false);
                      }}
                    >
                      Включить
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {refusal !== undefined && (
        <div className="отказ" data-testid="refusal" role="alert">
          <p style={{ margin: '0 0 8px' }}>
            Версия {refusal.row.version} не включена: набор на ней не прогнан.
          </p>
          <ul>
            {refusal.reasons.map(reasonLine).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          <p style={{ margin: '8px 0' }}>
            {page.canRun
              ? 'Правильный путь — прогнать набор на этой версии. Прогон идёт минутами и стоит денег.'
              : 'Правильный путь — прогнать набор на этой версии.'}
          </p>

          {page.canRun ? (
            <button
              type="button"
              className="период__кнопка"
              data-testid="measure"
              disabled={running || asking}
              onClick={() => {
                measure(refusal.row);
              }}
            >
              {asking
                ? 'Запрашиваю прогон…'
                : running
                  ? 'Прогон уже идёт'
                  : 'Прогнать набор на этой версии'}
            </button>
          ) : (
            <p style={{ margin: 0 }} data-testid="no-runner">
              Прогнать набор отсюда нельзя: сам набор живёт на машине разработчика — в нём живые
              расшифровки людей, и на сервере им делать нечего. Прогон и включение версии делаются
              оттуда.
            </p>
          )}

          {runProblem !== undefined && (
            <p style={{ margin: '8px 0 0' }} data-testid="run-problem" role="status">
              Прогон не запустился: {runProblem}.
            </p>
          )}

          <p style={{ margin: '16px 0 4px' }}>
            Если версию всё же нужно включить сейчас — напишите «{WORD}». Это запишется в версию
            навсегда.
          </p>

          <input
            className="поле__ввод"
            data-testid="ack-word"
            value={word}
            onChange={(event) => {
              setWord(event.target.value);
            }}
          />
          <button
            type="button"
            className="период__кнопка"
            data-testid="force"
            style={{ marginLeft: 8 }}
            disabled={word.trim().toLowerCase() !== WORD}
            onClick={() => {
              activate(refusal.row, true);
            }}
          >
            Включить без прогона
          </button>
        </div>
      )}

      {open !== undefined && (
        <div className="разрез" data-testid="prompt-text">
          <h3 className="разрез__имя">
            {stageName(open.stage)} — {open.version}
          </h3>

          {textProblem !== undefined ? (
            <p className="отказ" data-testid="prompt-text-problem" role="alert">
              {textProblem}
            </p>
          ) : text === undefined ? (
            <p className="разрез__пусто">Читаю…</p>
          ) : (
            <>
              <pre className="хвост" data-testid="prompt-body">
                {text}
              </pre>

              {draft === undefined ? (
                <button
                  type="button"
                  className="период__кнопка"
                  data-testid="edit"
                  onClick={() => {
                    setDraft(text);
                  }}
                >
                  Править (создаст новую версию)
                </button>
              ) : (
                <>
                  <textarea
                    className="поле__ввод"
                    data-testid="editor"
                    rows={14}
                    value={draft}
                    onChange={(event) => {
                      setDraft(event.target.value);
                    }}
                  />
                  <p className="оговорка">
                    Сохранение заведёт новую версию на основе {open.version}. Включённой она не
                    станет: сначала прогон набора.
                  </p>
                  <button
                    type="button"
                    className="период__кнопка"
                    data-testid="save-hotfix"
                    disabled={draft.trim() === '' || draft === text}
                    onClick={save}
                  >
                    Сохранить как новую версию
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
