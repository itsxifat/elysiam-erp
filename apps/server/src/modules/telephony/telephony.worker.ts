import { z } from 'zod';

import { onCustomerMerged } from '../../platform/events/customer-merged.js';
import type { OutboxDispatcher } from '../../platform/events/dispatcher.js';
import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { moveCallsToCustomer } from './telephony.repository.js';
import type { TelephonySyncService } from './sync.service.js';
import { TELEPHONY_QUEUES } from './telephony.queues.js';
import type { TelephonyWebhookService } from './webhook.service.js';

/**
 * Telephony's handlers (M47). Payloads carry ids only: the body and the key are read from the
 * brand's own tables when the job runs, never from `pgboss.job` (invariant 10).
 */
const webhookPayload = z.object({ eventId: z.string().uuid() }).strict();
const syncPayload = z.object({ connectionId: z.string().uuid() }).strict();

export interface TelephonyWorkerDependencies {
  readonly jobs: JobsRuntime;
  /** M48 (D-885): calls follow a merged buyer. Absent where a test runs telephony without it. */
  readonly dispatcher?: OutboxDispatcher;
  readonly webhooks: TelephonyWebhookService;
  readonly sync: TelephonySyncService;
  readonly report: JobFailureReporter;
}

export async function registerTelephonyJobs(deps: TelephonyWorkerDependencies): Promise<void> {
  const { jobs, webhooks, sync, report } = deps;

  deps.dispatcher?.on(
    'customer.merged',
    onCustomerMerged('system:customer-merge', moveCallsToCustomer),
  );

  await jobs.work(
    TELEPHONY_QUEUES.processWebhook.name,
    async (job) => {
      if (job.orgId === null) {
        throw new Error(`${TELEPHONY_QUEUES.processWebhook.name} is tenant-scoped`);
      }
      const { eventId } = webhookPayload.parse(job.payload);
      await webhooks.process(job.orgId, eventId);
    },
    report,
  );

  await jobs.work(
    TELEPHONY_QUEUES.syncSweep.name,
    async () => {
      await sync.sweep();
    },
    report,
  );

  await jobs.work(
    TELEPHONY_QUEUES.syncConnection.name,
    async (job) => {
      if (job.orgId === null) {
        throw new Error(`${TELEPHONY_QUEUES.syncConnection.name} is tenant-scoped`);
      }
      const { connectionId } = syncPayload.parse(job.payload);
      await sync.syncConnection(job.orgId, connectionId);
    },
    report,
  );

  await jobs.work(
    TELEPHONY_QUEUES.webhookRetention.name,
    async () => {
      await webhooks.prune();
    },
    report,
  );
}
