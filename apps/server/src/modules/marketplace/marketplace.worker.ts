import { z } from 'zod';

import type { OutboxDispatcher } from '../../platform/events/dispatcher.js';
import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { MARKETPLACE_QUEUES } from './marketplace.queues.js';
import type { NcomOrdersService } from './ncom-orders.service.js';

const sendPayload = z.object({ orderId: z.string().uuid() }).strict();

export interface MarketplaceWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly dispatcher: OutboxDispatcher;
  readonly orders: NcomOrdersService;
  readonly report: JobFailureReporter;
}

/**
 * The marketplace's handlers (M35b, D-556): a handed-over order's status changes queue a message
 * for ncom (from the outbox), the sender sends them, and the sweep wakes the sender once a
 * message's backoff has passed. Payloads are ids; the message itself is sealed in the table.
 */
export async function registerMarketplaceJobs(deps: MarketplaceWorkerDependencies): Promise<void> {
  const { jobs, dispatcher, orders, report } = deps;

  dispatcher.on('order.status_changed', (event) => orders.onStatusChanged(event));
  dispatcher.on('order.edited', (event) => orders.onEdited(event));

  await jobs.work(
    MARKETPLACE_QUEUES.send.name,
    async (job) => {
      if (job.orgId === null) throw new Error(`${MARKETPLACE_QUEUES.send.name} is tenant-scoped`);
      const { orderId } = sendPayload.parse(job.payload);
      await orders.send(job.orgId, orderId);
    },
    report,
  );
  await jobs.work(
    MARKETPLACE_QUEUES.sweep.name,
    async () => {
      await orders.sweep();
    },
    report,
  );
}
