import { z } from 'zod';

import type { OutboxDispatcher } from '../../platform/events/dispatcher.js';
import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import type { ConversationOffersService } from './conversation-offers.service.js';
import { INBOX_QUEUES } from './inbox.queues.js';
import type { InboxOrderListener } from './order-listener.service.js';
import type { InboxProfileService } from './profile.service.js';
import type { InboxSendService } from './send.service.js';
import type { InboxWebhookService } from './webhook.service.js';

/**
 * The inbox's handlers (M42). Payloads carry ids only: the body, the reply's words and the
 * channel's token are read from the tenant's own tables when the job runs, never from
 * `pgboss.job` (invariant 10).
 */
const webhookPayload = z.object({ eventId: z.string().uuid() }).strict();
const sendPayload = z.object({ messageId: z.string().uuid() }).strict();
const offerDispatchPayload = z.object({ conversationId: z.string().uuid().nullable() }).strict();
const offerExpirePayload = z.object({ offerId: z.string().uuid() }).strict();
const profilePayload = z.object({ identityId: z.string().uuid() }).strict();
const presenceEvent = z.object({ state: z.string(), paused: z.boolean() });

export interface InboxWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly dispatcher: OutboxDispatcher;
  readonly webhooks: InboxWebhookService;
  readonly sender: InboxSendService;
  readonly orders: InboxOrderListener;
  /** D-748: the conversation auto-offer. Absent where a test runs the inbox without it. */
  readonly offers?: ConversationOffersService;
  /** D-761: senders' names and photos from Meta. Absent where a test runs the inbox without it. */
  readonly profiles?: InboxProfileService;
  readonly report: JobFailureReporter;
}

export async function registerInboxJobs(deps: InboxWorkerDependencies): Promise<void> {
  const { jobs, dispatcher, webhooks, sender, orders, offers, profiles, report } = deps;

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

  if (profiles !== undefined) {
    await jobs.work(
      INBOX_QUEUES.fetchProfile.name,
      async (job) => {
        if (job.orgId === null)
          throw new Error(`${INBOX_QUEUES.fetchProfile.name} is tenant-scoped`);
        const { identityId } = profilePayload.parse(job.payload);
        await profiles.refresh(job.orgId, identityId);
      },
      report,
    );
    await jobs.work(
      INBOX_QUEUES.profileSweep.name,
      async () => {
        await profiles.sweep();
      },
      report,
    );
  }

  if (offers === undefined) return;

  // D-748: a person becoming available (active, taking work) is offered what waits.
  dispatcher.on('team.presence_changed', async (event) => {
    const payload = presenceEvent.safeParse(event.payload);
    if (!payload.success || payload.data.state !== 'active' || payload.data.paused) return;
    await offers.dispatch(event.orgId, null);
  });

  await jobs.work(
    INBOX_QUEUES.offerDispatch.name,
    async (job) => {
      if (job.orgId === null)
        throw new Error(`${INBOX_QUEUES.offerDispatch.name} is tenant-scoped`);
      const { conversationId } = offerDispatchPayload.parse(job.payload);
      await offers.dispatch(job.orgId, conversationId);
    },
    report,
  );
  await jobs.work(
    INBOX_QUEUES.offerExpire.name,
    async (job) => {
      if (job.orgId === null) throw new Error(`${INBOX_QUEUES.offerExpire.name} is tenant-scoped`);
      const { offerId } = offerExpirePayload.parse(job.payload);
      await offers.expire(job.orgId, offerId);
    },
    report,
  );
  await jobs.work(
    INBOX_QUEUES.offerSweep.name,
    async () => {
      await offers.sweep();
    },
    report,
  );
}
