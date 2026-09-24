import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { elysiumPlugin } from './rules/index.js';

/** Files no preset should ever lint. */
export const ignores = [
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.output/**',
  '**/.wxt/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/playwright-report/**',
  '**/test-results/**',
  '**/node_modules/**',
];

/** Files that exist to configure the toolchain, not to ship. */
const TOOLING_FILES = [
  '**/*.config.{js,mjs,cjs,ts,mts}',
  '**/*.cjs',
  'scripts/**/*.mjs',
  // Build and verify helpers run before or outside any tsconfig project.
  '**/*.mjs',
  'eslint.config.js',
  'prettier.config.js',
];

/**
 * Base preset: strict, type-aware TypeScript.
 *
 * Type-aware rules are the reason TypeScript is pinned to 6.x rather than 7.x
 * (D-039). `no-floating-promises` alone is worth it: an un-awaited `ledger.post()`
 * inside a transaction is a silently missing journal.
 *
 * @param {{ tsconfigRootDir: string }} options
 */
export function base({ tsconfigRootDir }) {
  return tseslint.config(
    { ignores },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir },
        globals: { ...globals.es2023 },
      },
      plugins: { elysium: elysiumPlugin },
      rules: {
        'elysium/no-emoji': 'error',
        // Invariant 1. Switched off only in packages/domain/src/money.
        'elysium/no-float-money': 'error',

        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': 'error',
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
        ],
        '@typescript-eslint/switch-exhaustiveness-check': 'error',

        eqeqeq: ['error', 'always', { null: 'ignore' }],
        'no-console': ['error', { allow: ['warn', 'error'] }],
        'no-param-reassign': 'error',
        'prefer-const': 'error',
      },
    },
    // Config files and scripts run before anything is built, so they are not in
    // any tsconfig project and type-aware rules cannot parse them. These stay
    // two separate config objects: spreading disableTypeChecked and then giving
    // the same object its own `languageOptions` would overwrite the very
    // parserOptions that disable the project service.
    {
      files: TOOLING_FILES,
      ...tseslint.configs.disableTypeChecked,
    },
    {
      files: TOOLING_FILES,
      languageOptions: { globals: { ...globals.node } },
      // Tooling prints timings and ratios, never money.
      rules: { 'no-console': 'off', 'elysium/no-float-money': 'off' },
    },
    prettier,
  );
}
