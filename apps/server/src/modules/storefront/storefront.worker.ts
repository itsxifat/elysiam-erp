import { z } from 'zod';

import type { OutboxDispatcher } from '../../platform/events/dispatcher.js';
import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import type { OrderMail } from './order-mail.js';
import type { PaymentsService } from './payments.service.js';
import { STOREFRONT_QUEUES } from './storefront.queues.js';
import type { TrackingService } from './tracking.service.js';

const sessionPayload = z.object({ sessionId: z.string().uuid() }).strict();
const validatePayload = z
  .object({ sessionId: z.string().uuid(), valId: z.string().min(1).max(80) })
  .strict();
const orderPayload = z.object({ orderId: z.string().uuid() }).strict();
const trackingPayload = z.object({ eventId: z.string().uuid() }).strict();

export interface StorefrontWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly dispatcher: OutboxDispatcher;
  readonly payments: PaymentsService;
  readonly mail: OrderMail;
  /** M35b: the website's events to Meta and GA4, and the log's retention (D-552). */
  readonly tracking: TrackingService;
  readonly report: JobFailureReporter;
}

/**
 * The website's jobs (M34): opening SSLCommerz sessions, validating payments, cancelling
 * unpaid online orders, and the order-status emails from the outbox (D-530). Each handler is
 * idempotent: a session already open, a payment already booked, an order already ended and an
 * email already written are left as they are.
 */
export async function registerStorefrontJobs(deps: StorefrontWorkerDependencies): Promise<void> {
  const { jobs, dispatcher, payments, mail, tracking, report } = deps;

  dispatcher.on('order.status_changed', (event) => mail.onStatusChanged(event));

  await jobs.work(
    STOREFRONT_QUEUES.openSession.name,
    async (job) => {
      if (job.orgId === null)
        throw new Error(`${STOREFRONT_QUEUES.openSession.name} is tenant-scoped`);
      const { sessionId } = sessionPayload.parse(job.payload);
      await payments.openSession(job.orgId, sessionId);
    },
    report,
  );
  await jobs.work(
    STOREFRONT_QUEUES.validate.name,
    async (job) => {
      if (job.orgId === null)
        throw new Error(`${STOREFRONT_QUEUES.validate.name} is tenant-scoped`);
      const { sessionId, valId } = validatePayload.parse(job.payload);
      await payments.validate(job.orgId, sessionId, valId);
    },
    report,
  );
  await jobs.work(
    STOREFRONT_QUEUES.expireUnpaid.name,
    async (job) => {
      if (job.orgId === null)
        throw new Error(`${STOREFRONT_QUEUES.expireUnpaid.name} is tenant-scoped`);
      const { orderId } = orderPayload.parse(job.payload);
      await payments.expireUnpaid(job.orgId, orderId);
    },
    report,
  );
  await jobs.work(
    STOREFRONT_QUEUES.trackingSend.name,
    async (job) => {
      if (job.orgId === null)
        throw new Error(`${STOREFRONT_QUEUES.trackingSend.name} is tenant-scoped`);
      const { eventId } = trackingPayload.parse(job.payload);
      await tracking.send(job.orgId, eventId);
    },
    report,
  );
  await jobs.work(
    STOREFRONT_QUEUES.trackingPurge.name,
    async () => {
      await tracking.purgeAll();
    },
    report,
  );
}
