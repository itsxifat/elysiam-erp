import { z } from 'zod';

import type { OutboxDispatcher } from '../../platform/events/dispatcher.js';
import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { INBOX_QUEUES } from './inbox.queues.js';
import type { InboxOrderListener } from './order-listener.service.js';
import type { InboxSendService } from './send.service.js';
import type { InboxWebhookService } from './webhook.service.js';

/**
 * The inbox's handlers (M42). Payloads carry ids only: the body, the reply's words and the
 * channel's token are read from the tenant's own tables when the job runs, never from
 * `pgboss.job` (invariant 10).
 */
const webhookPayload = z.object({ eventId: z.string().uuid() }).strict();
const sendPayload = z.object({ messageId: z.string().uuid() }).strict();

export interface InboxWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly dispatcher: OutboxDispatcher;
  readonly webhooks: InboxWebhookService;
  readonly sender: InboxSendService;
  readonly orders: InboxOrderListener;
  readonly report: JobFailureReporter;
}

export async function registerInboxJobs(deps: InboxWorkerDependencies): Promise<void> {
  const { jobs, dispatcher, webhooks, sender, orders, report } = deps;

  // An order placed for a contact makes them a Customer (D-738).
  dispatcher.on('order.created', (event) => orders.onOrderCreated(event));

  await jobs.work(
    INBOX_QUEUES.processWebhook.name,
    async (job) => {
      if (job.orgId === null)
        throw new Error(`${INBOX_QUEUES.processWebhook.name} is tenant-scoped`);
      const { eventId } = webhookPayload.parse(job.payload);
      await webhooks.process(job.orgId, eventId);
    },
    report,
  );

  await jobs.work(
    INBOX_QUEUES.sendMessage.name,
    async (job) => {
      if (job.orgId === null) throw new Error(`${INBOX_QUEUES.sendMessage.name} is tenant-scoped`);
      const { messageId } = sendPayload.parse(job.payload);
      await sender.send(job.orgId, messageId);
    },
    report,
  );
}
