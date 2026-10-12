import { MEDIA_RETENTION_DAYS } from '@elysium/domain/inbox';
import { z } from 'zod';

import type { InboxConfig } from './inbox.config.js';
import {
  FakeMetaMediaGateway,
  GraphMetaMediaGateway,
  type MetaMediaGateway,
} from './providers/meta-media.js';

/**
 * M45's configuration (D-780 to D-788), beside M42's `inbox.config.ts` for the reason that file
 * gives. The Meta media and calls adapter follows M42's two keys: it is the Graph adapter only
 * when `INBOX_META_PROVIDER=graph` and `INBOX_META_ENABLED=true` (D-731), the fake otherwise.
 */
const schema = z.object({
  /** ffmpeg, which turns a recording into each channel's format (the camera's, D-675). */
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  /** How long kept voice messages and pictures stay (D-783). */
  INBOX_MEDIA_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(30)
    .max(3650)
    .default(MEDIA_RETENTION_DAYS),
  /**
   * Whether calls ring in the console (D-786). On by default: a call webhook only ever arrives
   * once the brand subscribed its app to `calls`, so nothing rings before someone chose it.
   */
  INBOX_CALLS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export type VoiceCallsConfig = z.infer<typeof schema>;

export const VOICE_CALLS_CONFIG = Symbol('VoiceCallsConfig');

export function voiceCallsConfig(env: NodeJS.ProcessEnv = process.env): VoiceCallsConfig {
  return schema.parse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')));
}

/** The media and calls gateway M42's configuration names. */
export function mediaGatewayFor(config: InboxConfig): MetaMediaGateway {
  if (config.INBOX_META_PROVIDER === 'fake') return new FakeMetaMediaGateway();
  return new GraphMetaMediaGateway({
    baseUrl: config.INBOX_META_BASE_URL,
    apiVersion: config.INBOX_META_API_VERSION,
    timeoutMs: config.INBOX_META_TIMEOUT_MS,
  });
}
