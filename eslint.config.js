import { base, ignores } from '@elysium/config/eslint/base';

// Root-level files only: scripts/ and the config files beside them. Each app and
// package lints itself with its own preset.
export default [
  {
    ignores: [...ignores, 'apps/**', 'packages/**', 'docs/**', 'infra/**'],
  },
  ...base({ tsconfigRootDir: import.meta.dirname }),
];
