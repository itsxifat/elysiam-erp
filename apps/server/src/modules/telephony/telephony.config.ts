import { z } from 'zod';

import { FakeEnvoGateway, HttpEnvoGateway, type EnvoGateway } from './providers/envo-gateway.js';
import { envoHostCheck, parseCidr } from './providers/envo-host.js';

/**
 * Telephony's configuration (M47, D-849), parsed here rather than in `serverEnv()` for the reason
 * `inbox.config.ts` gives: the shared file is edited by parallel milestones.
 *
 * - `TELEPHONY_ENVO_PROVIDER`: `http` (the default) talks to each connection's own base URL;
 *   `fake` answers from memory, for a demo with no Envo. Nothing is ever called before a
 *   supervisor saves a connection with its API key, so the real adapter is the default.
 * - `TELEPHONY_ALLOW_PLAIN_HTTP`: lets a base URL be `http://` on any host, for the tests' stand-in
 *   on 127.0.0.1. Refused when `NODE_ENV=production`.
 * - `TELEPHONY_ENVO_TIMEOUT_MS`: each request to Envo (8 s).
 * - `TELEPHONY_RECORDING_TIMEOUT_MS`: the wait for a streamed recording's headers from Envo
 *   (15 s); the audio itself is never timed, and stops when the listener goes away (D-858).
 * - `TELEPHONY_PHONE_TOKEN_TTL_SECONDS`: the web phone's token (120 s; Envo allows 60 to 3600).
 * - `TELEPHONY_ENVO_PRIVATE_CIDRS`: private IPv4 ranges a base URL's name may resolve to,
 *   space- or comma-separated (`192.168.20.237/32`), for a brand whose own Envo its DNS answers
 *   with a LAN address. Empty (the default): every private, loopback and link-local address is
 *   refused (D-830).
 */
const schema = z.object({
  TELEPHONY_ENVO_PROVIDER: z.enum(['http', 'fake']).default('http'),
  TELEPHONY_ALLOW_PLAIN_HTTP: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  TELEPHONY_ENVO_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(8_000),
  TELEPHONY_RECORDING_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  TELEPHONY_PHONE_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(120),
  TELEPHONY_ENVO_PRIVATE_CIDRS: z
    .string()
    .default('')
    .transform((value, context) => {
      const cidrs = value
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((entry) => ({ entry, cidr: parseCidr(entry) }));
      const bad = cidrs.find((item) => item.cidr === null);
      if (bad !== undefined) {
        context.addIssue({
          code: 'custom',
          message: `"${bad.entry}" is not an IPv4 address or range`,
        });
        return z.NEVER;
      }
      return cidrs.flatMap((item) => (item.cidr === null ? [] : [item.cidr]));
    }),
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
    // The tests' stand-in is on 127.0.0.1; everywhere else the host's addresses are checked.
    ...(config.TELEPHONY_ALLOW_PLAIN_HTTP
      ? {}
      : { checkHost: envoHostCheck(config.TELEPHONY_ENVO_PRIVATE_CIDRS) }),
  });
}
