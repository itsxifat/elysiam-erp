import { z } from 'zod';

import { FakeEnvoGateway, HttpEnvoGateway, type EnvoGateway } from './providers/envo-gateway.js';

/**
 * Telephony's configuration (M47, D-849), parsed here rather than in `serverEnv()` for the reason
 * `inbox.config.ts` gives: the shared file is edited by parallel milestones.
 *
 * - `TELEPHONY_ENVO_PROVIDER`: `http` (the default) talks to each connection's own base URL;
 *   `fake` answers from memory, for a demo with no Envo. Nothing is ever called before a
 *   supervisor saves a connection with its API key, so the real adapter is the default.
 * - `TELEPHONY_ALLOW_PLAIN_HTTP`: lets a base URL be `http://` on any host, for the tests' stand-in
 *   on 127.0.0.1. Refused when `NODE_ENV=production`.
 * - `TELEPHONY_ENVO_TIMEOUT_MS`: each request to Envo (8 s). A recording's download gets 60 s.
 * - `TELEPHONY_RECORDING_MAX_BYTES`: the largest recording kept (64 MiB, the storage rule's).
 * - `TELEPHONY_PHONE_TOKEN_TTL_SECONDS`: the web phone's token (120 s; Envo allows 60 to 3600).
 */
const schema = z.object({
  TELEPHONY_ENVO_PROVIDER: z.enum(['http', 'fake']).default('http'),
  TELEPHONY_ALLOW_PLAIN_HTTP: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  TELEPHONY_ENVO_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(8_000),
  TELEPHONY_RECORDING_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
  TELEPHONY_RECORDING_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(64 * 1024 * 1024)
    .default(64 * 1024 * 1024),
  TELEPHONY_PHONE_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(120),
  NODE_ENV: z.string().optional(),
});

export type TelephonyConfig = z.infer<typeof schema>;

export const TELEPHONY_CONFIG = Symbol('TelephonyConfig');

export function telephonyConfig(env: NodeJS.ProcessEnv = process.env): TelephonyConfig {
  // `KEY=` in a dotenv file is an empty string, not an absent key; read it as absent.
  const config = schema.parse(
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')),
  );
  if (config.TELEPHONY_ALLOW_PLAIN_HTTP && config.NODE_ENV === 'production') {
    throw new Error(
      'TELEPHONY_ALLOW_PLAIN_HTTP=true is for the tests’ stand-in for Envo; it is refused in ' +
        'production, where every connection is https on a named host (D-830).',
    );
  }
  return config;
}

export function envoGatewayFor(config: TelephonyConfig): EnvoGateway {
  if (config.TELEPHONY_ENVO_PROVIDER === 'fake') return new FakeEnvoGateway();
  return new HttpEnvoGateway({
    timeoutMs: config.TELEPHONY_ENVO_TIMEOUT_MS,
    recordingTimeoutMs: config.TELEPHONY_RECORDING_TIMEOUT_MS,
  });
}
