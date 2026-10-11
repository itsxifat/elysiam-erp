import type { QueueDefinition } from '../../platform/jobs/queues.js';

/**
 * Auto-assign's jobs (M41, D-717; §20).
 *
 * - `orders.offer_dispatch`: offer one order (`orderId`), or every waiting order in the brand
 *   (`orderId: null`), to the right person. Enqueued in the transaction of a decline, a release,
 *   auto-assign being switched on; the worker also dispatches on `order.created` and on a person
 *   becoming available. Idempotent: an order that is no longer pending and nobody's, or already
 *   holds a live offer, is left alone.
 * - `orders.offer_expire`: one offer's deadline, starting once it has passed. Expires the offer
 *   if it is still unanswered and offers the order to the next person. Idempotent: an answered
 *   offer is not touched.
 * - `orders.offer_sweep`: every minute, in every brand, lapses offers past their deadline (a
 *   missed expiry job) and offers waiting orders (people who became active without a beat the
 *   worker heard). The safety net: the jobs above make it fast, this makes it certain.
 */
export const OFFER_QUEUES = {
  dispatch: {
    name: 'orders.offer_dispatch',
    scope: 'org',
    retryLimit: 3,
    retryDelaySeconds: 2,
    expireInSeconds: 120,
  },
  expire: {
    name: 'orders.offer_expire',
    scope: 'org',
    retryLimit: 3,
    retryDelaySeconds: 2,
    expireInSeconds: 120,
  },
  sweep: {
    name: 'orders.offer_sweep',
    scope: 'global',
    cron: '* * * * *',
    retryLimit: 0,
    expireInSeconds: 50,
  },
} as const satisfies Record<string, QueueDefinition>;

export const OFFER_QUEUE_DEFINITIONS: readonly QueueDefinition[] = Object.values(OFFER_QUEUES);
