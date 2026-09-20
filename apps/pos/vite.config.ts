import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5175, strictPort: true },
  // Production sourcemaps come back in M14b, wired to Sentry upload. Enabling
  // them now only adds a Tailwind sourcemap warning to every CI run.
});
