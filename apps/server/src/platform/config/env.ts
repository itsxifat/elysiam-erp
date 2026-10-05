import { baseEnvShape, createEnv } from '@elysium/config/env';
import { BRAND_SLUG_PATTERN } from '@elysium/domain/iam';
import { z } from 'zod';

/** An optional value where an empty string, as compose writes an unset `${VAR:-}`, means unset. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

/**
 * Server configuration.
 *
 * Parsed once at startup so a missing or malformed variable stops the process
 * before it can serve a request against the wrong database (architecture §28).
 */
const schema = z.object({
  ...baseEnvShape,

  API_HOST: z.string().min(1).default('0.0.0.0'),

  /**
   * The one brand this deployment serves (D-470, M31).
   *
   * Set on a brand's API and worker: each brand's ERP runs on a database of its own, and
   * both processes refuse to start unless that database holds this brand and no other real
   * one (`platform/brand/deployment.ts`). It is also the audience an owner sign-in link
   * must name (D-473). Unset is the many-brand mode the tests and local development keep.
   */
  ERP_BRAND_SLUG: optional(
    z.string().regex(BRAND_SLUG_PATTERN, 'A brand slug: a-z, 0-9 and dashes.'),
  ),
  API_PORT: z.coerce.number().int().positive().max(65535).default(3000),

  /**
   * Where the logs go. `stderr` is for a command whose stdout is its product:
   * `preview:seed --out -` prints the preview's sign-ins there, and a log line in the
   * middle of them would corrupt the file (D-381).
   */
  LOG_DESTINATION: z.enum(['stdout', 'stderr']).default('stdout'),

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

  /**
   * The largest single cash-in, in poisha (D-092). Default ৳1 crore. A cash
   * entry is posted without a second person, so its size is bounded here
   * rather than trusted to whoever types it (M03 security review M2).
   */
  LEDGER_CASH_IN_MAX_POISHA: z
    .string()
    .regex(/^[1-9]\d{0,15}$/)
    .default('1000000000')
    .transform((value) => BigInt(value)),

  /**
   * Valkey, for the Socket.IO adapter and the rate limiter (architecture §19).
   *
   * Defaulted rather than required, because the two things that read it both
   * degrade to something correct-but-single-process without it and because the
   * route-coverage gate boots the app with no infrastructure at all. The
   * default is the dev compose service (infra/docker-compose.dev.yml), so a
   * developer who has run `docker compose up` needs no entry in .env.
   *
   * `redis://` is the scheme: Valkey speaks RESP and every client uses that
   * URL scheme for it. A `valkey://` URL would be refused by ioredis.
   */
  VALKEY_URL: z.string().url().startsWith('redis').default('redis://127.0.0.1:6379'),

  /**
   * Namespace for the Socket.IO Valkey adapter's pub/sub channels (§19).
   *
   * Every API instance sharing this prefix shares one realtime fan-out, which
   * is the point. It is configurable because the *reverse* also bites: two
   * environments pointed at one Valkey with the same prefix deliver each
   * other's events, and a test suite that shares a prefix with a parallel suite
   * receives its rooms' traffic. The integration suites override it per run.
   */
  REALTIME_ADAPTER_KEY: z.string().min(1).default('elysium:rt'),

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
