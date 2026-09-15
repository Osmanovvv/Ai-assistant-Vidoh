import { and, desc, eq } from 'drizzle-orm';
import sanitizeHtml from 'sanitize-html';

import { documents, documentVersions, type DocumentRow } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';

/**
 * Публичные документы продукта (15.09.2026, просьба Никиты): правятся в
 * панели редактором «как Word», отдаются ботом по адресу `/docs/<slug>`.
 *
 * **Список закрыт кодом.** Четыре документа — ровно те, на которые
 * ссылаются бот и оферта: заведи панель пятый, и ссылаться на него было
 * бы нечему. Адреса латиницей — они идут в URL и в настройки сервера.
 *
 * **Отсев разметки — на записи.** Редактор отдаёт HTML; в базу ложится
 * только то, что страница умеет показать и что человек может увидеть:
 * скрипт, обработчик события, скрытие через стиль вырезаются здесь, а
 * показ доверяет базе. Правит документы администратор, и всё же:
 * страницу читают все, и одна забытая вставка из буфера обмена не должна
 * превращать оферту в чужую страницу.
 */
export interface DocumentKind {
  readonly slug: string;
  readonly title: string;
}

export const DOCUMENTS: readonly DocumentKind[] = [
  { slug: 'oferta', title: 'Публичная оферта' },
  { slug: 'politika', title: 'Политика конфиденциальности' },
  { slug: 'soglashenie', title: 'Пользовательское соглашение' },
  { slug: 'soglasie', title: 'Согласие на обработку персональных данных' },
];

/** Мегабайт разметки — оферта на порядок короче; больше — ошибка, не документ. */
export const MAX_DOCUMENT_BYTES = 1_000_000;

export function documentKind(slug: string): DocumentKind | undefined {
  return DOCUMENTS.find((one) => one.slug === slug);
}

/**
 * Что документу можно: заголовки, абзацы, начертание, списки, цитаты,
 * ссылки, таблицы, выравнивание. Стили — только выравнивание: остальное
 * либо ломает страницу, либо прячет текст.
 */
const ALLOWED = {
  allowedTags: [
    'h1',
    'h2',
    'h3',
    'h4',
    'p',
    'br',
    'hr',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'ul',
    'ol',
    'li',
    'blockquote',
    'a',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'colgroup',
    'col',
    'sup',
    'sub',
  ],
  allowedAttributes: {
    a: ['href', 'rel'],
    th: ['colspan', 'rowspan', 'colwidth', 'style'],
    td: ['colspan', 'rowspan', 'colwidth', 'style'],
    col: ['span'],
    h1: ['style'],
    h2: ['style'],
    h3: ['style'],
    h4: ['style'],
    p: ['style'],
    li: ['style'],
  },
  allowedStyles: {
    '*': { 'text-align': [/^(?:left|right|center|justify)$/u] },
  },
  allowedSchemes: ['https', 'mailto', 'tel'],
  // Ссылка со схемой не из списка теряет адрес, а не текст.
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener' }, true),
  },
} as const satisfies sanitizeHtml.IOptions;

export function sanitizeDocument(html: string): string {
  return sanitizeHtml(html, ALLOWED);
}

/** В документе есть слова, а не одна разметка. */
function hasText(html: string): boolean {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).trim().length > 0;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

export interface DocumentSummary extends DocumentKind {
  readonly editionDate: string | null;
  readonly updatedAt: Date | null;
  readonly updatedBy: string | null;
}

/** Все четыре — и те, что ещё не сохранены: панели нужен полный список. */
export async function listDocuments(db: Executor): Promise<readonly DocumentSummary[]> {
  const rows = await db.select().from(documents);
  const bySlug = new Map(rows.map((row) => [row.slug, row]));

  return DOCUMENTS.map((kind) => {
    const row = bySlug.get(kind.slug);
    return {
      ...kind,
      editionDate: row?.editionDate ?? null,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  });
}

export async function documentOf(db: Executor, slug: string): Promise<DocumentRow | undefined> {
  const [row] = await db.select().from(documents).where(eq(documents.slug, slug)).limit(1);
  return row;
}

export type SaveOutcome = { readonly ok: true } | { readonly ok: false; readonly why: string };

export async function saveDocument(
  db: Executor,
  params: {
    readonly slug: string;
    readonly html: string;
    readonly editionDate: string | null;
    readonly by: string;
  },
): Promise<SaveOutcome> {
  const kind = documentKind(params.slug);
  if (kind === undefined) return { ok: false, why: `нет такого документа: ${params.slug}` };

  if (Buffer.byteLength(params.html, 'utf8') > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      why: `документ больше предела (${String(MAX_DOCUMENT_BYTES)} байт): проверь, не вставилось ли лишнее`,
    };
  }

  if (params.editionDate !== null && !DATE_RE.test(params.editionDate)) {
    return { ok: false, why: 'дата редакции — только датой вида 2026-10-01' };
  }

  const html = sanitizeDocument(params.html);
  if (!hasText(html)) return { ok: false, why: 'документ пуст — нечего сохранять' };

  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .insert(documents)
      .values({
        slug: kind.slug,
        title: kind.title,
        html,
        editionDate: params.editionDate,
        updatedAt: now,
        updatedBy: params.by,
      })
      .onConflictDoUpdate({
        target: documents.slug,
        set: { html, editionDate: params.editionDate, updatedAt: now, updatedBy: params.by },
      });

    await tx.insert(documentVersions).values({
      slug: kind.slug,
      html,
      editionDate: params.editionDate,
      savedAt: now,
      savedBy: params.by,
    });
  });

  return { ok: true };
}

export interface VersionSummary {
  readonly id: string;
  readonly savedAt: Date;
  readonly savedBy: string | null;
  readonly editionDate: string | null;
}

/** История — свежая первой. */
export async function versionsOf(db: Executor, slug: string): Promise<readonly VersionSummary[]> {
  return await db
    .select({
      id: documentVersions.id,
      savedAt: documentVersions.savedAt,
      savedBy: documentVersions.savedBy,
      editionDate: documentVersions.editionDate,
    })
    .from(documentVersions)
    .where(eq(documentVersions.slug, slug))
    .orderBy(desc(documentVersions.savedAt));
}

/** Разметка одной версии — только своего документа. */
export async function versionHtml(
  db: Executor,
  slug: string,
  id: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ html: documentVersions.html })
    .from(documentVersions)
    .where(and(eq(documentVersions.slug, slug), eq(documentVersions.id, id)))
    .limit(1);

  return row?.html;
}
