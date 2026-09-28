import { z } from 'zod';

/**
 * The fraud module's configuration (architecture §10, §28, invariant 10).
 *
 * Parsed once, at boot, and **it throws rather than defaulting**. That is the whole
 * design of this file and it is worth being explicit about, because the convenient
 * alternative is a disaster:
 *
 * ```ts
 * const key = process.env.FRAUD_PHONE_HASH_KEY ?? 'dev-key';   // never do this
 * ```
 *
 * A fallback key does not fail. It produces hashes — different hashes — so the
 * system keeps working and every phone number silently becomes a *new* person. Five
 * brands' accumulated delivery history detaches from the buyers it describes, every
 * badge reads "new customer", and nothing anywhere logs a problem. The corruption is
 * also unrecoverable: the input cannot be derived from either hash, so there is no
 * migration that repairs it afterwards. A process that will not start is the cheap
 * failure.
 *
 * The same argument applies to rotating the key, which is why there is no rotation
 * support here and no `FRAUD_PHONE_HASH_KEY_PREVIOUS`. Rotating it orphans the whole
 * table. If a rotation is ever genuinely needed it is a migration that rehashes from
 * the source numbers in each org's `sales.customers`, not a configuration change —
 * logged as a follow-up.
 *
 * ## It lives here rather than in `serverEnv()`
 *
 * `platform/config/env.ts` is one file and several milestones are building at once,
 * so an agent appending to it silently discards whatever another agent wrote. The
 * variables are listed in the INTEGRATION notes for folding into `serverEnv()`
 * later; parsing them here in the meantime costs one Zod schema and keeps the
 * failure just as loud, because the provider that reads it is constructed during
 * `app.init()`.
 */

const schema = z.object({
  /**
   * The HMAC key for `fraud.phone_signals.phone_hash` (§10).
   *
   * 32 characters minimum, the same floor `AUTH_SECRET` uses. A short key is the
   * failure mode that looks fine: HMAC-SHA256 accepts any key length, so a
   * four-character key produces perfectly well-formed hashes over a keyspace
   * somebody can brute-force alongside the eleven-digit number space. And the
   * number space is small — every Bangladeshi mobile is `01` plus an operator digit
   * plus eight digits, which is under a billion candidates and a few minutes of
   * laptop time. The key is the *only* thing standing between a leaked copy of this
   * table and a list of everyone who has ever refused a parcel, so it is a secret
   * from the secret manager and never a value in a repository (§25).
   */
  FRAUD_PHONE_HASH_KEY: z
    .string({ error: 'FRAUD_PHONE_HASH_KEY is required: see fraud.config.ts.' })
    .min(32, 'FRAUD_PHONE_HASH_KEY must be at least 32 characters.'),

  /**
   * The Steadfast fraud-check endpoint, if there is one (D-010).
   *
   * Unset by default and the provider is then simply absent — the score is
   * internal-only and says so on the badge, which is the same path check 3's timeout
   * takes. There is no built-in URL, because inventing one is how an integration
   * ships against an endpoint nobody verified (CLAUDE.md: "never invent endpoints or
   * fields").
   */
  FRAUD_STEADFAST_URL: z.string().url().optional(),
  FRAUD_STEADFAST_API_KEY: z.string().min(1).optional(),
  FRAUD_STEADFAST_SECRET_KEY: z.string().min(1).optional(),

  /**
   * How long the module waits for a provider, in milliseconds.
   *
   * 1200 ms, under §10's 300 ms badge budget only because the budget is about the
   * *cached* path: a cache miss goes to the network and the desk shows the internal
   * score immediately while it does. The timeout exists so a provider having a bad
   * afternoon cannot become our outage (check 3), and it is short enough that a
   * confirm never waits on one for long.
   */
  FRAUD_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(1_200),

  /**
   * The most provider lookups this process will start per minute, across all orgs.
   *
   * Providers meter and rate-limit, and the failure without a ceiling is not a bill —
   * it is the provider blocking us, at which point every org loses the check at
   * once. 60 is a starting point; it is configuration because the real number comes
   * from a contract nobody has signed yet.
   */
  FRAUD_PROVIDER_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),
});

export type FraudConfig = z.infer<typeof schema>;

/** The DI token. A value provider, so a test can supply its own without env vars. */
export const FRAUD_CONFIG = Symbol('FRAUD_CONFIG');

/**
 * Read and validate, or throw with every problem named.
 *
 * The message deliberately does not echo any value. A configuration error message
 * that quoted the key it rejected would put a secret in the logs of the one event
 * guaranteed to be logged (invariant 10).
 */
export function fraudConfig(source: NodeJS.ProcessEnv = process.env): FraudConfig {
  const result = schema.safeParse(source);
  if (result.success) return result.data;

  const problems = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .sort()
    .join('\n');

  throw new Error(
    `Invalid fraud configuration:\n${problems}\n\n` +
      'FRAUD_PHONE_HASH_KEY keys every row in fraud.phone_signals. Starting without it ' +
      'would silently turn every phone number into a new person and detach five brands ' +
      'of delivery history from the buyers it describes, unrecoverably — so this ' +
      'process will not start. Generate one with `openssl rand -hex 32` and put it in ' +
      'the secret manager.',
  );
}
