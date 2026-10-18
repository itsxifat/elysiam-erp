import type { QueueDefinition } from '../../platform/jobs/queues.js';

/**
 * Telephony's jobs (M47, D-832, D-839, D-851, D-858). Every call to Envo here happens in the
 * worker, outside any transaction (invariant 6); payloads carry ids only, never a key, a body or
 * a phone (invariant 10).
 *
 * - `telephony.process_webhook`: apply one stored, signed Envo webhook body to its call. Keyed by
 *   the stored row; the handler is idempotent anyway (a body is processed once).
 * - `telephony.sync_sweep`: every five minutes, queue a sync for each enabled connection of every
 *   brand. `telephony.sync_connection` reads Envo's call history since the connection's cursor,
 *   fills anything a missed webhook would have, and closes clicks Envo never described.
 * - `telephony.webhook_retention`: every night, delete Envo's stored webhook bodies thirty days
 *   after they were processed (D-851). Recordings stay with Envo and are never kept here (D-858).
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
  webhookRetention: {
    name: 'telephony.webhook_retention',
    scope: 'global',
    cron: '50 3 * * *',
    retryLimit: 1,
    expireInSeconds: 1800,
  },
} as const satisfies Record<string, QueueDefinition>;

export const TELEPHONY_QUEUE_DEFINITIONS: readonly QueueDefinition[] =
  Object.values(TELEPHONY_QUEUES);
