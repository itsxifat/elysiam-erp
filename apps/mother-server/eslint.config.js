import { node } from '@elysium/config/eslint/node';

export default [
  ...node({ tsconfigRootDir: import.meta.dirname }),
  {
    // The command-line entry point prints what the operator asked for (a one-time link,
    // a public key); routing that through pino would bury it in a log line.
    files: ['src/main.cli.ts'],
    rules: { 'no-console': 'off' },
  },
];
