/** Только базы, которые тестовые сценарии могут создавать и очищать. */
export type TestDatabaseName = 'vydoh_test' | 'vydoh_admin_e2e' | 'vydoh_e2e';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOCAL_PORTS = new Set(['5434', '5432']);

/**
 * Проверяется до создания клиента, миграций и очистки данных.
 * Параметры URL запрещены: pg умеет переопределять ими host и port.
 * Порт должен быть явным, чтобы его не подменяла переменная PGPORT.
 * Адрес с паролем никогда не попадает в текст ошибки.
 */
export function assertSafeTestDatabaseUrl(url: string, databaseName: TestDatabaseName): void {
  const refuse = (): never => {
    throw new Error(
      `Небезопасный адрес тестовой базы: разрешена только ${databaseName} ` +
        'на localhost, 127.0.0.1 или [::1], с явным портом 5434 или 5432, ' +
        'без параметров URL и фрагмента. Подключение не выполнялось.',
    );
  };

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
    parsed.pathname !== `/${databaseName}` ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    refuse();
  }
}
