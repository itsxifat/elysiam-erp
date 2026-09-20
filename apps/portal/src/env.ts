import { createEnv } from '@elysium/config/env';

import { clientEnvSchema } from './env.schema.js';

/**
 * Typed access to the values Vite inlined at build time. vite.config.ts has
 * already rejected anything invalid, so this cannot fail in a shipped bundle.
 */
export const env = createEnv(
  'portal',
  clientEnvSchema,
  import.meta.env as unknown as Record<string, string | undefined>,
);
