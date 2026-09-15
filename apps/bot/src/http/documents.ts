import { Router, type Request, type Response } from 'express';

import type { Executor } from '../infra/db.js';
import {
  DOCUMENTS,
  documentKind,
  documentOf,
  listDocuments,
} from '../modules/documents/documents.service.js';

/**
 * Публичные страницы документов: `/docs` — список, `/docs/<slug>` —
 * документ (оферта, политика, соглашение, согласие).
 *
 * Отдаёт бот, а не отдельный сайт: документы правятся в панели и лежат в
 * базе, и ссылки из бота (`PRIVACY_POLICY_URL`, `OFFER_URL`,
 * `CONSENT_URL`) ведут сюда же. Страница — один HTML без скриптов и
 * внешних ресурсов: ей нечего грузить, и её нечем сломать.
 *
 * Разметка документа вставляется как есть: отсев сделан на записи
 * (`sanitizeDocument`), показ доверяет базе. Название и дата
 * экранируются — они приходят из кода и из панели, но правило одно.
 */
export const DOCUMENTS_PATH = '/docs';

export function documentsRouter(deps: { readonly db: Executor }): Router {
  const router = Router();

  router.get(DOCUMENTS_PATH, (_req: Request, res: Response) => {
    void listDocuments(deps.db).then(
      (list) => {
        const items = list
          .filter((one) => one.updatedAt !== null)
          .map(
            (one) =>
              `<li><a href="${DOCUMENTS_PATH}/${one.slug}">${escapeHtml(one.title)}</a>${
                one.editionDate === null
                  ? ''
                  : ` — редакция от ${escapeHtml(dateText(one.editionDate))}`
              }</li>`,
          )
          .join('');

        res
          .status(200)
          .type('html')
          .set('Cache-Control', 'no-cache')
          .send(
            page({
              title: 'Документы ВЫДОХ',
              body:
                items === ''
                  ? '<p>Документы ещё не опубликованы.</p>'
                  : `<ul class="docs">${items}</ul>`,
            }),
          );
      },
      () => {
        res
          .status(500)
          .type('html')
          .send(page({ title: 'Документы', body: '<p>Не удалось открыть.</p>' }));
      },
    );
  });

  router.get(`${DOCUMENTS_PATH}/:slug`, (req: Request, res: Response) => {
    const slug = String(req.params['slug'] ?? '');
    const kind = documentKind(slug);

    if (kind === undefined) {
      res
        .status(404)
        .type('html')
        .send(page({ title: 'Нет такого документа', body: notFound() }));
      return;
    }

    void documentOf(deps.db, slug).then(
      (row) => {
        if (row === undefined) {
          res
            .status(404)
            .type('html')
            .send(page({ title: kind.title, body: notFound() }));
          return;
        }

        const edition =
          row.editionDate === null
            ? ''
            : `<p class="edition">Редакция от ${escapeHtml(dateText(row.editionDate))}</p>`;

        // Браузер обязан перепроверять: после «Сохранить» ссылка
        // «открыть страницу» должна показать новый текст сразу, а не
        // через минуту. Неизменившееся отдаётся ответом 304 по ETag.
        res
          .status(200)
          .type('html')
          .set('Cache-Control', 'no-cache')
          .send(
            page({
              title: row.title,
              body: `<article>${edition}${row.html}</article>${footer(slug)}`,
            }),
          );
      },
      () => {
        res
          .status(500)
          .type('html')
          .send(page({ title: kind.title, body: '<p>Не удалось открыть.</p>' }));
      },
    );
  });

  return router;
}

function notFound(): string {
  return `<p>Такого документа нет. <a href="${DOCUMENTS_PATH}">Все документы</a>.</p>`;
}

function footer(current: string): string {
  const links = DOCUMENTS.filter((one) => one.slug !== current)
    .map((one) => `<a href="${DOCUMENTS_PATH}/${one.slug}">${escapeHtml(one.title)}</a>`)
    .join(' · ');

  return `<footer><p>Другие документы: ${links}</p></footer>`;
}

/** «2026-10-01» → «1 октября 2026». */
export function dateText(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return iso;

  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function page(params: { readonly title: string; readonly body: string }): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(params.title)} — ВЫДОХ</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f6f5f2; color: #1c1b19; font: 17px/1.6 Georgia, "Times New Roman", serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
  header h1 { font-size: 28px; line-height: 1.25; margin: 0 0 8px; }
  .edition { color: #6b6862; font-size: 15px; margin: 0 0 24px; }
  article { background: #fff; padding: 32px 36px; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  article h1 { font-size: 24px; margin: 24px 0 12px; }
  article h2 { font-size: 20px; margin: 24px 0 10px; }
  article h3 { font-size: 18px; margin: 20px 0 8px; }
  article h4 { font-size: 17px; margin: 16px 0 6px; }
  article p, article li { margin: 0 0 10px; }
  article blockquote { margin: 12px 0; padding: 4px 16px; border-left: 3px solid #d9d6cf; color: #4a4843; }
  article table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 15px; }
  article th, article td { border: 1px solid #d9d6cf; padding: 6px 8px; vertical-align: top; text-align: left; }
  article th { background: #f1efea; }
  article a { color: #1f4e79; }
  article hr { border: 0; border-top: 1px solid #d9d6cf; margin: 20px 0; }
  ul.docs { padding-left: 20px; }
  footer { margin-top: 28px; color: #6b6862; font-size: 14px; }
  footer a { color: #1f4e79; }
  @media (max-width: 600px) { article { padding: 20px 16px; } body { font-size: 16px; } }
</style>
</head>
<body>
<main>
<header><h1>${escapeHtml(params.title)}</h1></header>
${params.body}
</main>
</body>
</html>
`;
}
