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

  /**
   * The parent domain (architecture §6, §16).
   *
   * Session and CSRF cookies are scoped here so the console keeps its session
   * inside the Chatwoot iframe, and branded login reads the org label off the
   * subdomain (D-035).
   */
  APP_DOMAIN: z.string().min(1),

  /** Signs sessions and tokens. 32 bytes minimum, from the secret manager (§25). */
  AUTH_SECRET: z.string().min(32),

  /** Comma-separated. Anything not listed is refused by CSRF and by Better Auth. */
  TRUSTED_ORIGINS: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  cached ??= createEnv('server', schema);
  return cached;
}
