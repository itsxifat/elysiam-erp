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
  const env = createEnv('portal', clientEnvSchema, raw);

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
    server: { port: 5174, strictPort: true },
    // No source maps in a build that ships: a map carries the original source, package names
    // and comments included, to anyone with the browser's tools (D-472). Sentry, when it
    // comes, uploads hidden maps that are not published. `check:white-label` fails on one.
    build: { sourcemap: false },
  };
});
