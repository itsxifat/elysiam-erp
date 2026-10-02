import { toIsoDate } from '@elysium/domain';
import { z } from 'zod';

import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { LOANS_QUEUES } from './loans.queues.js';
import type { LoanRemindersService } from './reminders.service.js';

const datedPayload = z.object({ today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();

export interface LoansWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly reminders: LoanRemindersService;
  readonly report: JobFailureReporter;
}

/** The loan reminder handlers: the daily fan-out, and the per-brand run it enqueues. */
export async function registerLoansJobs(deps: LoansWorkerDependencies): Promise<void> {
  const { jobs, reminders, report } = deps;

  await jobs.work(
    LOANS_QUEUES.remindersFanOut,
    async () => {
      await reminders.fanOut();
    },
    report,
  );

  await jobs.work(
    LOANS_QUEUES.reminders,
    async (job) => {
      if (job.orgId === null) throw new Error(`${LOANS_QUEUES.reminders} is tenant-scoped`);
      const { today } = datedPayload.parse(job.payload);
      await reminders.run(job.orgId, toIsoDate(today));
    },
    report,
  );
}
