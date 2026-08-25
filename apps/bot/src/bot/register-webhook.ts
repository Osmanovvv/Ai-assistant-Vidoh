import { InputFile, type Api } from 'grammy';

import { webhookUrl, type Env } from '../config/env.js';
import { ALLOWED_UPDATES } from './bot.js';

/**
 * Регистрация вебхука в одном месте (задачи 1.7 и 1.23).
 *
 * Раньше набор параметров дублировался в точке входа и в отдельном
 * скрипте. Разойтись им нельзя: если скрипт зарегистрирует вебхук без
 * секрета или с другим списком апдейтов, бот молча перестанет получать
 * часть событий, и понять это будет непросто.
 */
export async function registerWebhook(api: Api, env: Env): Promise<string> {
  const url = webhookUrl(env);

  await api.setWebhook(url, {
    secret_token: env.BOT_WEBHOOK_SECRET,
    // §9 ТЗ запрещает терять сообщения, в том числе накопившиеся.
    drop_pending_updates: false,
    allowed_updates: [...ALLOWED_UPDATES],
    // Самоподписанный сертификат, когда вебхук стоит на голом IP:
    // Telegram проверяет цепочку по присланному файлу.
    ...(env.WEBHOOK_CERTIFICATE_PATH === undefined
      ? {}
      : { certificate: new InputFile(env.WEBHOOK_CERTIFICATE_PATH) }),
  });

  return url;
}
