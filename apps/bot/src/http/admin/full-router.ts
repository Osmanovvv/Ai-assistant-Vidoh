import { join } from 'node:path';

import { createAdminRouter, type AdminAuthConfig, type AdminDeps } from './index.js';
import type { SettingsRegistry } from '../../modules/settings/settings.repo.js';
import { TextsRegistry } from '../../texts/registry.js';
import type { Database } from '../../infra/db.js';

/**
 * Роутер панели **со всеми** необязательными зависимостями (ревизия 4).
 *
 * **Зачем отдельный сборщик.** Разделы объявляются под условием: расходы
 * — при базе, промпты — при папке набора, рассылка — при очереди.
 * Собранный не полностью роутер про эти пути не знает, и проверка, что
 * у каждого пути принято решение о персональных данных, честно проверит
 * всё, кроме забытого. Это уже случалось трижды — на задачах 4.7, 4.8 и
 * 4.10, — и каждый раз находилось руками.
 *
 * Стеречь полноту стали числом путей, но сверка охраняла **свой**
 * роутер, а решения о персональных данных читались с другого, собранного
 * в другом файле по другому списку. Два списка зависимостей на один
 * вопрос однажды разъедутся — и разъедутся молча.
 *
 * Теперь список один и живёт здесь. Новая необязательная зависимость
 * добавляется в одном месте, и её сразу видят все три проверки.
 */
export function fullAdminRouter(params: {
  readonly config: AdminAuthConfig;
  /** Настоящая база — там, где проверка ходит к ней; заглушка — где нет. */
  readonly db: Database;
  readonly settings: SettingsRegistry;
  /** Чем подменить необязательные зависимости, если проверке всё равно. */
  readonly stub?: Partial<AdminDeps> | undefined;
}): ReturnType<typeof createAdminRouter> {
  const stub = params.stub ?? {};

  return createAdminRouter({
    config: params.config,
    db: params.db,
    settings: params.settings,
    // Реестр реплик: без него правка из панели ждала бы окна, и
    // «без выкладки» превратилось бы в «через минуту».
    texts: new TextsRegistry({ db: params.db }),
    staticDir: join(import.meta.dirname, '../../../../admin/dist'),
    evalDir: join(import.meta.dirname, 'нет-такой-папки'),
    evalRunner: { state: () => ({ kind: 'idle' }), start: () => false },
    enqueueBroadcast: async () => {
      await Promise.resolve();
    },
    enqueueUser: async () => {
      await Promise.resolve();
    },
    promptRegistry: { forget: () => undefined },
    ...stub,
  });
}
