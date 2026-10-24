import type { Logger } from 'pino';
import { z } from 'zod';

import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import type { BookingService } from './booking.service.js';
import {
  bookParcelPayload,
  cancelParcelPayload,
  COURIER_QUEUES,
  fetchAccountSettlementsPayload,
  pollOrgPayload,
  processWebhookPayload,
  recordHandoverPayload,
  repollPayload,
} from './courier.queues.js';
import type { SettlementsService } from './settlements.service.js';
import type { StuckParcelsService } from './stuck.service.js';
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
 * which wants the parcel flagged and `delivery.booking_failed` raised. So
 * `delivery.book_parcel` is worked with a failure reporter of its own that does both, and
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
  /**
   * M15's settlement fetch. Optional only so `main.worker.ts` keeps compiling until the
   * integrator passes `context.get(SettlementsService)` (see the INTEGRATION notes); without
   * it the fetch queues are still drained — as no-ops that say so — rather than left to
   * expire into dead letters every morning.
   */
  readonly settlements?: SettlementsService;
  /** D-903: the not-received sweep. Optional so a test's worker need not run it. */
  readonly stuck?: StuckParcelsService;
}

export async function registerCourierJobs(deps: CourierWorkerDependencies): Promise<void> {
  const { jobs, booking, sync, report, logger, settlements, stuck } = deps;

  // D-903: a ship's handover, when the parcel's row was locked as the order shipped.
  await jobs.work(
    COURIER_QUEUES.recordHandover,
    async (job) => {
      if (job.orgId === null) throw new Error('delivery.record_handover is tenant-scoped');
      await booking.applyHandover(job.orgId, recordHandoverPayload.parse(job.payload));
    },
    report,
  );

  // D-903: parcels handed over that the courier has not received, flagged once each.
  if (stuck !== undefined) {
    await jobs.work(
      COURIER_QUEUES.notReceivedSweep,
      async () => {
        const flagged = await stuck.sweepNotReceived();
        if (flagged > 0) logger.info({ flagged }, 'parcels not received by the courier');
      },
      report,
    );
  }

  /*
   * M12 acceptance check 6: a booking that spends every retry flags its parcel and raises
   * `delivery.booking_failed`.
   *
   * Through the runtime's **own** dead-letter watcher, by handing `jobs.work` a reporter that
   * does the courier's part first. M12 registered a second `boss.work` on
   * `delivery.book_parcel.dead` instead — but `jobs.work` had already attached the generic
   * watcher to that queue, so there were two workers on it and pg-boss handed each dead letter
   * to whichever fetched first. The generic one only reports `job.failed`: for every booking
   * it won, the parcel was never flagged `failed` and `delivery.booking_failed` never reached
   * an org_admin. One watcher, one handler, now — and the M15 queue suite drives the real
   * retry → dead-letter path through it.
   *
   * The failure's `ref` is the consignment id — `reserveConsignment` enqueues with it — and it
   * is checked to be one before it is used, because `pgboss.job` is not our table.
   */
  const reportBookingFailure: JobFailureReporter = async (failure) => {
    const consignmentId =
      failure.ref !== null && z.string().uuid().safeParse(failure.ref).success ? failure.ref : null;
    if (failure.orgId === null || consignmentId === null) {
      logger.error({ queue: failure.queue }, 'dead-lettered booking carried no usable envelope');
    } else {
      await booking.reportBookingFailed({
        orgId: failure.orgId,
        consignmentId,
        // A code, never the courier's message: it quotes the address and phone number we
        // sent, and `delivery.booking_failed` reaches every org_admin (§19, invariant 10).
        code: 'COURIER_BOOKING_FAILED',
      });
    }
    // And the generic report as well, so the failed-jobs view shows it too.
    await report({ ...failure, code: 'COURIER_BOOKING_FAILED' });
  };

  await jobs.work(
    COURIER_QUEUES.book,
    async (job) => {
      const payload = bookParcelPayload.parse(job.payload);
      if (job.orgId === null) throw new Error('delivery.book_parcel is tenant-scoped');
      await booking.runBooking({ orgId: job.orgId, payload });
    },
    reportBookingFailure,
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

  // M15: the stuck-parcel queue's bulk re-poll.
  await jobs.work(
    COURIER_QUEUES.repoll,
    async (job) => {
      const payload = repollPayload.parse(job.payload);
      if (job.orgId === null) throw new Error('delivery.repoll_parcels is tenant-scoped');
      const outcome = await sync.runRepoll({ orgId: job.orgId, payload });
      logger.info({ orgId: job.orgId, ...outcome }, 'courier re-poll finished');
    },
    report,
  );

  // M15: the settlement fetch cron fan-out. Global: it fires once and enqueues per account.
  await jobs.work(
    COURIER_QUEUES.fetchSettlements,
    async () => {
      if (settlements === undefined) {
        logger.warn('settlement fetch is not wired into this worker; nothing was fetched');
        return;
      }
      const enqueued = await settlements.runFetchFanOut();
      if (enqueued > 0) logger.info({ enqueued }, 'courier settlement fetch fanned out');
    },
    report,
  );

  await jobs.work(
    COURIER_QUEUES.fetchAccountSettlements,
    async (job) => {
      const payload = fetchAccountSettlementsPayload.parse(job.payload);
      if (job.orgId === null) {
        throw new Error('delivery.fetch_account_settlements is tenant-scoped');
      }
      if (settlements === undefined) {
        logger.warn({ orgId: job.orgId }, 'settlement fetch is not wired into this worker');
        return;
      }
      const { outcomes } = await settlements.runFetch({ orgId: job.orgId, payload });
      // Counts and codes only: a statement reference is the courier's, but nothing here needs
      // more than how many of each outcome there were.
      logger.info(
        {
          orgId: job.orgId,
          created: outcomes.filter((entry) => entry.outcome === 'created').length,
          duplicate: outcomes.filter((entry) => entry.outcome === 'duplicate').length,
          refused: outcomes.filter((entry) => entry.outcome === 'refused').length,
        },
        'courier settlement fetch finished',
      );
    },
    report,
  );
}
