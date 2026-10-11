// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'packages/web/dist/**',
      'out/**',
      '.superpowers/**',
      'e2e/test-results/**',
      'e2e/playwright-report/**',
      '**/.stryker-tmp/**',
      '**/reports/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts (no TypeScript, no bundler): Node's globals.
    files: ['scripts/**/*.mjs', 'packages/*/test/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly'
      }
    }
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  }
);
