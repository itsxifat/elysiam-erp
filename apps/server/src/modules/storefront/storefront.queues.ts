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
 * - `storefront.tracking_send`, `storefront.tracking_purge` (M35b, D-552): the website's events
 *   to Meta and GA4, and the log's retention.
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
  /**
   * M35b (D-552): send one logged event to Meta and GA4. `tracking:<row>` keeps one send in
   * flight per event; a retry after a crash finds the row already sent and stops.
   */
  trackingSend: {
    name: 'storefront.tracking_send',
    scope: 'org',
    policy: 'exclusive',
    retryLimit: 3,
    retryDelaySeconds: 60,
    expireInSeconds: 120,
  },
  /** M35b: every night, the events past each brand's retention go (D-552). */
  trackingPurge: {
    name: 'storefront.tracking_purge',
    scope: 'global',
    cron: '30 3 * * *',
    retryLimit: 2,
    retryDelaySeconds: 600,
    expireInSeconds: 600,
  },
} as const satisfies Record<string, QueueDefinition>;

export const STOREFRONT_QUEUE_DEFINITIONS: readonly QueueDefinition[] =
  Object.values(STOREFRONT_QUEUES);
