import type { QueueDefinition } from '../../platform/jobs/queues.js';

/**
 * Telephony's jobs (M47, D-832, D-839, D-840, D-842). Every call to Envo here happens in the
 * worker, outside any transaction (invariant 6); payloads carry ids only, never a key, a body or
 * a phone (invariant 10).
 *
 * - `telephony.process_webhook`: apply one stored, signed Envo webhook body to its call. Keyed by
 *   the stored row; the handler is idempotent anyway (a body is processed once).
 * - `telephony.fetch_recording`: download one call's recording from its connection's own host
 *   and keep it as a private file. Keyed by the call; four tries a few minutes apart (Envo writes
 *   the file when the call ends, and may be briefly unreachable), then the call shows it failed.
 * - `telephony.sync_sweep`: every five minutes, queue a sync for each enabled connection of every
 *   brand. `telephony.sync_connection` reads Envo's call history since the connection's cursor,
 *   fills anything a missed webhook would have, and closes clicks Envo never described.
 * - `telephony.recording_retention`: every night, delete recordings past their connection's
 *   retention (the call row stays, `expired`) and recording files no call took.
 */
export const TELEPHONY_QUEUES = {
  processWebhook: {
    name: 'telephony.process_webhook',
    scope: 'org',
    policy: 'exclusive',
    retryLimit: 5,
    retryDelaySeconds: 10,
    expireInSeconds: 120,
  },
  fetchRecording: {
    name: 'telephony.fetch_recording',
    scope: 'org',
    policy: 'exclusive',
    retryLimit: 4,
    retryDelaySeconds: 120,
    expireInSeconds: 300,
  },
  syncSweep: {
    name: 'telephony.sync_sweep',
    scope: 'global',
    cron: '*/5 * * * *',
    retryLimit: 0,
    expireInSeconds: 240,
  },
  syncConnection: {
    name: 'telephony.sync_connection',
    scope: 'org',
    policy: 'exclusive',
    retryLimit: 1,
    retryDelaySeconds: 60,
    expireInSeconds: 240,
  },
  recordingRetention: {
    name: 'telephony.recording_retention',
    scope: 'global',
    cron: '50 3 * * *',
    retryLimit: 1,
    expireInSeconds: 1800,
  },
} as const satisfies Record<string, QueueDefinition>;

export const TELEPHONY_QUEUE_DEFINITIONS: readonly QueueDefinition[] =
  Object.values(TELEPHONY_QUEUES);
