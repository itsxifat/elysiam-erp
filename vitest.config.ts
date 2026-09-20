import { defineConfig } from 'vitest/config';

import { workspaceAliases } from '@elysium/config/vitest';

const alias = workspaceAliases();

const shared = {
  passWithNoTests: true,
  exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.output/**', '**/e2e/**'],
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
