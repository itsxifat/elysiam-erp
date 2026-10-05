import { z } from 'zod';

/**
 * The storefront API's configuration (M33, D-506, D-509).
 *
 * Like the intake's, a missing secret switches the public API **off** (503, logged) rather
 * than stopping the API: a brand with no website yet has no reason to fail its order desk
 * over a website setting. The master key is the intake's, `INTAKE_KEY_SECRET` (D-509): the
 * website's keys derive their secrets from it under their own label, so a brand that already
 * issues landing-page keys needs nothing new deployed.
 */

const schema = z.object({
  NODE_ENV: z.string().optional(),
  INTAKE_KEY_SECRET: z
    .string()
    .min(32, 'INTAKE_KEY_SECRET must be at least 32 characters.')
    .optional(),

  /** §23's five minutes, either side of now. */
  STOREFRONT_SIGNATURE_WINDOW_SECONDS: z.coerce.number().int().min(30).max(900).default(300),

  /*
   * Generous on purpose (D-506): the website's server is one address making every shopper's
   * reads, and server-side rendering asks several things per page. The source limit is
   * checked before any signature, so a flood costs a counter, not a database read.
   */
  STOREFRONT_RATE_SOURCE_IP_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(6000),
  STOREFRONT_RATE_KEY_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(3000),
  STOREFRONT_RATE_LIMIT_STORE: z.enum(['valkey', 'memory']).default('valkey'),

  /**
   * Where the website's image URLs point (D-507): the API's public origin by default, or
   * the CDN in front of `/media/` when there is one. No trailing slash.
   */
  STOREFRONT_MEDIA_BASE_URL: z
    .string()
    .url()
    .transform((value) => value.replace(/\/+$/, ''))
    .optional(),

  // --- M34: buying (D-520 to D-539) ---------------------------------------------------------

  /** How long the payment route waits for the worker to open an SSLCommerz session (D-525). */
  STOREFRONT_GATEWAY_WAIT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  /** How long one call to SSLCommerz may take before it counts as failed. */
  STOREFRONT_GATEWAY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  /** `fake` answers from a recorder (tests); `sslcommerz` is the real gateway (UNVERIFIED). */
  STOREFRONT_SSLCOMMERZ_PROVIDER: z.enum(['sslcommerz', 'fake']).default('sslcommerz'),
  /**
   * Whether a brand's SSLCommerz **sandbox** store may take payments on this installation (M34
   * ledger audit C1). Off: a sandbox store is never offered and a sandbox payment is never
   * booked, because SSLCommerz's test cards are public. On only for a staging or preview server
   * and the tests, where the whole flow is tried before a brand goes live.
   */
  STOREFRONT_SSLCOMMERZ_ALLOW_SANDBOX: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** The ERP's public address SSLCommerz posts its IPN to; `API_PUBLIC_URL` when unset. */
  STOREFRONT_IPN_BASE_URL: z
    .string()
    .url()
    .transform((value) => value.replace(/\/+$/, ''))
    .optional(),
  /** Shopper sign-in tries per shopper address and per email, per ten minutes (D-534). */
  STOREFRONT_SIGN_IN_PER_10_MINUTES: z.coerce.number().int().min(1).max(1_000).default(8),
  /** Email codes sent per address per fifteen minutes (D-522). */
  STOREFRONT_CODE_SENDS_PER_15_MINUTES: z.coerce.number().int().min(1).max(100).default(4),
  /** Registrations, resets and code checks per shopper address per fifteen minutes. */
  STOREFRONT_ACCOUNT_WRITES_PER_15_MINUTES: z.coerce.number().int().min(1).max(10_000).default(20),
  /** How long an unpaid SSLCommerz order holds its stock before it is cancelled (D-527). */
  STOREFRONT_UNPAID_ORDER_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .default(60),

  // --- M35b: tracking (D-552) ---------------------------------------------------------------

  /**
   * Who receives the website's server-side events: `fake` records them (tests, and every
   * installation until a brand's real pixel token is tried), `live` sends them to Meta's
   * Conversions API and GA4's Measurement Protocol. Both adapters are UNVERIFIED, so `live`
   * also needs `STOREFRONT_TRACKING_ENABLED=true` (the two-key rule of D-257).
   */
  STOREFRONT_TRACKING_PROVIDER: z.enum(['fake', 'live']).default('fake'),
  STOREFRONT_TRACKING_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  STOREFRONT_TRACKING_META_BASE_URL: z
    .string()
    .url()
    .transform((value) => value.replace(/\/+$/, ''))
    .default('https://graph.facebook.com'),
  STOREFRONT_TRACKING_GA4_BASE_URL: z
    .string()
    .url()
    .transform((value) => value.replace(/\/+$/, ''))
    .default('https://www.google-analytics.com'),
  STOREFRONT_TRACKING_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(10_000),
});

export type StorefrontConfig = z.infer<typeof schema>;

export function storefrontConfig(source: NodeJS.ProcessEnv = process.env): StorefrontConfig {
  // `KEY=` in a dotenv file is an empty string, not an absent key (the intake's lesson).
  const present = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .sort()
      .join('\n');
    throw new Error(`Invalid storefront configuration:\n${problems}`);
  }
  if (
    parsed.data.NODE_ENV === 'production' &&
    parsed.data.STOREFRONT_RATE_LIMIT_STORE === 'memory'
  ) {
    // The intake's rule (M11): per-process counters multiply the limit by the replica count.
    throw new Error(
      'STOREFRONT_RATE_LIMIT_STORE=memory in production makes every limit per process. Use valkey.',
    );
  }
  if (
    parsed.data.STOREFRONT_TRACKING_PROVIDER === 'live' &&
    !parsed.data.STOREFRONT_TRACKING_ENABLED
  ) {
    // D-257's two keys: naming unverified adapters is not switching them on.
    throw new Error(
      'STOREFRONT_TRACKING_PROVIDER=live names unverified Meta and GA4 adapters (D-552). Set ' +
        'STOREFRONT_TRACKING_ENABLED=true as well to send events before they have been verified.',
    );
  }
  return parsed.data;
}

export const STOREFRONT_CONFIG = Symbol('STOREFRONT_CONFIG');
