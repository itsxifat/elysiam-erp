import { createEnv } from '@elysium/config/env';
import { z } from 'zod';

/**
 * The courier module's configuration (architecture §21, §25; invariant 10).
 *
 * Parsed here rather than added to `serverEnv()` for one reason that will go away and
 * one that will not. The one that will go away: `serverEnv` is a single shared file and
 * three milestones are being built against it at once, so a second writer would
 * silently discard the first's variables. The one that will not: every value here is a
 * secret or a switch over a secret, and a module that owns them is easier to audit
 * than a schema with forty fields. The INTEGRATION notes ask for these to be folded
 * into `serverEnv` when the parallel build ends.
 *
 * Parsed once and cached, exactly as `serverEnv` is, so a missing key stops the
 * process at boot rather than at the first booking.
 */
const schema = z.object({
  /**
   * The key credentials are encrypted with: 32 bytes, base64.
   *
   * Optional, and its absence is not a boot failure — a development machine and the
   * route-coverage gate both boot with no courier at all, and the `fake` adapter needs
   * no credentials to encrypt. What *is* a failure is trying to store a real
   * credential without it: `credentialCipher()` refuses, with the variable's name in
   * the message, rather than writing plaintext into a `bytea` column and looking fine.
   */
  COURIER_CREDENTIALS_KEY: z
    .string()
    .optional()
    .refine(
      (value) => value === undefined || Buffer.from(value, 'base64').length === 32,
      'COURIER_CREDENTIALS_KEY must be 32 bytes, base64-encoded (`openssl rand -base64 32`).',
    ),
  /**
   * Which key the ciphertext was written with.
   *
   * Stored on every encrypted row so a rotation can find what it still has to re-wrap.
   * A name rather than a hash, because the name is what an operator reads in the secret
   * manager; `v1` until there is a reason for `v2`.
   */
  COURIER_CREDENTIALS_KEY_ID: z.string().min(1).max(64).default('v1'),
  /**
   * Whether the Steadfast adapter may be used at all (D-006, D-176).
   *
   * Off by default, and that default is the honest one: the adapter was built from the
   * closest thing to first-party documentation that could be reached, not from the
   * merchant portal's own API document, so it is marked UNVERIFIED in decisions.md.
   * A flag rather than an absent adapter, because the first person with real
   * credentials needs to be able to try it — and needs to be making a decision when
   * they do.
   */
  COURIER_STEADFAST_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * Steadfast's API base.
   *
   * Configurable and not hard-coded because the two public sources disagree
   * (`portal.packzy.com/api/v1` and `portal.steadfast.com.bd/api/v1`), and an operator
   * with a portal account can see which one their key belongs to. Baking in a guess
   * would make a wrong guess a deploy to fix.
   */
  COURIER_STEADFAST_BASE_URL: z.string().url().default('https://portal.packzy.com/api/v1'),
  /** How long a courier gets to answer before the job gives up and retries (§20). */
  COURIER_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
});

export type CourierEnv = z.infer<typeof schema>;

let cached: CourierEnv | undefined;

export function courierEnv(): CourierEnv {
  cached ??= createEnv('courier', schema);
  return cached;
}

/** Test-only: forget the parse, so a suite can change the environment. */
export function resetCourierEnv(): void {
  cached = undefined;
}
