import { z } from 'zod';

import { BulkSmsBdGateway } from './providers/bulksmsbd.gateway.js';
import { FakeSmsGateway, type SmsGateway } from './providers/sms-gateway.js';

/**
 * Which SMS gateway this deployment sends through (D-012, still OPEN).
 *
 * The fake is the default everywhere, production included, until somebody makes two
 * separate choices: name a real provider, and opt into it while it is unverified. One
 * variable would let a single typo route a brand's customers' phone numbers to a service
 * nobody has confirmed works — the same two-key rule D-176 applies to couriers.
 */
const schema = z.object({
  NOTIFY_SMS_PROVIDER: z.enum(['fake', 'bulksmsbd']).default('fake'),
  NOTIFY_BULKSMSBD_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** `https://` on the documented host by default; see `bulksmsbd.gateway.ts`. */
  NOTIFY_BULKSMSBD_BASE_URL: z.string().url().default('https://bulksmsbd.net'),
  NOTIFY_BULKSMSBD_API_KEY: z.string().min(1).optional(),
  NOTIFY_BULKSMSBD_SENDER_ID: z.string().min(1).optional(),
  /** How long one send may take before the job gives up and tries later. */
  NOTIFY_SMS_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(8_000),
});

export type NotifyConfig = z.infer<typeof schema>;

export const NOTIFY_CONFIG = Symbol('NotifyConfig');

export function notifyConfig(env: NodeJS.ProcessEnv = process.env): NotifyConfig {
  // `KEY=` in a dotenv file is an empty string, not an absent key; read it as absent, as
  // `intakeConfig` does, so a copied `.env.example` boots with the fake gateway.
  return schema.parse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')));
}

/**
 * The gateway the config names, or the fake.
 *
 * Naming `bulksmsbd` without also setting `NOTIFY_BULKSMSBD_ENABLED=true` stops the
 * process at boot rather than quietly using the fake: somebody who asked for a real
 * gateway and got a recorder would believe messages were being delivered.
 */
export function gatewayFor(config: NotifyConfig): SmsGateway {
  if (config.NOTIFY_SMS_PROVIDER === 'fake') return new FakeSmsGateway();
  if (!config.NOTIFY_BULKSMSBD_ENABLED) {
    throw new Error(
      'NOTIFY_SMS_PROVIDER=bulksmsbd names an unverified gateway (D-012). Set ' +
        'NOTIFY_BULKSMSBD_ENABLED=true as well to use it before it has been verified.',
    );
  }
  return new BulkSmsBdGateway({
    baseUrl: config.NOTIFY_BULKSMSBD_BASE_URL,
    apiKey: config.NOTIFY_BULKSMSBD_API_KEY,
    senderId: config.NOTIFY_BULKSMSBD_SENDER_ID,
  });
}
