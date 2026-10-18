import { z } from 'zod';

import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import type { TelephonyRecordingsService } from './recordings.service.js';
import type { TelephonySyncService } from './sync.service.js';
import { TELEPHONY_QUEUES } from './telephony.queues.js';
import type { TelephonyWebhookService } from './webhook.service.js';

/**
 * Telephony's handlers (M47). Payloads carry ids only: the body, the key and the recording's
 * link are read from the brand's own tables when the job runs, never from `pgboss.job`
 * (invariant 10).
 */
const webhookPayload = z.object({ eventId: z.string().uuid() }).strict();
const recordingPayload = z.object({ callId: z.string().uuid() }).strict();
const syncPayload = z.object({ connectionId: z.string().uuid() }).strict();

export interface TelephonyWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly webhooks: TelephonyWebhookService;
  readonly sync: TelephonySyncService;
  readonly recordings: TelephonyRecordingsService;
  readonly report: JobFailureReporter;
}

export async function registerTelephonyJobs(deps: TelephonyWorkerDependencies): Promise<void> {
  const { jobs, webhooks, sync, recordings, report } = deps;

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
    TELEPHONY_QUEUES.fetchRecording.name,
    async (job) => {
      if (job.orgId === null) {
        throw new Error(`${TELEPHONY_QUEUES.fetchRecording.name} is tenant-scoped`);
      }
      const { callId } = recordingPayload.parse(job.payload);
      await recordings.fetch(job.orgId, callId);
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
    TELEPHONY_QUEUES.recordingRetention.name,
    async () => {
      await recordings.retention();
    },
    report,
  );
}
