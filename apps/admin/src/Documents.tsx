import { TableKit } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useCallback, useEffect, useState } from 'react';

import {
  documentGet,
  documentSave,
  documentsList,
  documentVersion,
  reasonOf,
  type DocumentDetail,
  type DocumentSummary,
} from './api.js';

/**
 * Документы продукта — оферта, политика, соглашение, согласие.
 *
 * Список → документ отдельной страницей с редактором «как Word»:
 * человек видит документ, а не разметку; правит заголовки, списки,
 * ссылки, таблицы; «Сохранить» — и страница `/docs/<slug>` отдаёт новый
 * текст сразу. Каждое сохранение остаётся в истории — вернуться можно
 * к любой версии.
 *
 * Редактор — TipTap (ProseMirror): открытая лицензия, вставка из Word
 * сохраняет структуру, панель инструментов — наша, без лишнего.
 */
export function DocumentsPanel(): React.ReactElement {
  const [open, setOpen] = useState<string | undefined>(undefined);

  if (open !== undefined) {
    return (
      <DocumentPage
        slug={open}
        onBack={() => {
          setOpen(undefined);
        }}
      />
    );
  }

  return (
    <DocumentsList
      onOpen={(slug) => {
        setOpen(slug);
      }}
    />
  );
}

function when(iso: string | null): string {
  if (iso === null) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Moscow',
  }).format(new Date(iso));
}

function DocumentsList(props: { readonly onOpen: (slug: string) => void }): React.ReactElement {
  const [rows, setRows] = useState<readonly DocumentSummary[] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  useEffect(() => {
    void documentsList()
      .then((page) => {
        setRows(page.rows);
      })
      .catch((error: unknown) => {
        setProblem(reasonOf(error, 'Не удалось прочитать документы'));
      });
  }, []);

  if (problem !== undefined) {
    return (
      <p className="отказ" role="alert">
        {problem}
      </p>
    );
  }

  if (rows === undefined) return <p className="разрез__пусто">Читаю…</p>;

  return (
    <section className="разрез" data-testid="documents">
      <h2 className="разрез__имя">Документы</h2>
      <p className="оговорка">
        Публичные документы продукта. Сохранение публикует сразу: люди видят их по ссылкам из бота,
        история версий хранится.
      </p>
      <ul className="документы">
        {rows.map((row) => (
          <li key={row.slug} className="документы__строка">
            <button
              type="button"
              className="документы__имя"
              data-testid={`document-open-${row.slug}`}
              onClick={() => {
                props.onOpen(row.slug);
              }}
            >
              {row.title}
            </button>
            <span className="документы__когда">
              {row.updatedAt === null
                ? 'ещё не заполнен'
                : `изменён ${when(row.updatedAt)}${row.updatedBy === null ? '' : ` · ${row.updatedBy}`}`}
              {row.editionDate === null ? '' : ` · редакция от ${row.editionDate}`}
            </span>
            {row.updatedAt === null ? null : (
              <a
                className="документы__ссылка"
                href={row.publicPath}
                target="_blank"
                rel="noreferrer"
              >
                открыть страницу
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DocumentPage(props: {
  readonly slug: string;
  readonly onBack: () => void;
}): React.ReactElement {
  const [doc, setDoc] = useState<DocumentDetail | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [editionDate, setEditionDate] = useState<string>('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [said, setSaid] = useState<string | undefined>(undefined);
  const [refused, setRefused] = useState<string | undefined>(undefined);

  /**
   * Редактор пересоздаётся на каждую загрузку документа, а содержимое
   * идёт в него при создании — а не `setContent` поверх пустого. Иначе
   * загрузка попадала бы в историю отмены, и два «Ctrl+Z» подряд стирали
   * бы весь документ до пустого листа (поймано на стенде 15.09.2026).
   */
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4] },
          link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
          codeBlock: false,
          code: false,
        }),
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        TableKit.configure({ table: { resizable: false } }),
      ],
      content: doc?.html ?? '',
      onUpdate: () => {
        setDirty(true);
      },
    },
    [doc?.html, doc?.updatedAt],
  );

  const load = useCallback(() => {
    void documentGet(props.slug)
      .then((next) => {
        setDoc(next);
        setEditionDate(next.editionDate ?? '');
        setDirty(false);
      })
      .catch((error: unknown) => {
        setProblem(reasonOf(error, 'Не удалось открыть документ'));
      });
  }, [props.slug]);

  useEffect(load, [load]);

  if (problem !== undefined) {
    return (
      <p className="отказ" role="alert">
        {problem}
      </p>
    );
  }

  if (doc === undefined) return <p className="разрез__пусто">Читаю…</p>;

  const save = (): void => {
    setRefused(undefined);
    setSaid(undefined);
    setSaving(true);

    void documentSave(props.slug, {
      html: editor.getHTML(),
      editionDate: editionDate.trim() === '' ? null : editionDate.trim(),
    })
      .then(() => {
        setSaid('Сохранено и опубликовано. Страница отдаёт этот текст уже сейчас.');
        load();
      })
      .catch((error: unknown) => {
        setRefused(reasonOf(error, 'Не удалось сохранить'));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const restore = (id: string): void => {
    setRefused(undefined);
    setSaid(undefined);

    void documentVersion(props.slug, id)
      .then((version) => {
        editor.commands.setContent(version.html, { emitUpdate: true });
        setDirty(true);
        setSaid('Прежняя версия в редакторе. Нажми «Сохранить», чтобы она стала действующей.');
      })
      .catch((error: unknown) => {
        setRefused(reasonOf(error, 'Не удалось прочитать версию'));
      });
  };

  return (
    <section className="разрез документ" data-testid="document">
      <div className="документ__шапка">
        <button
          type="button"
          className="кнопка кнопка--тихая документ__назад"
          onClick={props.onBack}
        >
          ← К списку
        </button>
        <h2 className="разрез__имя">{doc.title}</h2>
        <span className="документы__когда">
          {doc.updatedAt === null
            ? 'ещё не публиковался'
            : `изменён ${when(doc.updatedAt)}${doc.updatedBy === null ? '' : ` · ${doc.updatedBy}`}`}
        </span>
      </div>

      <div className="документ__свойства">
        <label className="поле документ__дата">
          <span className="поле__имя">Дата редакции</span>
          <input
            className="поле__ввод"
            type="date"
            data-testid="document-date"
            value={editionDate}
            onChange={(event) => {
              setEditionDate(event.target.value);
              setDirty(true);
            }}
          />
        </label>
        <div className="документ__действия">
          <button
            type="button"
            className="кнопка документ__сохранить"
            data-testid="document-save"
            disabled={saving || !dirty}
            onClick={save}
          >
            {saving ? 'Сохраняю…' : 'Сохранить'}
          </button>
          {doc.updatedAt === null ? null : (
            <a
              className="документы__ссылка"
              data-testid="document-public"
              href={doc.publicPath}
              target="_blank"
              rel="noreferrer"
            >
              открыть страницу
            </a>
          )}
        </div>
      </div>

      {said !== undefined ? (
        <p className="оговорка" data-testid="document-said">
          {said}
        </p>
      ) : null}
      {refused !== undefined ? (
        <p className="отказ" role="alert" data-testid="document-refused">
          {refused}
        </p>
      ) : null}

      <Toolbar editor={editor} />
      <div className="документ__лист" data-testid="document-editor">
        <EditorContent editor={editor} />
      </div>

      <h3 className="разрез__имя документ__история-имя">История</h3>
      {doc.versions.length === 0 ? (
        <p className="разрез__пусто">Сохранений ещё не было.</p>
      ) : (
        <ul className="документ__история" data-testid="document-versions">
          {doc.versions.map((version, index) => (
            <li key={version.id} className="документ__версия" data-testid="document-version">
              <span>
                {when(version.savedAt)}
                {version.savedBy === null ? '' : ` · ${version.savedBy}`}
                {version.editionDate === null ? '' : ` · редакция от ${version.editionDate}`}
                {index === 0 ? ' · действующая' : ''}
              </span>
              {index === 0 ? null : (
                <button
                  type="button"
                  className="кнопка кнопка--тихая документ__вернуть"
                  data-testid="document-restore"
                  onClick={() => {
                    restore(version.id);
                  }}
                >
                  вернуть в редактор
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Панель инструментов: только то, что нужно документу. */
function Toolbar(props: { readonly editor: Editor }): React.ReactElement {
  const { editor } = props;
  // Перерисовка на каждое изменение выделения — иначе кнопки не
  // подсвечивают, где стоит курсор.
  const [, tick] = useState(0);
  useEffect(() => {
    const bump = (): void => {
      tick((value) => value + 1);
    };
    editor.on('selectionUpdate', bump);
    editor.on('transaction', bump);
    return () => {
      editor.off('selectionUpdate', bump);
      editor.off('transaction', bump);
    };
  }, [editor]);

  const button = (
    label: string,
    title: string,
    run: () => void,
    active = false,
    disabled = false,
  ): React.ReactElement => (
    <button
      type="button"
      className={active ? 'инструмент инструмент--включён' : 'инструмент'}
      title={title}
      disabled={disabled}
      onMouseDown={(event) => {
        // Кнопка не должна забирать фокус у редактора: иначе выделение
        // теряется до того, как команда его прочтёт.
        event.preventDefault();
      }}
      onClick={run}
    >
      {label}
    </button>
  );

  const setLink = (): void => {
    const current = (editor.getAttributes('link') as { href?: string }).href ?? '';
    const href = window.prompt('Адрес ссылки (https://…)', current);
    if (href === null) return;
    if (href.trim() === '') {
      editor.chain().focus().unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run();
  };

  const heading = editor.isActive('heading', { level: 1 })
    ? 'h1'
    : editor.isActive('heading', { level: 2 })
      ? 'h2'
      : editor.isActive('heading', { level: 3 })
        ? 'h3'
        : editor.isActive('heading', { level: 4 })
          ? 'h4'
          : 'p';

  return (
    <div className="инструменты" role="toolbar" aria-label="Форматирование">
      <select
        className="инструмент инструмент--выбор"
        title="Стиль абзаца"
        value={heading}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        onChange={(event) => {
          const value = event.target.value;
          if (value === 'p') editor.chain().focus().setParagraph().run();
          else {
            const level = Number(value.slice(1)) as 1 | 2 | 3 | 4;
            editor.chain().focus().setHeading({ level }).run();
          }
        }}
      >
        <option value="p">Обычный текст</option>
        <option value="h1">Заголовок 1</option>
        <option value="h2">Заголовок 2</option>
        <option value="h3">Заголовок 3</option>
        <option value="h4">Заголовок 4</option>
      </select>

      <span className="инструменты__группа">
        {button(
          'Ж',
          'Жирный (Ctrl+B)',
          () => editor.chain().focus().toggleBold().run(),
          editor.isActive('bold'),
        )}
        {button(
          'К',
          'Курсив (Ctrl+I)',
          () => editor.chain().focus().toggleItalic().run(),
          editor.isActive('italic'),
        )}
        {button(
          'Ч',
          'Подчёркнутый (Ctrl+U)',
          () => editor.chain().focus().toggleUnderline().run(),
          editor.isActive('underline'),
        )}
        {button(
          'S',
          'Зачёркнутый',
          () => editor.chain().focus().toggleStrike().run(),
          editor.isActive('strike'),
        )}
      </span>

      <span className="инструменты__группа">
        {button(
          '• список',
          'Маркированный список',
          () => editor.chain().focus().toggleBulletList().run(),
          editor.isActive('bulletList'),
        )}
        {button(
          '1. список',
          'Нумерованный список',
          () => editor.chain().focus().toggleOrderedList().run(),
          editor.isActive('orderedList'),
        )}
        {button(
          '❝',
          'Цитата',
          () => editor.chain().focus().toggleBlockquote().run(),
          editor.isActive('blockquote'),
        )}
        {button('—', 'Горизонтальная линия', () =>
          editor.chain().focus().setHorizontalRule().run(),
        )}
      </span>

      <span className="инструменты__группа">
        {button(
          '⇤',
          'По левому краю',
          () => editor.chain().focus().setTextAlign('left').run(),
          editor.isActive({ textAlign: 'left' }),
        )}
        {button(
          '☰',
          'По центру',
          () => editor.chain().focus().setTextAlign('center').run(),
          editor.isActive({ textAlign: 'center' }),
        )}
        {button(
          '⇥',
          'По правому краю',
          () => editor.chain().focus().setTextAlign('right').run(),
          editor.isActive({ textAlign: 'right' }),
        )}
        {button(
          '≡',
          'По ширине',
          () => editor.chain().focus().setTextAlign('justify').run(),
          editor.isActive({ textAlign: 'justify' }),
        )}
      </span>

      <span className="инструменты__группа">
        {button('Ссылка', 'Вставить или убрать ссылку', setLink, editor.isActive('link'))}
      </span>

      <span className="инструменты__группа">
        {button('Таблица', 'Вставить таблицу 3×3', () =>
          editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
        )}
        {button(
          '+ строка',
          'Добавить строку ниже',
          () => editor.chain().focus().addRowAfter().run(),
          false,
          !editor.can().addRowAfter(),
        )}
        {button(
          '+ столбец',
          'Добавить столбец справа',
          () => editor.chain().focus().addColumnAfter().run(),
          false,
          !editor.can().addColumnAfter(),
        )}
        {button(
          '− строка',
          'Удалить строку',
          () => editor.chain().focus().deleteRow().run(),
          false,
          !editor.can().deleteRow(),
        )}
        {button(
          '− столбец',
          'Удалить столбец',
          () => editor.chain().focus().deleteColumn().run(),
          false,
          !editor.can().deleteColumn(),
        )}
        {button(
          'Убрать таблицу',
          'Удалить таблицу',
          () => editor.chain().focus().deleteTable().run(),
          false,
          !editor.can().deleteTable(),
        )}
      </span>

      <span className="инструменты__группа">
        {button('Очистить', 'Снять форматирование', () =>
          editor.chain().focus().unsetAllMarks().clearNodes().run(),
        )}
        {button(
          '↶',
          'Отменить (Ctrl+Z)',
          () => editor.chain().focus().undo().run(),
          false,
          !editor.can().undo(),
        )}
        {button(
          '↷',
          'Повторить (Ctrl+Y)',
          () => editor.chain().focus().redo().run(),
          false,
          !editor.can().redo(),
        )}
      </span>
    </div>
  );
}
