import { z } from 'zod';

import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { MARKETING_QUEUES } from './marketing.queues.js';
import type { MetaJobsService } from './meta-jobs.service.js';

/**
 * The marketing module's handlers (M18). Payloads carry ids and dates only: the token and
 * the buyer's details are read from the tenant's own tables when the job runs, never from
 * `pgboss.job` (invariant 10).
 */
const rangePayload = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

const capiPayload = z.object({ eventId: z.string().uuid() }).strict();

export interface MarketingWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly meta: MetaJobsService;
  readonly report: JobFailureReporter;
}

export async function registerMarketingJobs(deps: MarketingWorkerDependencies): Promise<void> {
  const { jobs, meta, report } = deps;

  await jobs.work(
    MARKETING_QUEUES.importFanOut,
    async () => {
      await meta.fanOutImports();
    },
    report,
  );

  await jobs.work(
    MARKETING_QUEUES.importSpend,
    async (job) => {
      if (job.orgId === null) throw new Error(`${MARKETING_QUEUES.importSpend} is tenant-scoped`);
      const range = rangePayload.parse(job.payload);
      await meta.importSpend(job.orgId, range);
    },
    report,
  );

  await jobs.work(
    MARKETING_QUEUES.capi,
    async (job) => {
      if (job.orgId === null) throw new Error(`${MARKETING_QUEUES.capi} is tenant-scoped`);
      const { eventId } = capiPayload.parse(job.payload);
      await meta.sendConversion(job.orgId, eventId);
    },
    report,
  );
}
