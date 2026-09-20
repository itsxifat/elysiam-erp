import { baseEnvShape, createEnv } from '@elysium/config/env';
import { z } from 'zod';

/**
 * Server configuration.
 *
 * Parsed once at startup so a missing or malformed variable stops the process
 * before it can serve a request against the wrong database (architecture §28).
 */
const schema = z.object({
  ...baseEnvShape,

  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().max(65535).default(3000),

  // Required from M01 onward. It is required now so a misconfigured environment
  // fails at boot rather than at the first query.
  DATABASE_URL: z.string().url().startsWith('postgres'),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  cached ??= createEnv('server', schema);
  return cached;
}
