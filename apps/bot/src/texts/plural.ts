/**
 * Число со склонением: «1 дело», «2 дела», «5 дел», «21 дело», «11 дел».
 *
 * Одна на словарь и на представление: счёт дел — цифрой и со склонением,
 * как в образце заказчицы от 16.09.2026 («Записала 6 дел»), и вторая
 * копия правила разошлась бы с первой на «11–14».
 */
export function counted(count: number, forms: readonly [string, string, string]): string {
  const [one, few, many] = forms;
  const tail = count % 100;
  const last = count % 10;
  const noun =
    tail >= 11 && tail <= 14 ? many : last === 1 ? one : last >= 2 && last <= 4 ? few : many;

  return `${String(count)} ${noun}`;
}
