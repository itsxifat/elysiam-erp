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

  /**
   * Whether the Pathao adapter may be used at all (D-006, M15).
   *
   * Off by default for the reason Steadfast's is: the adapter was built from Pathao's own
   * open-source WooCommerce plugin, not from the merchant API document, so it is UNVERIFIED.
   * Unlike Steadfast's switch this one is also read at the moment of use — booking, polling
   * and the webhook — so switching it back off stops an account that was activated while it
   * was on, instead of only stopping new activations.
   */
  COURIER_PATHAO_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** Pathao's live API. The host Pathao's plugin calls for its "Live" environment. */
  COURIER_PATHAO_BASE_URL: z.string().url().default('https://api-hermes.pathao.com'),
  /** Pathao's sandbox. The host Pathao's plugin calls for its "Staging" environment. */
  COURIER_PATHAO_SANDBOX_BASE_URL: z
    .string()
    .url()
    .default('https://courier-api-sandbox.pathao.com'),
  /**
   * The token path. Pathao's plugin logs in at `/aladdin/api/v1/external/login` with the
   * client id and secret; community clients describe an `issue-token` path with a password
   * grant instead. Configuration, so the first person with credentials can switch to
   * whichever their account is issued for without a deploy.
   */
  COURIER_PATHAO_TOKEN_PATH: z.string().startsWith('/').default('/aladdin/api/v1/external/login'),
  /**
   * The weight a Pathao parcel is declared at when the order carries none, in grams.
   *
   * Pathao prices by weight and refuses a parcel without one, and this ERP does not track
   * per-SKU weight yet. 500 g is the lightest band every Bangladeshi courier prices at; an
   * operator who ships heavier parcels changes it here.
   */
  COURIER_PATHAO_DEFAULT_WEIGHT_GRAMS: z.coerce.number().int().min(1).max(50_000).default(500),

  /** Whether the RedX adapter may be used at all (D-006, M15). Read at the moment of use. */
  COURIER_REDX_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** RedX's OpenAPI base, as RedX's own WordPress plugin calls it. */
  COURIER_REDX_BASE_URL: z.string().url().default('https://openapi.redx.com.bd/v1.0.0-beta'),
  /**
   * RedX's sandbox base. **No default**: no first-party source names one, and a guessed
   * host would send sandbox parcels somewhere nobody chose. An account in `sandbox` mode is
   * refused until this is set.
   */
  COURIER_REDX_SANDBOX_BASE_URL: z.string().url().optional(),
  /**
   * The path a parcel is created at.
   *
   * `/wordpress/parcel` is the only create path any RedX-authored code uses, and the field
   * set it takes is one this ERP can fill: it needs no RedX area id. The general `/parcel`
   * path that community clients call is described as requiring `delivery_area_id`, which
   * needs an area mapping this build does not have. Configuration, so the choice can be
   * changed by whoever holds RedX credentials.
   */
  COURIER_REDX_CREATE_PATH: z.string().startsWith('/').default('/wordpress/parcel'),
  /** RedX's declared weight when the order carries none, in grams. See Pathao's. */
  COURIER_REDX_DEFAULT_WEIGHT_GRAMS: z.coerce.number().int().min(1).max(50_000).default(500),
});

/**
 * Whether an adapter may be used, now.
 *
 * Verified adapters always may. An unverified one may only while its switch is on, and the
 * switch is read at every use — booking, polling, the webhook, the settlement fetch — rather
 * than only when an account is activated. Steadfast's switch was read only at activation in
 * M12, so turning it off after activating an account stopped nothing.
 */
export function adapterEnabled(adapter: {
  readonly code: string;
  readonly verified: boolean;
}): boolean {
  if (adapter.verified) return true;
  const env = courierEnv();
  switch (adapter.code) {
    case 'steadfast':
      return env.COURIER_STEADFAST_ENABLED;
    case 'pathao':
      return env.COURIER_PATHAO_ENABLED;
    case 'redx':
      return env.COURIER_REDX_ENABLED;
    default:
      return false;
  }
}

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
