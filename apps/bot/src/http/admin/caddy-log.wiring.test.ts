import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Имя из поиска панели не уходит в журнал Caddy (§16, ревизия этапов 1–2).
 *
 * Людей панель искала запросом `GET /admin/api/people?q=<имя>`, а Caddy
 * пишет `request.uri` целиком, со строкой запроса. Имя человека
 * оказывалось в журнале прокси — там, куда не достаёт ни маска логгера
 * бота (Caddy пишет раньше него и в другое место), ни удаление данных по
 * §16. Проверено вживую на `caddy:2-alpine` v2.11.4 11.09.2026: в строке
 * журнала доступа лежало `q=%D0%A1%D0%B8%D0%B4%D0%BE%D1%80%D0%BE%D0%B2…`
 * — «Сидоров» в URL-кодировке.
 *
 * Починка в два слоя, и стражей здесь столько же.
 *
 * 1. **Имя едет в теле запроса, а не в адресе.** Панель ищет POST-ом
 *    (`peoplePage` в `apps/admin/src/api.ts`), бот читает `q` из тела.
 *    Это главный слой: тела запроса Caddy не пишет никогда — ни в журнал
 *    доступа, ни в журнал ошибок.
 * 2. **`handle /admin*` помечен `log_skip`** в обоих вариантах
 *    конфигурации — боевой выбирает один из них по `CADDYFILE` в `.env`,
 *    и починенный только в одном — это починенный наполовину. Доступ к
 *    персональным данным панель журналирует сама, в базу, как велит §16;
 *    второй след — с нашими кодами людей в путях карточек — не нужен.
 *
 * **Почему одного `log_skip` мало, найдено той же живой проверкой.** Он
 * глушит журнал доступа, но не журнал ошибок прокси: пока бот лежит
 * (каждая выкладка, каждое падение), Caddy отвечает панели 502 и пишет
 * строку уровня error с тем же `request.uri`. С `log_skip` и старым
 * GET-поиском имя всё равно уезжало в журнал — ровно в те минуты, когда в
 * панель заглядывают чаще всего. Поэтому первый слой — не «заодно».
 *
 * **Чего этот страж не умеет, сказано вслух.** Он читает тексты
 * конфигурации и панели, а не поднимает Caddy и не исполняет `api.ts`:
 * поведенческая проверка первого потребовала бы двоичный файл Caddy,
 * которого в CI нет, а `api.ts` трогает `window` и без DOM в типах бота
 * не собирается. Живой прогон Caddy сделан руками в docker и записан в
 * коммит; половина бота проверяется по-настоящему в
 * `people-route.int.test.ts`, половина панели — в браузере,
 * `tests/admin/people.spec.ts`. Здесь стоит напоминание тому, кто придёт
 * править блок панели или функцию поиска.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../..');

const CADDYFILES = ['ops/caddy/Caddyfile', 'ops/caddy/Caddyfile.selfsigned'] as const;

/** Текст без комментариев `#`: ловушку здесь принято описывать словами. */
function code(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/u, ''))
    .join('\n');
}

/** Текст TypeScript без комментариев: по той же причине. */
function codeTs(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|\s)\/\/.*$/gmu, '');
}

/**
 * Тело блока `handle <путь> { … }` — по скобкам, а не по отступам.
 *
 * Отступы в Caddyfile ничего не значат, и страж по ним поверил бы блоку,
 * который ушёл на уровень выше.
 */
function handleBlock(config: string, path: string): string | undefined {
  const open = config.indexOf(`handle ${path} {`);

  if (open === -1) return undefined;

  return braced(config, open);
}

/** Текст от `from` до закрытия первой открывшейся после него фигурной скобки. */
function braced(text: string, from: number): string | undefined {
  let depth = 0;

  for (let at = text.indexOf('{', from); at < text.length; at += 1) {
    if (text[at] === '{') depth += 1;

    if (text[at] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(from, at + 1);
    }
  }

  return undefined;
}

/** Описание сервиса compose: строки между `  имя:` и следующим ключом того же уровня. */
function service(compose: string, name: string): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);

  if (start === -1) throw new Error(`в docker-compose.prod.yml нет сервиса ${name}`);

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {0,2}\S/u.test(line));

  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** Предел журнала контейнера — как записан, без догадок об умолчаниях Docker. */
function logLimit(block: string): { readonly size?: string; readonly files?: string } {
  const size = /max-size:\s*'?([^'\s]+)'?/u.exec(block)?.[1];
  const files = /max-file:\s*'?([^'\s]+)'?/u.exec(block)?.[1];

  return {
    ...(size === undefined ? {} : { size }),
    ...(files === undefined ? {} : { files }),
  };
}

describe('панель ищет людей POST-ом: имени в адресе запроса нет', () => {
  it('peoplePage шлёт имя в теле под ключом q, а адрес — без строки запроса', async () => {
    const api = codeTs(await readFile(resolve(root, 'apps/admin/src/api.ts'), 'utf8'));
    const head = api.indexOf('export function peoplePage(');

    expect(head, 'в api.ts нет peoplePage: поиск людей переехал или переименован').not.toBe(-1);

    // Тело — от возвращаемого типа, а не от первой скобки: первая
    // открывает тип параметров, и страж прочёл бы его вместо тела.
    const body = braced(api, api.indexOf('): Promise<PeoplePage> {', head));

    expect(body, 'у peoplePage не найдено тело').toBeDefined();

    expect(body, 'поиск людей ушёл со своего пути').toMatch(/\bpost(?:<[^>]*>)?\(\s*'\/people'/u);
    // Тот же ключ читает бот из тела: `people-route.int.test.ts` шлёт
    // `q` и ждёт найденного. Разойдутся — панель будет искать впустую.
    expect(body, 'имя не попадает в тело под ключом q').toMatch(/\bq:\s*params\.query\b/u);

    // Строка запроса живёт в строковых литералах; `?` в коде — это ещё и
    // тернарный оператор, по нему страж краснел бы на самом себе.
    const literals = body?.match(/'[^']*'|`[^`]*`/gu) ?? [];

    expect(
      literals.filter((literal) => /\?|q=/u.test(literal)),
      'имя из поиска снова в строке запроса: Caddy запишет его в журнал',
    ).toEqual([]);
    expect(body, 'имя кодируется для адреса — значит, едет адресом').not.toContain(
      'encodeURIComponent',
    );
  });
});

describe.each(CADDYFILES)('%s: панель не пишется в журнал доступа', (file) => {
  it('журнал доступа включён — иначе стеречь нечего', async () => {
    // Пропади `log` — вся проверка стала бы обрядом. Пусть тогда
    // краснеет она, а не человек через полгода.
    const config = code(await readFile(resolve(root, file), 'utf8'));

    expect(config).toMatch(/^\s*log\s*\{/mu);
  });

  it('блок панели помечен log_skip', async () => {
    const config = code(await readFile(resolve(root, file), 'utf8'));
    const admin = handleBlock(config, '/admin*');

    expect(admin, 'блока handle /admin* нет: панель либо закрыта, либо уехала').toBeDefined();
    // Тот самый блок, а не однофамилец: панель отдаёт бот.
    expect(admin).toContain('reverse_proxy bot:3000');

    expect(
      admin,
      'панель пишется в журнал доступа Caddy: коды людей из путей карточек уйдут туда',
    ).toMatch(/^\s*log_skip\s*$/mu);
  });
});

describe('журнал контейнера caddy', () => {
  it('ограничен тем же пределом, что у бота', async () => {
    const compose = code(await readFile(resolve(root, 'docker-compose.prod.yml'), 'utf8'));
    const caddy = service(compose, 'caddy');
    const bot = logLimit(service(compose, 'bot'));

    // Предел бота — образец: пропади он, сравнивать было бы не с чем.
    expect(bot.size).toBeDefined();
    expect(bot.files).toBeDefined();

    expect(caddy, 'у caddy нет блока logging: журнал прокси растёт без предела').toMatch(
      /^ {4}logging:/mu,
    );
    expect(logLimit(caddy)).toEqual(bot);
  });
});
