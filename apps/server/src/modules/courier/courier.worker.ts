import type { Logger } from 'pino';

import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { deadLetterNameFor } from '../../platform/jobs/queues.js';
import type { BookingService } from './booking.service.js';
import {
  bookParcelPayload,
  cancelParcelPayload,
  COURIER_QUEUES,
  pollOrgPayload,
  processWebhookPayload,
} from './courier.queues.js';
import type { CourierSyncService } from './sync.service.js';

/**
 * Wiring this module's queues to their handlers (architecture §20; M12 check 6).
 *
 * A function rather than a lifecycle hook, and called from `main.worker.ts` — the worker is
 * the only process that makes outbound calls (§21), so it is the only process that should
 * run these. Registering them in the module would register them in the API too, where a
 * pg-boss worker would be a second connection pool per instance doing work the worker is
 * already doing.
 *
 * ## The dead-letter handler is the acceptance check
 *
 * §20: "5 retries, then dead-letter → booking_failed". `JobsRuntime.workDeadLetters` already
 * emits the generic `job.failed` for every queue, and that is not enough for M12 check 6,
 * which wants the *order* flagged and `delivery.booking_failed` raised. So
 * `delivery.book_parcel`'s dead-letter queue gets a handler of its own that does both, and
 * then reports `job.failed` as well — an operator watching the failed-jobs view and an
 * org_admin watching their alerts are two different people who both need to know.
 *
 * Every payload is parsed rather than cast, for the reason `envelope.ts` gives: `pgboss.job`
 * is not our table, has no RLS, and a handler that trusted a cast payload would book a parcel
 * for whatever consignment id it found.
 */
export interface CourierWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly booking: BookingService;
  readonly sync: CourierSyncService;
  readonly report: JobFailureReporter;
  readonly logger: Logger;
}

export async function registerCourierJobs(deps: CourierWorkerDependencies): Promise<void> {
  const { jobs, booking, sync, report, logger } = deps;

  await jobs.work(
    COURIER_QUEUES.book,
    async (job) => {
      const payload = bookParcelPayload.parse(job.payload);
      if (job.orgId === null) throw new Error('delivery.book_parcel is tenant-scoped');
      await booking.runBooking({ orgId: job.orgId, payload });
    },
    report,
  );

  await jobs.work(
    COURIER_QUEUES.cancel,
    async (job) => {
      const payload = cancelParcelPayload.parse(job.payload);
      if (job.orgId === null) throw new Error('delivery.cancel_parcel is tenant-scoped');
      await booking.runCancel({ orgId: job.orgId, payload });
    },
    report,
  );

  await jobs.work(
    COURIER_QUEUES.webhook,
    async (job) => {
      const payload = processWebhookPayload.parse(job.payload);
      if (job.orgId === null) throw new Error('delivery.process_webhook is tenant-scoped');
      await sync.runWebhook({ orgId: job.orgId, payload });
    },
    report,
  );

  // The cron fan-out. Global: it fires once and enqueues one tenant job per org.
  await jobs.work(
    COURIER_QUEUES.poll,
    async () => {
      await sync.runPollFanOut();
    },
    report,
  );

  await jobs.work(
    COURIER_QUEUES.pollOrg,
    async (job) => {
      const payload = pollOrgPayload.parse(job.payload);
      if (job.orgId === null) throw new Error('delivery.poll_org is tenant-scoped');
      const moved = await sync.runPollOrg({ orgId: job.orgId, payload });
      if (moved > 0) logger.info({ orgId: job.orgId, moved }, 'courier poll moved parcels');
    },
    report,
  );

  /*
   * M12 acceptance check 6, in one handler.
   *
   * `workDeadLetters` in the runtime has already claimed this queue for its generic
   * `job.failed`, so this is a *second* worker on the same dead-letter queue — which the
   * runtime warns about, because two watchers each claim some of the jobs. So the ordering
   * matters: this registration happens **before** the entrypoint's sweep, and the sweep is a
   * no-op for a queue already watched (`watchedDeadLetters`). The INTEGRATION notes say to
   * call `registerCourierJobs` before the sweep for exactly this reason.
   */
  await jobs.boss.work<unknown>(deadLetterNameFor(COURIER_QUEUES.book), async (batch) => {
    for (const job of batch) {
      const envelope = job.data as { orgId?: unknown; payload?: unknown };
      const orgId = typeof envelope.orgId === 'string' ? envelope.orgId : null;
      const parsed = bookParcelPayload.safeParse(envelope.payload);
      if (orgId === null || !parsed.success) {
        logger.error({ jobId: job.id }, 'dead-lettered booking carried no usable envelope');
        continue;
      }

      await booking.reportBookingFailed({
        orgId,
        consignmentId: parsed.data.consignmentId,
        // A code, never the courier's message: it quotes the address and phone number we
        // sent, and `delivery.booking_failed` reaches every org_admin (§19, invariant 10).
        code: 'COURIER_BOOKING_FAILED',
      });

      // And the generic report as well, so the failed-jobs view shows it too.
      await report({
        queue: COURIER_QUEUES.book,
        orgId,
        ref: parsed.data.consignmentId,
        code: 'COURIER_BOOKING_FAILED',
      });
    }
  });
}
