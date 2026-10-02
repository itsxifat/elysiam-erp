import { z } from 'zod';

import { FakeMetaGateway, GraphMetaGateway, type MetaGateway } from './providers/meta-gateway.js';

/**
 * The marketing module's configuration (architecture §21, §25; M18).
 *
 * Parsed here rather than in `serverEnv()` for the reason `courier.config.ts` gives: every
 * value is a secret or a switch over one, and parallel milestones are editing the shared
 * file. A copied `.env.example` boots with the fake Meta provider and no key, which stores
 * no token and sends nothing.
 *
 * **Two keys to turn Meta on** (D-257), as D-012 and D-176 do for SMS and couriers: naming
 * the real Graph API provider without also setting `MARKETING_META_ENABLED=true` stops the
 * process at boot. Both adapters are built from Meta's documentation and have never spoken
 * to Meta; somebody who switches them on is making that decision on purpose.
 */
const schema = z.object({
  MARKETING_META_PROVIDER: z.enum(['fake', 'graph']).default('fake'),
  MARKETING_META_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** Meta's Graph API host, overridable for a local stand-in in tests. */
  MARKETING_META_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  /** The version Meta's examples used when the adapters were written (2026-10-02). */
  MARKETING_META_API_VERSION: z
    .string()
    .regex(/^v\d{1,3}\.\d$/)
    .default('v25.0'),
  MARKETING_META_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(15_000),
  /**
   * The key Meta tokens are sealed with: 32 bytes, base64. Optional at boot — a token
   * cannot be stored without it, and saying so is the refusal.
   */
  MARKETING_CREDENTIALS_KEY: z
    .string()
    .optional()
    .refine(
      (value) => value === undefined || Buffer.from(value, 'base64').length === 32,
      'MARKETING_CREDENTIALS_KEY must be 32 bytes, base64-encoded (`openssl rand -base64 32`).',
    ),
  MARKETING_CREDENTIALS_KEY_ID: z.string().min(1).max(64).default('v1'),
});

export type MarketingConfig = z.infer<typeof schema>;

export const MARKETING_CONFIG = Symbol('MarketingConfig');

export function marketingConfig(env: NodeJS.ProcessEnv = process.env): MarketingConfig {
  // `KEY=` in a dotenv file is an empty string, not an absent key; read it as absent.
  const config = schema.parse(
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')),
  );
  if (config.MARKETING_META_PROVIDER === 'graph' && !config.MARKETING_META_ENABLED) {
    throw new Error(
      'MARKETING_META_PROVIDER=graph names unverified Meta adapters (D-257). Set ' +
        'MARKETING_META_ENABLED=true as well to use them before they have been verified.',
    );
  }
  return config;
}

/** The gateway this configuration names. `marketingConfig` already refused a half-on one. */
export function metaGatewayFor(config: MarketingConfig): MetaGateway {
  if (config.MARKETING_META_PROVIDER === 'fake') return new FakeMetaGateway();
  return new GraphMetaGateway({
    baseUrl: config.MARKETING_META_BASE_URL,
    apiVersion: config.MARKETING_META_API_VERSION,
    timeoutMs: config.MARKETING_META_TIMEOUT_MS,
  });
}
