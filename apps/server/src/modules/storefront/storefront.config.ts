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
  return parsed.data;
}

export const STOREFRONT_CONFIG = Symbol('STOREFRONT_CONFIG');
