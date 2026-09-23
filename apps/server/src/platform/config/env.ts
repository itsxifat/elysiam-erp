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

  /**
   * The URL browsers actually reach this API on.
   *
   * Not derivable from `API_HOST`, which is a bind address and defaults to
   * `0.0.0.0`: Better Auth used to build its `baseURL` from it, so in production
   * it believed it lived at `http://0.0.0.0:3000` while issuing Secure cookies
   * scoped to the real domain. It worked only because the trusted-origin list
   * carried the truth separately.
   */
  API_PUBLIC_URL: z.string().url(),

  /** Signs sessions and tokens. 32 bytes minimum, from the secret manager (§25). */
  AUTH_SECRET: z.string().min(32),

  /**
   * How many reverse proxies sit in front of this process.
   *
   * It decides which `x-forwarded-for` entry is the real client, and getting it
   * wrong is not cosmetic: too low and every client collapses into one bucket,
   * which turns the per-IP rate limit into a global lockout; too high and a
   * client can forge its own address by sending its own header, which turns the
   * limit off. 0 means "no proxy, trust the socket".
   */
  TRUSTED_PROXY_COUNT: z.coerce.number().int().min(0).max(10).default(0),

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
