import { z } from 'zod';

import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { FRAUD_REFRESH_QUEUE } from './fraud.queues.js';
import type { FraudService } from './fraud.service.js';

/**
 * Wiring `fraud.refresh_provider` to its handler (architecture §10, §20; M13).
 *
 * `assess()` enqueues a refresh whenever a provider answer is missing or stale, and until
 * this file nothing worked that queue: no handler existed anywhere, so every refresh job
 * would have sat in `pgboss.job` until it expired and the provider cache would never have
 * filled. `refreshProviders` was only ever called directly by a test. §10's "refreshes
 * stale data in the background" described a background that did not exist.
 *
 * A function, called from `main.worker.ts` with `FRAUD_QUEUES` added to the runtime's
 * queue list, for the reason `courier.worker.ts` gives: only the worker makes outbound
 * calls (§21), and a provider lookup is one.
 */

/**
 * The payload, parsed rather than cast. `pgboss.job` is not our table and has no RLS, so a
 * handler that trusted a cast would look up whatever it found there.
 */
const refreshPayload = z
  .object({
    phone: z.string().min(1),
    providers: z.array(z.string().min(1)).min(1),
  })
  .strict();

/**
 * Thrown when a provider did not answer, so pg-boss retries the job.
 *
 * `FRAUD_REFRESH_QUEUE` allows two retries on purpose ("a cache warm-up … retrying five
 * times through an outage would spend the throttle budget"), and a handler that swallowed
 * the outage would make that policy dead configuration: the first timeout would be final
 * and the badge would stay "provider unavailable" until the next agent happened to look.
 * The name, not the message, is what reaches `job.failed` — and it carries no number.
 */
export class FraudProviderUnavailable extends Error {
  override name = 'FraudProviderUnavailable';
}

export interface FraudWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly fraud: FraudService;
  readonly report: JobFailureReporter;
}

export async function registerFraudJobs(deps: FraudWorkerDependencies): Promise<void> {
  const { jobs, fraud, report } = deps;

  await jobs.work(
    FRAUD_REFRESH_QUEUE.name,
    async (job) => {
      if (job.orgId === null) throw new Error(`${FRAUD_REFRESH_QUEUE.name} is tenant-scoped`);
      const payload = refreshPayload.parse(job.payload);
      const result = await fraud.refreshProviders(job.orgId, payload);
      if (result.unavailable.length > 0) {
        // Codes like `steadfast:timeout`, never the provider's text (invariant 10).
        throw new FraudProviderUnavailable(result.unavailable.join(', '));
      }
    },
    report,
  );
}
