import { base } from '@elysium/config/eslint/base';

export default [
  ...base({ tsconfigRootDir: import.meta.dirname }),
  {
    // The one place money is parsed and rounded (invariant 1). Everything
    // else in the repository is held to `elysium/no-float-money`.
    files: ['src/money/**'],
    rules: { 'elysium/no-float-money': 'off' },
  },
];
