import { baseEnvShape, createEnv } from '@elysium/config/env';
import { parseWeights, type LeaderboardWeights } from '@elysium/domain/analytics';
import { z } from 'zod';

/**
 * The mother ERP's configuration (D-480), parsed once so a missing value stops the process
 * before it serves anything.
 *
 * Nothing here is shared with a brand: the mother has its own database, its own secrets
 * and its own domain. The brands' read connections are not configuration but data,
 * encrypted with `MOTHER_SECRETS_KEY` in the brand registry (D-481).
 */
const postgresUrl = z.string().url().startsWith('postgres');

const schema = z.object({
  ...baseEnvShape,

  MOTHER_API_HOST: z.string().min(1).default('127.0.0.1'),
  MOTHER_API_PORT: z.coerce.number().int().positive().max(65535).default(3300),

  /** `mother_app`: the API and the worker's own writes. No DDL, no superuser. */
  MOTHER_DATABASE_URL: postgresUrl,
  /** `mother_owner`: migrations, and the worker's job queue, which migrates its own schema. */
  MOTHER_DATABASE_OWNER_URL: postgresUrl.optional(),
  /** An administrator, for `mother:db-bootstrap` only. */
  MOTHER_DATABASE_ADMIN_URL: postgresUrl.optional(),

  /**
   * Where the owner opens the mother: the console and the API on one origin (D-491).
   * Better Auth's base URL, the CSRF origin check and every link the mother hands out.
   */
  MOTHER_PUBLIC_URL: z.string().url(),
  /** Extra origins allowed to call the API with cookies; the Vite dev server in development. */
  MOTHER_TRUSTED_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    ),

  /** Signs sessions. 32 characters at least, from the server's secret store. */
  MOTHER_AUTH_SECRET: z.string().min(32),

  /**
   * AES-256-GCM key, base64 of 32 bytes, for the brands' read connections and owner-link
   * private keys (D-481, D-490). Optional so the API boots to say what is wrong; any use
   * of a secret without it is refused.
   */
  MOTHER_SECRETS_KEY: z.string().optional(),
  /** Names the key, so a rotation can tell old ciphertext from new. */
  MOTHER_SECRETS_KEY_ID: z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/)
    .default('k1'),

  /** How many reverse proxies stand in front (nginx: 1). Decides the per-IP rate limit's key. */
  TRUSTED_PROXY_COUNT: z.coerce.number().int().min(0).max(10).default(0),

  /** The pull worker's cadence (D-484). */
  MOTHER_PULL_EVERY_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  /** The recent window a scheduled pull refreshes, in days (D-484). */
  MOTHER_PULL_WINDOW_DAYS: z.coerce.number().int().min(7).max(400).default(100),
  /** How long a brand may take to answer before the pull gives up on it. */
  MOTHER_BRAND_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(60).default(8),
  MOTHER_BRAND_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),

  /** The leaderboard's weights as JSON, metric: 0–100; omitted keeps D-323's defaults. */
  MOTHER_LEADERBOARD_WEIGHTS: z
    .string()
    .optional()
    .transform((value, context): LeaderboardWeights => {
      try {
        return parseWeights(value === undefined || value === '' ? undefined : JSON.parse(value));
      } catch (error) {
        context.addIssue({
          code: 'custom',
          message: error instanceof Error ? error.message : 'not valid JSON',
        });
        return z.NEVER;
      }
    }),
});

export type MotherEnv = z.infer<typeof schema>;

let cached: MotherEnv | undefined;

export function motherEnv(): MotherEnv {
  cached ??= createEnv('mother-server', schema);
  return cached;
}

/** For tests, which set the environment for a throwaway database first. */
export function resetMotherEnv(): void {
  cached = undefined;
}

/** The origins the CSRF check and Better Auth accept: the public URL's, and any extra. */
export function trustedOrigins(env: MotherEnv): string[] {
  return [new URL(env.MOTHER_PUBLIC_URL).origin, ...env.MOTHER_TRUSTED_ORIGINS];
}
