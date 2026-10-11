import { z } from 'zod';

import {
  FakeMessagingGateway,
  GraphMessagingGateway,
  type MessagingGateway,
} from './providers/meta-messaging.js';

/**
 * The inbox's configuration (M42, D-731).
 *
 * Parsed here rather than in `serverEnv()` for the reason `marketing.config.ts` gives: the
 * shared file is edited by parallel milestones, and every value is a switch over a secret's
 * use. A copied `.env.example` boots with the fake gateway, which sends nothing anywhere.
 *
 * **Two keys to send through Meta**, as D-257 has for the marketing adapters: naming the Graph
 * gateway without also setting `INBOX_META_ENABLED=true` stops the process at boot. The adapter
 * is built from Meta's documentation and has never spoken to Meta (Unverified integrations);
 * whoever switches it on is deciding to.
 *
 * Receiving needs no switch: a webhook is only ever accepted with the brand's own app secret,
 * which nobody has until the brand enters it in Settings → Inbox.
 */
const schema = z.object({
  INBOX_META_PROVIDER: z.enum(['fake', 'graph']).default('fake'),
  INBOX_META_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** Meta's Graph API host, overridable for a local stand-in in tests. */
  INBOX_META_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  /** The version Meta's Send API and Cloud API examples used when this was written (v25.0). */
  INBOX_META_API_VERSION: z
    .string()
    .regex(/^v\d{1,3}\.\d$/)
    .default('v25.0'),
  INBOX_META_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(15_000),
});

export type InboxConfig = z.infer<typeof schema>;

export const INBOX_CONFIG = Symbol('InboxConfig');

export function inboxConfig(env: NodeJS.ProcessEnv = process.env): InboxConfig {
  // `KEY=` in a dotenv file is an empty string, not an absent key; read it as absent.
  const config = schema.parse(
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')),
  );
  if (config.INBOX_META_PROVIDER === 'graph' && !config.INBOX_META_ENABLED) {
    throw new Error(
      'INBOX_META_PROVIDER=graph names an unverified Meta messaging adapter (D-731). Set ' +
        'INBOX_META_ENABLED=true as well to send through it before it has been verified.',
    );
  }
  return config;
}

/** The gateway this configuration names. `inboxConfig` already refused a half-on one. */
export function messagingGatewayFor(config: InboxConfig): MessagingGateway {
  if (config.INBOX_META_PROVIDER === 'fake') return new FakeMessagingGateway();
  return new GraphMessagingGateway({
    baseUrl: config.INBOX_META_BASE_URL,
    apiVersion: config.INBOX_META_API_VERSION,
    timeoutMs: config.INBOX_META_TIMEOUT_MS,
  });
}
