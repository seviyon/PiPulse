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
      '.superpowers/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  {
    // Plain Node scripts outside the TypeScript packages (the Docker health check).
    files: ['packaging/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', fetch: 'readonly', AbortSignal: 'readonly' }
    }
  }
);
