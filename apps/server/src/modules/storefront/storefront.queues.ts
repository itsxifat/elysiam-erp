import type { QueueDefinition } from '../../platform/jobs/queues.js';

/**
 * The website's jobs (M34, §20). Each is tenant-scoped and idempotent; the payload is ids.
 *
 * - `storefront.sslcommerz_open`: open an SSLCommerz session for a payment (D-525). The route
 *   that asked waits on the session row; the external call happens here, with no transaction
 *   open (invariant 6).
 * - `storefront.sslcommerz_validate`: ask SSLCommerz's Order Validation API about a payment a
 *   return page or the IPN named, and book it if it is right (D-525, D-526).
 * - `storefront.expire_unpaid`: sixty minutes after an SSLCommerz checkout, cancel the order
 *   and release its hold if it is still pending and unpaid (D-527).
 */
export const STOREFRONT_QUEUES = {
  openSession: {
    name: 'storefront.sslcommerz_open',
    scope: 'org',
    retryLimit: 2,
    retryDelaySeconds: 5,
    expireInSeconds: 60,
  },
  validate: {
    name: 'storefront.sslcommerz_validate',
    scope: 'org',
    retryLimit: 5,
    retryDelaySeconds: 30,
    expireInSeconds: 120,
  },
  expireUnpaid: {
    name: 'storefront.expire_unpaid',
    scope: 'org',
    retryLimit: 5,
    retryDelaySeconds: 60,
    expireInSeconds: 120,
  },
} as const satisfies Record<string, QueueDefinition>;

export const STOREFRONT_QUEUE_DEFINITIONS: readonly QueueDefinition[] =
  Object.values(STOREFRONT_QUEUES);
