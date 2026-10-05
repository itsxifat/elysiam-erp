import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The owner console (D-480, D-491). Served by nginx on the mother's own origin, beside
 * the API, so every call is same-origin and nothing here names a server. In development
 * the Vite server proxies `/api` and `/v1` to the mother API on 3300, which keeps the
 * same shape: one origin, no CORS.
 */
const api = process.env.MOTHER_API_ORIGIN ?? 'http://127.0.0.1:3300';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5190,
    strictPort: true,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/v1': { target: api, changeOrigin: false },
    },
  },
  preview: {
    port: 5190,
    strictPort: true,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/v1': { target: api, changeOrigin: false },
    },
  },
});
