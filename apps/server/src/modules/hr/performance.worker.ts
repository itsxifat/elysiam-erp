import { withOrg } from '@elysium/db';

import type { DeliveredEvent, OutboxDispatcher } from '../../platform/events/dispatcher.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { HR_QUEUES, progressBucket } from './performance.queues.js';
import { PROGRESS_ACTOR, type TargetsService } from './targets.service.js';

/** The order events the desk is measured from (§12, §19). */
export const DESK_EVENT_NAMES = [
  'order.created',
  'order.assigned',
  'order.claimed',
  'order.status_changed',
] as const;

/**
 * The outbox subscriber: one desk fact per order event, and a progress recompute when a
 * status change can move a target (D-276, D-279).
 *
 * Runs in the worker's dispatch loop, after the order's transaction committed (§19). The
 * desk event and the enqueue are each idempotent — the first by the outbox row's id, the
 * second by the bucket key — so the dispatcher's at-least-once delivery costs nothing.
 */
export function deskSubscriber(targets: TargetsService) {
  return async (event: DeliveredEvent): Promise<void> => {
    const { refresh } = await targets.recordDeskEvent(event);
    if (!refresh) return;
    const bucket = progressBucket(event.orgId, new Date());
    await withOrg({ orgId: event.orgId, userId: PROGRESS_ACTOR }, (tx) =>
      enqueue(
        tx,
        HR_QUEUES.refreshProgress,
        {},
        {
          orgId: event.orgId,
          singletonKey: bucket.singletonKey,
          startAfter: bucket.startAfter,
          ref: event.id,
        },
      ),
    );
  };
}

export interface PerformanceWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly dispatcher: OutboxDispatcher;
  readonly targets: TargetsService;
  readonly report: JobFailureReporter;
}

export async function registerPerformanceJobs(deps: PerformanceWorkerDependencies): Promise<void> {
  const { jobs, dispatcher, targets, report } = deps;
  const subscriber = deskSubscriber(targets);
  for (const name of DESK_EVENT_NAMES) dispatcher.on(name, subscriber);

  await jobs.work(
    HR_QUEUES.refreshProgress,
    async (job) => {
      if (job.orgId === null) throw new Error(`${HR_QUEUES.refreshProgress} is tenant-scoped`);
      await targets.refreshOrg(job.orgId);
    },
    report,
  );
}
