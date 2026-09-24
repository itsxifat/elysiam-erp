import { defineConfig } from 'vitest/config';

import { workspaceAliases } from '@elysium/config/vitest';

const alias = workspaceAliases();

const shared = {
  passWithNoTests: true,
  exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.output/**', '**/e2e/**'],
  /*
   * 30s per test, not vitest's 5s default.
   *
   * Most of this repo's tests are integration tests against real PostgreSQL,
   * and several drive a whole sign-in — password reset, credential post, TOTP
   * enrolment and verification — before they get to the thing they assert. On
   * an idle machine that is well under a second. Under `pnpm verify`, which
   * runs 26 files in parallel and each database-backed suite starts its own
   * Testcontainer, it is not.
   *
   * It bit: four tests in the ledger's period-close suite failed a full verify
   * run with `Test timed out in 5000ms`, at 5006-5032ms each, and passed on
   * the next run and in isolation. That is worse than a failing test. A money
   * suite that fails intermittently teaches everyone to re-run it, and the day
   * it fails for a real reason nobody believes it.
   *
   * The cost of 30s is that a genuine hang takes 30s to surface instead of 5.
   * Assertion failures are unaffected — they fail the moment they are reached.
   */
  testTimeout: 30_000,
} as const;

/*
 * Two projects, split by file extension rather than by folder:
 *   *.test.ts   logic, run in node
 *   *.test.tsx  components, run in happy-dom
 *
 * The split matters: a node-environment test can read files off disk, which a
 * DOM-environment one cannot, and component tests need a document. Mapping it
 * to the extension keeps it obvious which world a test is in.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          ...shared,
          name: 'node',
          environment: 'node',
          include: [
            'packages/**/*.test.{ts,js,mjs}',
            'apps/**/*.test.{ts,js,mjs}',
            'scripts/**/*.test.mjs',
          ],
        },
      },
      {
        resolve: { alias },
        test: {
          ...shared,
          name: 'dom',
          environment: 'happy-dom',
          include: ['packages/**/*.test.tsx', 'apps/**/*.test.tsx'],
        },
      },
    ],
  },
});
