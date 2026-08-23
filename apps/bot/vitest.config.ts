import { defineConfig } from 'vitest/config';

/**
 * Два набора тестов.
 *
 * unit — быстрые, без внешних зависимостей, гоняются постоянно.
 * integration — против живого Postgres. Вынесены отдельно намеренно:
 * тест, который «пропускается, если базы нет», молча зеленеет и создаёт
 * ложное чувство покрытия.
 */
export default defineConfig({
  test: {
    // Пустой прогон — это ошибка, а не успех: значит тесты не нашлись
    // из-за опечатки в маске файлов, и зелёный CI ничего не доказывает.
    passWithNoTests: false,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.int.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/**/*.int.test.ts'],
          setupFiles: ['src/test/setup-int.ts'],
          // Тесты делят одну базу и чистят её перед каждым тестом,
          // поэтому файлы не должны идти параллельно.
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/scripts/**', 'src/test/**'],
    },
  },
});
