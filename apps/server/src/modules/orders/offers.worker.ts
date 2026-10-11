import { z } from 'zod';

import type { OutboxDispatcher } from '../../platform/events/dispatcher.js';
import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { OFFER_QUEUES } from './offers.queues.js';
import type { OffersService } from './offers.service.js';

const dispatchPayload = z.object({ orderId: z.string().uuid().nullable() }).strict();
const expirePayload = z.object({ offerId: z.string().uuid() }).strict();

const createdEvent = z.object({ id: z.string().uuid(), assignedTo: z.string().nullable() });
const presenceEvent = z.object({ state: z.string(), paused: z.boolean() });

export interface OfferWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly dispatcher: OutboxDispatcher;
  readonly offers: OffersService;
  readonly report: JobFailureReporter;
}

/**
 * Auto-assign's handlers (M41, D-717).
 *
 * From the outbox: a new order nobody holds is offered at once, and a person becoming available
 * (active and taking orders) is offered what waits. From pg-boss: a decline's or a release's
 * dispatch, each offer's deadline, and the minute sweep. Every handler is idempotent, so an
 * event delivered twice or a job retried offers nothing twice.
 */
export async function registerOfferJobs(deps: OfferWorkerDependencies): Promise<void> {
  const { jobs, dispatcher, offers, report } = deps;

  dispatcher.on('order.created', async (event) => {
    const payload = createdEvent.safeParse(event.payload);
    if (!payload.success || payload.data.assignedTo !== null) return;
    await offers.dispatch(event.orgId, payload.data.id);
  });
  dispatcher.on('team.presence_changed', async (event) => {
    const payload = presenceEvent.safeParse(event.payload);
    if (!payload.success || payload.data.state !== 'active' || payload.data.paused) return;
    await offers.dispatch(event.orgId, null);
  });

  await jobs.work(
    OFFER_QUEUES.dispatch.name,
    async (job) => {
      if (job.orgId === null) throw new Error(`${OFFER_QUEUES.dispatch.name} is tenant-scoped`);
      const { orderId } = dispatchPayload.parse(job.payload);
      await offers.dispatch(job.orgId, orderId);
    },
    report,
  );
  await jobs.work(
    OFFER_QUEUES.expire.name,
    async (job) => {
      if (job.orgId === null) throw new Error(`${OFFER_QUEUES.expire.name} is tenant-scoped`);
      const { offerId } = expirePayload.parse(job.payload);
      await offers.expire(job.orgId, offerId);
    },
    report,
  );
  await jobs.work(
    OFFER_QUEUES.sweep.name,
    async () => {
      await offers.sweep();
    },
    report,
  );
}
