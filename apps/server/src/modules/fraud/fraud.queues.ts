import type { QueueDefinition } from '../../platform/jobs/queues.js';

/**
 * The one queue this module owns (architecture §20, invariant 6).
 *
 * A provider lookup is an outbound HTTP call, so invariant 6 forbids it inside the
 * transaction that is scoring an order. `assess()` enqueues this instead, in the same
 * transaction, and the worker does the network call and writes the row afterwards. §10's
 * "refreshes stale data in the background" is the same sentence read from the other end.
 *
 * `PLATFORM_QUEUES` is empty by design ("a queue arrives with the module that both
 * enqueues and works it"), and it is one shared file that several milestones are writing
 * to at once — so the definition is exported here and the integrator adds it to the
 * worker's list. Until it is added, nothing breaks: providers are opt-in per org and
 * default to off, and a failed enqueue degrades to an internal-only badge rather than a
 * failed confirm (see `scheduleRefresh`).
 */
export const FRAUD_REFRESH_QUEUE: QueueDefinition = {
  name: 'fraud.refresh_provider',
  scope: 'org',
  /**
   * Two retries, not the house default of five.
   *
   * The house policy is right for work that must eventually happen — booking a parcel,
   * sending a payslip. This is a cache warm-up: the answer is already stale by the time
   * a third retry lands, the next agent to look at the number enqueues a fresh job
   * anyway, and providers meter every call. Retrying five times through an outage would
   * spend the throttle budget on answers nobody is waiting for any more.
   */
  retryLimit: 2,
  retryDelaySeconds: 30,
  /**
   * 30 seconds. Every provider call inside the handler has its own timeout well under
   * `FRAUD_PROVIDER_TIMEOUT_MS`, so a job still active after half a minute means the
   * worker died holding it.
   */
  expireInSeconds: 30,
};

export const FRAUD_QUEUES: readonly QueueDefinition[] = [FRAUD_REFRESH_QUEUE];

/**
 * What the job carries.
 *
 * The **plaintext number**, deliberately, and it is the only place in this module where
 * one is written down: a provider has to look it up, and a hash cannot be reversed to
 * get it back. `pgboss.job` is not reachable from any tenant query, the payload is never
 * logged, and pg-boss deletes the row when the job completes — whereas
 * `fraud.phone_signals` is permanent and readable by five orgs, which is why the hash
 * lives there and the number lives here.
 */
export interface RefreshProviderPayload {
  readonly phone: string;
  /** Which providers were missing or stale. Refreshing the fresh ones would waste a call. */
  readonly providers: readonly string[];
}
