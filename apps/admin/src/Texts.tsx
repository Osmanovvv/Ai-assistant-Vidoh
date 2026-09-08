import { useCallback, useEffect, useState } from 'react';

import { reasonOf, saveText, texts, type TextRow, type TextsPage } from './api.js';

/**
 * Реплики бота (§13.9 ТЗ, задача 4.13).
 *
 * §13.9 дословно: «Все тексты хранятся в отдельном словаре и меняются
 * **без выкладки новой версии приложения**». Словарь отдельный был со
 * второго этапа, а правился только выкладкой — то есть требование
 * исполнялось наполовину.
 *
 * **Правка действует сразу, и это меняет цену ошибки.** Пока реплики
 * менялись выкладкой, их смотрел прогон и чужой взгляд. Теперь между
 * набранной фразой и живым человеком стоит только проверка §13 на
 * сервере, поэтому отказ здесь печатается словами сервера: «в реплике не
 * бывает двух вопросов, а здесь их два» человек исправит, «не удалось
 * сохранить» — не исправит ничего.
 *
 * **Слова из кода показаны рядом.** Человек, правящий реплику, должен
 * видеть, что именно он заменяет и к чему вернуться. Пустое поле
 * возвращает реплику к словам из кода — отдельной кнопки для этого не
 * нужно, и лишней строки в базе не остаётся.
 */

/** Человеческие названия разделов словаря — в порядке, в каком читать. */
const SECTIONS: Readonly<Record<string, string>> = {
  start: 'Первый экран и знакомство',
  onboarding: 'Опрос при первом запуске',
  listening: 'Пока бот слушает и разбирает',
  answer: 'Ответ на выгрузку',
  backlog: 'Вопрос по бэклогу',
  resolver: 'Правки и отмена',
  returning: 'Возвращение после паузы',
  safety: 'Эмоции и кризис',
  reminders: 'Напоминания',
  summary: 'Сводки',
  project: 'Большие цели',
  card: 'Карточка записи',
  menu: 'Меню и навигация',
  settings: 'Настройки в боте',
  billing: 'Подписка и оплата',
  limits: 'Пределы и отказы',
  privacy: 'Данные и удаление',
  errors: 'Сбои',
};

function sectionOf(path: string): string {
  const [head] = path.split('.');

  return head ?? path;
}

export function TextsPanel(): React.ReactElement {
  const [page, setPage] = useState<TextsPage | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [refused, setRefused] = useState<{ path: string; why: string } | undefined>(undefined);
  const [said, setSaid] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<Readonly<Record<string, string>>>({});
  const [query, setQuery] = useState<string>('');

  const load = useCallback(() => {
    void texts()
      .then((next) => {
        setPage(next);
        // Черновики снимаются: они относились к прежним значениям, и
        // оставить их значило бы показать человеку своё поверх чужого.
        setDraft({});
      })
      .catch((error: unknown) => {
        setProblem(reasonOf(error, 'Не удалось прочитать реплики'));
      });
  }, []);

  useEffect(load, [load]);

  if (problem !== undefined) {
    return (
      <p className="отказ" role="alert">
        {problem}
      </p>
    );
  }

  if (page === undefined) return <p className="разрез__пусто">Читаю…</p>;

  const keep = (row: TextRow): void => {
    setRefused(undefined);
    setSaid(undefined);

    void saveText(row.path, draft[row.path] ?? row.said)
      .then((outcome) => {
        setSaid(
          outcome.reset
            ? `«${row.path}» снова говорит словами из кода.`
            : `«${row.path}» сохранена. Бот говорит так уже сейчас.`,
        );
        load();
      })
      .catch((error: unknown) => {
        setRefused({ path: row.path, why: reasonOf(error, 'Не удалось сохранить') });
      });
  };

  const shown = page.rows.filter((row) => {
    const needle = query.trim().toLowerCase();

    if (needle === '') return true;

    return (
      row.path.toLowerCase().includes(needle) ||
      row.said.toLowerCase().includes(needle) ||
      (SECTIONS[sectionOf(row.path)] ?? '').toLowerCase().includes(needle)
    );
  });

  const edited = page.rows.filter((row) => row.edited).length;

  return (
    <div data-testid="texts">
      <p className="оговорка">
        Правка применяется сразу, без выкладки и без перезапуска бота. Пустое поле возвращает
        реплику к словам из кода. Правлено сейчас: {edited} из {page.rows.length}.
      </p>

      <p className="оговорка">
        Чего боту нельзя по §13: двух вопросов в одной реплике, серий восклицательных знаков, фраз
        вроде «отдохни», «как ты себя чувствуешь», «ты молодец», эмодзи-украшений. Если правка
        нарушит правило, панель откажет и скажет какое — молча ничего не уедет.
      </p>

      <label className="поиск">
        <span className="поиск__имя">Найти реплику</span>
        <input
          type="search"
          name="q"
          data-testid="texts-search"
          value={query}
          placeholder="слово из реплики или её адрес"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </label>

      {said !== undefined && (
        <p className="оговорка" data-testid="texts-saved" role="status">
          {said}
        </p>
      )}

      {shown.length === 0 && <p className="разрез__пусто">Ничего не нашлось.</p>}

      {Object.entries(SECTIONS).map(([key, title]) => {
        const rows = shown.filter((row) => sectionOf(row.path) === key);

        if (rows.length === 0) return null;

        return (
          <section className="разрез" key={key}>
            <h3 className="разрез__имя">{title}</h3>

            {rows.map((row) => (
              <div className="реплика" data-testid={`text-${row.path}`} key={row.path}>
                <div className="реплика__путь">
                  {row.path}
                  {row.places > 0 && (
                    <span className="реплика__подстановка">
                      {' · '}
                      подставляется значений: {row.places} — оставьте{' '}
                      {Array.from(
                        { length: row.places },
                        (_unused, index) => `{${String(index + 1)}}`,
                      ).join(', ')}
                    </span>
                  )}
                  {row.edited && (
                    <span className="реплика__правлена" data-testid={`text-edited-${row.path}`}>
                      {' · '}
                      правлена{row.updatedBy === undefined ? '' : `: ${row.updatedBy}`}
                    </span>
                  )}
                </div>

                <textarea
                  className="реплика__поле"
                  data-testid={`text-input-${row.path}`}
                  rows={Math.min(8, row.said.split('\n').length + 1)}
                  value={draft[row.path] ?? row.said}
                  onChange={(event) => {
                    setDraft({ ...draft, [row.path]: event.target.value });
                  }}
                />

                {row.edited && (
                  <p className="реплика__код">
                    В коде: <span>{row.fromCode}</span>
                  </p>
                )}

                {refused?.path === row.path && (
                  <p className="отказ" data-testid={`text-refused-${row.path}`} role="alert">
                    {refused.why}
                  </p>
                )}

                <button
                  type="button"
                  className="период__кнопка"
                  data-testid={`text-save-${row.path}`}
                  onClick={() => {
                    keep(row);
                  }}
                >
                  Сохранить
                </button>
              </div>
            ))}
          </section>
        );
      })}

      {page.hidden.length > 0 && (
        <section className="разрез">
          <h3 className="разрез__имя">Чего здесь нет, и почему</h3>

          {page.hidden.map((one) => (
            <p className="оговорка" key={one.path} data-testid={`text-hidden-${one.path}`}>
              <b>{one.path}</b> — {one.why}.
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
