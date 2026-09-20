import { base } from '@elysium/config/eslint/base';

export default [
  ...base({ tsconfigRootDir: import.meta.dirname }),
  {
    // These are command-line entry points. Printing is what they are for, and
    // routing them through pino would mean a logger before the config that
    // configures it.
    files: ['src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
];
