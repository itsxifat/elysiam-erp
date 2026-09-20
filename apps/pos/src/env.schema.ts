import { z } from 'zod';

/**
 * The client configuration contract.
 *
 * It lives apart from the module that reads `import.meta.env` so that
 * vite.config.ts can import it and validate at *build* time. Vite inlines
 * `import.meta.env`, so a browser-side check would only fail after the bad
 * bundle had already shipped.
 *
 * Only `VITE_`-prefixed values reach the browser; nothing secret belongs here.
 */
export const clientEnvSchema = z.object({
  VITE_API_URL: z.string().url(),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;
