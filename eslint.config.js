import { base, ignores } from '@elysium/config/eslint/base';

// Root-level files only: scripts/ and the config files beside them. Each app and
// package lints itself with its own preset.
export default [
  {
    // A script's `.d.mts` is checked by the TypeScript project that imports it (the
    // console's e2e setup imports `preview-stack.mjs`); no root project contains it.
    ignores: [...ignores, 'apps/**', 'packages/**', 'docs/**', 'infra/**', 'scripts/**/*.d.mts'],
  },
  ...base({ tsconfigRootDir: import.meta.dirname }),
];
