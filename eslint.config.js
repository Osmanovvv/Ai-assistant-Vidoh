import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '.data/**', 'docs/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // §4.1 ТЗ: никаких any в доменных типах — запрет явный, а не по умолчанию.
      '@typescript-eslint/no-explicit-any': 'error',

      // Забытый await в конвейере обработки означает потерянное сообщение,
      // а §9 ТЗ этого не допускает.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],

      // Неиспользуемое с префиксом _ разрешено: так помечают намеренно
      // проигнорированные аргументы обработчиков.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'object-shorthand': 'error',
      'prefer-const': 'error',
    },
  },

  {
    // Конфигурационные файлы на JavaScript вне типизированного проекта.
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  {
    // В тестах допустимы конструкции, неуместные в рабочем коде.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
);
