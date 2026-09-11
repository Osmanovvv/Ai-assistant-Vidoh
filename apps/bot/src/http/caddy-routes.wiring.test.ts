import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ROBOKASSA_RESULT_PATH } from './billing.js';

/**
 * Каждый путь, на который бот ждёт гостей снаружи, открыт в прокси.
 *
 * Ревизия этапов 1–2 (11.09.2026). Приём уведомлений Робокассы был
 * написан, покрыт тестами и **недостижим**: Caddy наружу открывал только
 * вебхук, панель и robots, а всё остальное отвечал 404. Оплата прошла бы
 * у провайдера, бот о ней не узнал бы, подписка не включилась бы —
 * человек заплатил впустую, и никто не понял бы почему: у бота ни строки
 * в журнале, у Робокассы — «ваш сервер ответил 404».
 *
 * Страж читает оба варианта конфигурации (с самоподписанным сертификатом
 * и на домене): они расходились друг с другом уже дважды, и «поправили в
 * одном» — самый частый способ это повторить. Путь берётся из той же
 * константы, что и у самого приёмника, поэтому переименование в коде без
 * правки прокси тоже покраснеет.
 *
 * Поведенческой проверки здесь быть не может — она потребовала бы
 * поднятого Caddy. Комментарии перед разбором снимаются: иначе страж
 * поймал бы собственную цитату пути в пояснении.
 */

const here = dirname(fileURLToPath(import.meta.url));
const caddy = resolve(here, '../../../../ops/caddy');

/** Пути, которые бот отдаёт наружу; всё остальное прокси обязан прятать. */
const OPEN_PATHS = ['/telegram/webhook', '/admin*', '/robots.txt', ROBOKASSA_RESULT_PATH];

function routesOf(file: string): string {
  return readFileSync(resolve(caddy, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

describe.each(['Caddyfile', 'Caddyfile.selfsigned'])('прокси %s', (file) => {
  const config = routesOf(file);

  it.each(OPEN_PATHS)('открывает %s и ведёт его к боту', (path) => {
    const block = new RegExp(
      String.raw`handle ${path.replace('*', String.raw`\*`)} \{\s*reverse_proxy bot:3000\s*\}`,
      'u',
    );

    expect(config, `${path} снаружи недостижим`).toMatch(block);
  });

  it('всё остальное прячет', () => {
    // Без этого блока прокси отдавал бы наружу и /health, и всё, что
    // появится в боте потом, — а «открыто по умолчанию» тут никто не решал.
    expect(config).toMatch(/handle \{\s*respond 404\s*\}/u);
  });
});
