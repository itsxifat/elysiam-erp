import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

import { createEnv } from '@elysium/config/env';
import { pagesHeaders } from '@elysium/config/pages-headers';

import { clientEnvSchema } from './src/env.schema.js';

export default defineConfig(({ mode }) => {
  // Fail the build, not the browser. Vite inlines import.meta.env, so a
  // check that only runs in the bundle would ship the broken config first.
  const raw = loadEnv(mode, import.meta.dirname, 'VITE_');
  const env = createEnv('pos', clientEnvSchema, raw);

  return {
    plugins: [
      react(),
      tailwindcss(),
      // `dist/_headers` for Cloudflare Pages, and the same headers under `vite preview`
      // (M14b, D-347). `VITE_CSP_CONNECT_SRC` adds the R2 upload endpoint in production.
      pagesHeaders({ apiUrl: env.VITE_API_URL, extraConnectSrc: raw.VITE_CSP_CONNECT_SRC }),
    ],
    // Matches the tsconfig path alias; shadcn/ui components generated in
    // M05 import through it.
    resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
    server: { port: 5175, strictPort: true },
    build: {
      rollupOptions: {
        // Two entries: the app, and the service worker. A worker's scope is the
        // directory it is served from, so `sw.js` must sit at the root, unhashed,
        // rather than under `/assets/` with the bundles it caches.
        input: {
          main: path.resolve(import.meta.dirname, 'index.html'),
          sw: path.resolve(import.meta.dirname, 'src/sw.ts'),
        },
        output: {
          entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
        },
      },
    },
    // Production sourcemaps come back in M14b, wired to Sentry upload. Enabling
    // them now only adds a Tailwind sourcemap warning to every CI run.
  };
});
