import type { INestApplicationContext } from '@nestjs/common';
import type { Logger } from 'pino';

import { ALL_QUEUES } from './job-queues.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { registerAnalyticsJobs } from './modules/analytics/analytics.worker.js';
import { RollupService } from './modules/analytics/rollup.service.js';
import { BookingService } from './modules/courier/booking.service.js';
import { CourierModule } from './modules/courier/courier.module.js';
import { registerCourierJobs } from './modules/courier/courier.worker.js';
import { SettlementsService } from './modules/courier/settlements.service.js';
import { CourierSyncService } from './modules/courier/sync.service.js';
import { HrModule } from './modules/hr/hr.module.js';
import { registerPerformanceJobs } from './modules/hr/performance.worker.js';
import { TargetsService } from './modules/hr/targets.service.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { registerInventoryJobs } from './modules/inventory/inventory.worker.js';
import { ReconcileService } from './modules/inventory/reconcile.service.js';
import { LoansModule } from './modules/loans/loans.module.js';
import { registerLoansJobs } from './modules/loans/loans.worker.js';
import { LoanRemindersService } from './modules/loans/reminders.service.js';
import { MarketingModule } from './modules/marketing/marketing.module.js';
import { registerMarketingJobs } from './modules/marketing/marketing.worker.js';
import { MetaJobsService } from './modules/marketing/meta-jobs.service.js';
import { NotifyModule } from './modules/notify/notify.module.js';
import { EmailService } from './modules/notify/emails.service.js';
import { NotifyService } from './modules/notify/notify.service.js';
import { registerNotifyJobs } from './modules/notify/notify.worker.js';
import { CrmService } from './modules/orders/crm.service.js';
import { registerCrmJobs } from './modules/orders/crm.worker.js';
import { OffersService } from './modules/orders/offers.service.js';
import { registerOfferJobs } from './modules/orders/offers.worker.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { OrderMail } from './modules/storefront/order-mail.js';
import { PaymentsService } from './modules/storefront/payments.service.js';
import { StorefrontModule } from './modules/storefront/storefront.module.js';
import { registerStorefrontJobs } from './modules/storefront/storefront.worker.js';
import { TrackingService } from './modules/storefront/tracking.service.js';
import { MarketplaceModule } from './modules/marketplace/marketplace.module.js';
import { registerMarketplaceJobs } from './modules/marketplace/marketplace.worker.js';
import { NcomOrdersService } from './modules/marketplace/ncom-orders.service.js';
import { FilesModule } from './modules/files/files.module.js';
import { FilesService } from './modules/files/files.service.js';
import { registerFilesJobs } from './modules/files/files.worker.js';
import { PackingModule } from './modules/packing/packing.module.js';
import { registerPackingJobs } from './modules/packing/packing.worker.js';
import { PackingVideoService } from './modules/packing/video.service.js';
import { InboxModule } from './modules/inbox/inbox.module.js';
import { ConversationOffersService } from './modules/inbox/conversation-offers.service.js';
import { registerInboxJobs } from './modules/inbox/inbox.worker.js';
import { InboxOrderListener } from './modules/inbox/order-listener.service.js';
import { InboxProfileService } from './modules/inbox/profile.service.js';
import { InboxSendService } from './modules/inbox/send.service.js';
import { InboxWebhookService } from './modules/inbox/webhook.service.js';
import { InboxCallsService } from './modules/inbox/calls.service.js';
import { InboxMediaService } from './modules/inbox/media.service.js';
import { registerVoiceCallsJobs } from './modules/inbox/voice-calls.worker.js';
import type { OutboxDispatcher } from './platform/events/dispatcher.js';
import { reportJobFailedThroughOutbox } from './platform/jobs/job-failed.js';
import type { JobsRuntime } from './platform/jobs/jobs.runtime.js';

/**
 * What the worker runs, in one place for the two processes that run it.
 *
 * `main.worker.ts` is the worker. `main.preview.ts` (the preview seed) also runs these
 * handlers, in its own process, so that the demo activity it creates through the real
 * routes — a courier booking, a target's progress, a rollup — is finished by the same
 * code a deployed worker would run, before the seed checks the books and exits. Two
 * hand-kept copies of the registration list would drift the way the queue lists once did
 * (see `job-queues.ts`), so both import this one.
 */

/**
 * The modules whose jobs the worker runs, and nothing else (architecture §21).
 *
 * `MarketingModule` is here for its handlers *and* for its delivery hook: a courier sync
 * that delivers an order runs in this process, and without the module loaded nobody would
 * be registered to queue the order's conversion (M18, D-262). M26 adds the daily loan
 * reminders.
 */
export const WORKER_MODULES = [
  CourierModule,
  InventoryModule,
  NotifyModule,
  OrdersModule,
  MarketingModule,
  HrModule,
  AnalyticsModule,
  LoansModule,
  // M34: the website's payments, its unpaid-order timer and its order emails.
  StorefrontModule,
  // M35b: changes of ncom.bd's orders sent back to ncom.
  MarketplaceModule,
  // M38b: the packing video's retention and the removal of a deleted file's bytes.
  FilesModule,
  PackingModule,
  // M42: Meta's webhooks threaded, replies sent, and contacts made customers by their orders.
  InboxModule,
] as const;

export interface WorkerJobDependencies {
  /** A Nest context that holds every service in `WORKER_MODULES`. */
  readonly context: INestApplicationContext;
  readonly jobs: JobsRuntime;
  readonly dispatcher: OutboxDispatcher;
  readonly logger: Logger;
}

/**
 * Each module's handlers, then the generic dead-letter sweep.
 *
 * M12 registered a second worker of its own on `delivery.book_parcel.dead`, competing
 * with the runtime's watcher; run through real pg-boss, every dead-lettered booking
 * stayed `pending` and none was flagged. The courier's failure handling is now the
 * reporter it passes to `jobs.work`, so each queue has exactly one watcher.
 */
export async function registerWorkerJobs(deps: WorkerJobDependencies): Promise<void> {
  const { context, jobs, dispatcher, logger } = deps;
  const report = reportJobFailedThroughOutbox(logger);

  await registerCourierJobs({
    jobs,
    booking: context.get(BookingService),
    sync: context.get(CourierSyncService),
    // Without it the settlement-fetch queues drain as logged no-ops.
    settlements: context.get(SettlementsService),
    report,
    logger,
  });
  await registerInventoryJobs({ jobs, reconcile: context.get(ReconcileService), report, logger });
  await registerNotifyJobs({
    jobs,
    notify: context.get(NotifyService),
    emails: context.get(EmailService),
    report,
  });
  await registerCrmJobs({ jobs, crm: context.get(CrmService), report });
  // M41: auto-assign's offers, deadlines and sweep, and the outbox events that start them.
  await registerOfferJobs({ jobs, dispatcher, offers: context.get(OffersService), report });
  await registerMarketingJobs({ jobs, meta: context.get(MetaJobsService), report });
  // M20: desk events from the outbox, and the target progress recompute they trigger.
  await registerPerformanceJobs({
    jobs,
    dispatcher,
    targets: context.get(TargetsService),
    report,
  });
  // M24: the rollups, on order events and nightly (D-320).
  await registerAnalyticsJobs({
    jobs,
    dispatcher,
    rollup: context.get(RollupService),
    report,
  });
  await registerLoansJobs({ jobs, reminders: context.get(LoanRemindersService), report });
  await registerStorefrontJobs({
    jobs,
    dispatcher,
    payments: context.get(PaymentsService),
    mail: context.get(OrderMail),
    tracking: context.get(TrackingService),
    report,
  });
  await registerMarketplaceJobs({
    jobs,
    dispatcher,
    orders: context.get(NcomOrdersService),
    report,
  });
  // M38b: packing videos seven days after the order ended, and the bytes of deleted files.
  await registerPackingJobs({ jobs, videos: context.get(PackingVideoService), report });
  await registerFilesJobs({ jobs, files: context.get(FilesService), report });
  await registerInboxJobs({
    jobs,
    dispatcher,
    webhooks: context.get(InboxWebhookService),
    sender: context.get(InboxSendService),
    orders: context.get(InboxOrderListener),
    // D-748: the conversation auto-offer's dispatch, deadlines and minute sweep.
    offers: context.get(ConversationOffersService),
    // M44a (D-761): senders' names and photos from Meta, and the six-hourly refresh.
    profiles: context.get(InboxProfileService),
    report,
  });
  // M45: customers' media kept, recorded voice messages sent, calls that rang out, retention.
  await registerVoiceCallsJobs({
    jobs,
    media: context.get(InboxMediaService),
    calls: context.get(InboxCallsService),
    report,
  });

  // Every registered queue gets its dead-letter watcher, whether or not this
  // release also registered a handler for the queue itself. A queue with a
  // handler in the API tier and none here would otherwise dead-letter silently.
  for (const definition of ALL_QUEUES) {
    await jobs.workDeadLetters(definition.name, report);
  }
}

/**
 * How long the dispatcher sleeps when it found nothing.
 *
 * Polled rather than driven by LISTEN/NOTIFY, deliberately: a missed
 * notification is silent, and a missed poll is a poll. 500 ms is chosen against
 * the thing a person notices — a status change appearing in the order desk — and
 * a drained outbox costs one indexed query per tick.
 */
const DISPATCH_IDLE_MS = 500;

/** Backoff after a failed poll, so a database restart is not also a log flood. */
const DISPATCH_ERROR_MS = 5_000;

/**
 * Drain the outbox, then report whatever has spent its attempts.
 *
 * Runs in this process rather than as a pg-boss job on purpose. A job that
 * delivers events depends on the queue being healthy, and the first thing anyone
 * wants to be told about is the queue being unhealthy — so the loop that carries
 * that news cannot be one of its jobs.
 *
 * The loop polls again immediately while rows are still coming back, and only
 * sleeps once it finds none. A fixed tick would put a whole backlog behind
 * `backlog / batchSize` sleeps, which during an incident is when the delay
 * matters most.
 */
export async function runDispatchLoop(
  dispatcher: OutboxDispatcher,
  logger: Logger,
  signal: AbortSignal,
): Promise<void> {
  const report = reportJobFailedThroughOutbox(logger);

  while (!signal.aborted) {
    try {
      const { delivered, failed } = await dispatcher.drain();

      // Each dead row raises `job.failed` once; the outbox itself remembers which have
      // (0072), so a restart no longer re-reports every undeliverable row it ever had.
      await dispatcher.reportDeadLetters((row) =>
        report({
          // Not a pg-boss queue, and named so it cannot be mistaken for one: the
          // failure is in delivering an event, not in doing a job's work.
          queue: 'events.dispatch',
          orgId: row.orgId,
          ref: row.id,
          code: 'OUTBOX_UNDELIVERABLE',
        }),
      );

      // Nothing moved, so nothing new can have arrived that this tick would have
      // seen. Sleeping here and not when rows were delivered is what lets a
      // backlog drain at query speed.
      if (delivered === 0 && failed === 0) await sleep(DISPATCH_IDLE_MS, signal);
    } catch (error) {
      logger.error({ err: String(error) }, 'outbox dispatch failed');
      await sleep(DISPATCH_ERROR_MS, signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Otherwise a SIGTERM during an idle tick waits out the full interval before
    // the process can exit, and on the error path that is five seconds of a
    // deploy's rollout budget per worker.
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
