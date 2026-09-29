import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The console, served for the real-stack Playwright run (M11 checks 1 and 4).
 *
 * The console's own `vite.config.ts` with one difference: `./routes/router.js`, as
 * `console-app.tsx` imports it, resolves to `stack-router.tsx`, which is the real route tree
 * plus `ordersRoutes()` — exactly the lines M11's INTEGRATION section adds to `router.tsx`,
 * which this milestone may not edit itself. Once the integrator has added them,
 * `stack-router.tsx` sees the orders routes already registered and returns the real router
 * untouched, so this alias becomes a no-op rather than a second route table.
 *
 * Everything else — the entry, the shell, the session, the login, the screens — is the
 * console as it ships.
 */
const consoleRoot = path.resolve(import.meta.dirname, '../..');

export default defineConfig({
  root: consoleRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(consoleRoot, 'src') },
      {
        find: /^\.\/routes\/router\.js$/,
        replacement: path.resolve(import.meta.dirname, 'stack-router.tsx'),
      },
    ],
  },
  server: { strictPort: true },
});
