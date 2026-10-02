import { toIsoDate } from '@elysium/domain';
import { z } from 'zod';

import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { CRM_QUEUES } from './crm.queues.js';
import type { CrmService } from './crm.service.js';

const datedPayload = z.object({ today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();

export interface CrmWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly crm: CrmService;
  readonly report: JobFailureReporter;
}

/** The CRM's handlers: two fan-outs on a schedule, and the per-brand work they enqueue. */
export async function registerCrmJobs(deps: CrmWorkerDependencies): Promise<void> {
  const { jobs, crm, report } = deps;

  await jobs.work(
    CRM_QUEUES.occasionsFanOut,
    async () => {
      await crm.fanOut('occasions');
    },
    report,
  );
  await jobs.work(
    CRM_QUEUES.rfmFanOut,
    async () => {
      await crm.fanOut('rfm');
    },
    report,
  );

  await jobs.work(
    CRM_QUEUES.occasions,
    async (job) => {
      if (job.orgId === null) throw new Error(`${CRM_QUEUES.occasions} is tenant-scoped`);
      const { today } = datedPayload.parse(job.payload);
      await crm.runOccasions(job.orgId, toIsoDate(today));
    },
    report,
  );

  await jobs.work(
    CRM_QUEUES.rfm,
    async (job) => {
      if (job.orgId === null) throw new Error(`${CRM_QUEUES.rfm} is tenant-scoped`);
      const { today } = datedPayload.parse(job.payload);
      await crm.runRfm(job.orgId, toIsoDate(today));
    },
    report,
  );
}
