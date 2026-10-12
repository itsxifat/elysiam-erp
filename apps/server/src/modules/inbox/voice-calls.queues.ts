import type { QueueDefinition } from '../../platform/jobs/queues.js';

/**
 * M45's jobs (D-780 to D-788). Every Meta call, every storage read and every ffmpeg run happens
 * here, in the worker, outside any transaction (invariant 6). Payloads carry ids only.
 *
 * - `inbox.fetch_media`: download one attachment a customer sent (a voice message or a
 *   picture) before Meta's link expires, and keep it. Keyed by the kept attachment.
 * - `inbox.send_voice`: transcode one recorded voice message into its channel's format and
 *   send it. Keyed by the message, so it is never in flight twice.
 * - `inbox.call_timeout`: a call still ringing when its deadline passed is missed (D-786),
 *   should Meta's terminate never come. Idempotent.
 * - `inbox.media_retention`: every night, delete kept media older than the retention rule and
 *   recordings that were uploaded and never sent (D-783).
 */
export const VOICE_CALLS_QUEUES = {
  fetchMedia: {
    name: 'inbox.fetch_media',
    scope: 'org',
    policy: 'exclusive',
    // Meta's media link lasts minutes and its media id seven days: a few quick tries.
    retryLimit: 4,
    retryDelaySeconds: 15,
    expireInSeconds: 180,
  },
  sendVoice: {
    name: 'inbox.send_voice',
    scope: 'org',
    policy: 'exclusive',
    retryLimit: 3,
    retryDelaySeconds: 10,
    expireInSeconds: 240,
  },
  callTimeout: {
    name: 'inbox.call_timeout',
    scope: 'org',
    retryLimit: 2,
    retryDelaySeconds: 5,
    expireInSeconds: 60,
  },
  mediaRetention: {
    name: 'inbox.media_retention',
    scope: 'global',
    cron: '40 3 * * *',
    retryLimit: 1,
    expireInSeconds: 1800,
  },
} as const satisfies Record<string, QueueDefinition>;

export const VOICE_CALLS_QUEUE_DEFINITIONS: readonly QueueDefinition[] =
  Object.values(VOICE_CALLS_QUEUES);
