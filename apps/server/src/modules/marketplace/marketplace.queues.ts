import type { QueueDefinition } from '../../platform/jobs/queues.js';

/**
 * The marketplace's jobs (M35b, §20). Every call to ncom happens here, in the worker, with no
 * transaction open (invariant 6).
 *
 * - `marketplace.ncom_send`: an order's waiting changes, to ncom, in order. `ncom-send:<order>`
 *   keeps one sender per order; the backoff is the message's own (`next_attempt_at`), not the
 *   queue's, so a crash retry finds the message where it was.
 * - `marketplace.ncom_sweep`: every minute, the orders whose backoff has passed (the old site's
 *   cron on `/api/ncom/outbox`).
 */
export const MARKETPLACE_QUEUES = {
  send: {
    name: 'marketplace.ncom_send',
    scope: 'org',
    policy: 'exclusive',
    retryLimit: 3,
    retryDelaySeconds: 30,
    expireInSeconds: 120,
  },
  sweep: {
    name: 'marketplace.ncom_sweep',
    scope: 'global',
    cron: '* * * * *',
    retryLimit: 1,
    retryDelaySeconds: 30,
    expireInSeconds: 120,
  },
} as const satisfies Record<string, QueueDefinition>;

export const MARKETPLACE_QUEUE_DEFINITIONS: readonly QueueDefinition[] =
  Object.values(MARKETPLACE_QUEUES);
