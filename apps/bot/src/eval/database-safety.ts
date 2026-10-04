const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOCAL_PORTS = new Set(['5434', '5432']);

/**
 * Прогоны качества пишут расход и пересоздают пользователей стенда.
 * Им разрешена только отдельная локальная база из рантбука. Проверка
 * вызывается до getDb(), без обхода флагом и без адреса с паролем в ошибке.
 * Параметры URL запрещены: pg может переопределять ими подключение.
 */
export function assertSafeEvalDatabaseUrl(url: string | undefined): void {
  const refuse = (): never => {
    throw new Error(
      'Небезопасный адрес базы прогона качества: разрешена только vydoh_eval ' +
        'на localhost, 127.0.0.1 или [::1], с явным портом 5434 или 5432, ' +
        'без параметров URL и фрагмента. Подключение не выполнялось.',
    );
  };

  if (url === undefined) return refuse();

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse();
  }

  if (
    url !== url.trim() ||
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
    !LOCAL_HOSTS.has(parsed.hostname.toLowerCase()) ||
    !LOCAL_PORTS.has(parsed.port) ||
    parsed.pathname !== '/vydoh_eval' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    refuse();
  }
}
