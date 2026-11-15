// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    '**/dist/**',
    '**/coverage/**',
    '**/.turbo/**',
    '**/.next/**',
    '**/out/**',
    'python/**',
    '**/spike/public/**',
    '**/.test-assets/**',
    '**/.e2e-site/**',
    '**/e2e/fixtures/**',
  ]),
  js.configs.recommended,
  {
    // Repo scripts run in Node.
    files: ['**/scripts/**/*.mjs', '**/spike/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        window: 'readonly',
        document: 'readonly',
        btoa: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Public API discipline: exported functions declare their return types.
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.test.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  prettier,
]);
