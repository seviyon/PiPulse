// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'packages/web/dist/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      // A handle created after another value that must be able to call it
      // back (e.g. server.ts's `alerts`) is legitimately read in a closure
      // before its one assignment; that isn't a `const` candidate.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }]
    }
  }
);
