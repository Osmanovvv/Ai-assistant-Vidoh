import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Хвост разговора подключён в боевой сборке везде, где нужен (план docs/26).
 *
 * Хранилище необязательно у всех, кто его принимает, — так работают
 * проверки. Цена забытой строки в `index.ts`: функция написана, покрыта
 * тестами и недостижима (задача 3.82). Здесь три места, где забыть
 * опаснее всего: перехват реплик бота, стирание по `/delete_my_data` и
 * стирание после 24 месяцев тишины. Конвейер сторожит `dump.wiring.test.ts`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../../index.ts'), 'utf8');

/** Текст вызова от имени до закрывающей скобки на своём уровне отступа. */
function callOf(name: string, closing: string): string {
  const start = source.indexOf(name);
  expect(start, `${name} в запуске не найден`).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf(closing, start));
}

describe('хвост разговора в боевой сборке', () => {
  it('одно хранилище на процесс', () => {
    expect(source).toMatch(/const dialog = redisDialogStore\(getRedis\(\)\);/u);
  });

  it('бот получает его — реплики бота попадают в хвост', () => {
    expect(callOf('createBot(env.BOT_TOKEN', ');')).toMatch(/\bdialog\b/u);
  });

  it('/delete_my_data стирает хвост', () => {
    expect(callOf('registerPrivacyHandlers(bot, {', '\n  });')).toMatch(/^\s+dialog,$/mu);
  });

  it('удаление после 24 месяцев тишины стирает хвост', () => {
    expect(callOf('startInactivityLoop({', '\n      })')).toMatch(/^\s+dialog,$/mu);
  });

  it('модели хвост показывается только по DIALOG_CONTEXT=on', () => {
    expect(source).toContain("useDialog: env.DIALOG_CONTEXT === 'on'");
  });
});

describe('служебные сообщения идут мимо разговора (выкладка 24.09.2026)', () => {
  /**
   * Первая проверка на бою выключенным: после выгрузки последними
   * «репликами бота» в хвосте оказались правки закреплённых сводок веток
   * — списки дел по сферам на 550 и 625 знаков. Модель видела бы список
   * как последний ответ, а страж, который смотрит на последнюю реплику
   * бота, молчал бы. Сводки, оповещения мониторинга (он пишет в личный
   * чат) и рассылки — служебное, у них свой канал без перехвата.
   */
  it('тихий канал один на процесс', () => {
    expect(source).toMatch(/const quietApi = createQuietApi\(env\.BOT_TOKEN, \{/u);
  });

  it('сводки веток — через тихий канал', () => {
    expect(source).toContain('createTopicGateway(quietApi)');
    expect(source).not.toContain('createTopicGateway(bot.api)');
  });

  it('оповещения мониторинга — через тихий канал', () => {
    expect(source).toContain('createAlertSink(quietApi, env.MONITORING_CHAT_ID)');
  });

  it('массовые рассылки — через тихий канал', () => {
    expect(callOf('const broadcastSender: BroadcastSender = {', '\n  };')).toContain(
      'quietApi.sendMessage(',
    );
  });
});
