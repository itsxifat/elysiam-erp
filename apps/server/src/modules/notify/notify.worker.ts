import { z } from 'zod';

import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { NOTIFY_SEND_QUEUE } from './notify.queues.js';
import type { NotifyService } from './notify.service.js';

/**
 * The `notify.send` worker (§20; M16).
 *
 * The payload is the message id and nothing else: the phone and the body are in the
 * tenant's own table, and a job payload sits in `pgboss.job`, which is not where a buyer's
 * number belongs (invariant 10).
 */
const sendPayload = z.object({ messageId: z.string().uuid() }).strict();

export interface NotifyWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly notify: NotifyService;
  readonly report: JobFailureReporter;
}

export async function registerNotifyJobs(deps: NotifyWorkerDependencies): Promise<void> {
  const { jobs, notify, report } = deps;

  await jobs.work(
    NOTIFY_SEND_QUEUE.name,
    async (job) => {
      if (job.orgId === null) throw new Error(`${NOTIFY_SEND_QUEUE.name} is tenant-scoped`);
      const { messageId } = sendPayload.parse(job.payload);
      // Throws only for a failure worth retrying; a named refusal is recorded and ends here.
      await notify.deliver(job.orgId, messageId);
    },
    report,
  );
}
