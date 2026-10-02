import { z } from 'zod';

import type { DeliveredEvent, OutboxDispatcher } from '../../platform/events/dispatcher.js';
import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { ANALYTICS_QUEUES } from './analytics.queues.js';
import { ROLLUP_EVENT_NAMES, type RollupService } from './rollup.service.js';

/**
 * The analytics handlers (M24, D-320). The payload carries two Dhaka dates and nothing
 * else; every figure is read from the tenant's own tables when the job runs.
 */
const rangePayload = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

/** The outbox subscriber: an order event becomes a recompute of today, one per bucket. */
export function rollupSubscriber(rollup: RollupService, now: () => Date = () => new Date()) {
  return async (event: DeliveredEvent): Promise<void> => {
    await rollup.enqueueForEvent(event, now());
  };
}

export interface AnalyticsWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly dispatcher: OutboxDispatcher;
  readonly rollup: RollupService;
  readonly report: JobFailureReporter;
}

export async function registerAnalyticsJobs(deps: AnalyticsWorkerDependencies): Promise<void> {
  const { jobs, dispatcher, rollup, report } = deps;
  const subscriber = rollupSubscriber(rollup);
  for (const name of ROLLUP_EVENT_NAMES) dispatcher.on(name, subscriber);

  await jobs.work(
    ANALYTICS_QUEUES.schedule,
    async () => {
      await rollup.fanOut();
    },
    report,
  );

  await jobs.work(
    ANALYTICS_QUEUES.rollup,
    async (job) => {
      if (job.orgId === null) throw new Error(`${ANALYTICS_QUEUES.rollup} is tenant-scoped`);
      const range = rangePayload.parse(job.payload);
      await rollup.recompute(job.orgId, range);
    },
    report,
  );
}
