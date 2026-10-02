import 'reflect-metadata';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { currentDatabaseConfig } from '@elysium/db';
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
import { MarketingModule } from './modules/marketing/marketing.module.js';
import { registerMarketingJobs } from './modules/marketing/marketing.worker.js';
import { MetaJobsService } from './modules/marketing/meta-jobs.service.js';
import { HrModule } from './modules/hr/hr.module.js';
import { registerPerformanceJobs } from './modules/hr/performance.worker.js';
import { TargetsService } from './modules/hr/targets.service.js';
import { NotifyModule } from './modules/notify/notify.module.js';
import { NotifyService } from './modules/notify/notify.service.js';
import { registerNotifyJobs } from './modules/notify/notify.worker.js';
import { CrmService } from './modules/orders/crm.service.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { registerCrmJobs } from './modules/orders/crm.worker.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { registerInventoryJobs } from './modules/inventory/inventory.worker.js';
import { ReconcileService } from './modules/inventory/reconcile.service.js';

import { OutboxDispatcher } from './platform/events/dispatcher.js';
import { serverEnv } from './platform/config/env.js';
import { reportJobFailedThroughOutbox } from './platform/jobs/job-failed.js';
import { JobsRuntime } from './platform/jobs/jobs.runtime.js';
import { createLogger } from './platform/logging/logger.js';
import { reportError, shutdownObservability } from './platform/observability/errors.js';
import { bridgeOutboxToRealtime, createRealtimeEmitter } from './platform/realtime/index.js';

/**
 * The worker (architecture §3, §19, §20).
 *
 * The same codebase from a different entrypoint, and the only process that makes
 * outbound calls. Two loops run here and they are not the same thing:
 *
 * - **pg-boss** owns work: book a parcel, send an SMS, reconcile stock. Jobs are
 *   enqueued inside a business transaction (`enqueue(tx, …)`), retried with
 *   backoff and dead-lettered.
 * - **The outbox dispatcher** owns notification: rows written by `emit(tx, …)`
 *   are handed to in-process subscribers and the realtime gateway after their
 *   transaction committed.
 *
 * They share the same reason for existing — invariant 6, no external call inside
 * a transaction — and neither replaces the other. A job is work that must happen
 * even if every browser is closed; an event is a thing to tell whoever is
 * watching.
 *
 * pg-boss connects as `erp_owner` here because it installs and migrates its own
 * schema. That is also why the worker, and only the worker, grants `erp_app` what
 * it needs on those tables — see `grantAppAccess` in `jobs.runtime.ts`.
 */

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

async function bootstrap(): Promise<void> {
  const env = serverEnv();
  const logger = createLogger('worker');

  // The owner URL, not `DATABASE_URL`: pg-boss creates and migrates its own
  // schema, which needs CREATE on the database. Read through `@elysium/db`'s
  // config rather than added to `serverEnv`, because it is the same variable the
  // migrations already use and a second definition of it is a second thing to
  // get wrong.
  const database = currentDatabaseConfig();
  const ownerUrl = database.DATABASE_OWNER_URL;
  if (ownerUrl === undefined || ownerUrl === '') {
    throw new Error(
      'the worker needs DATABASE_OWNER_URL: pg-boss installs its own schema, which the application role cannot create',
    );
  }

  const dispatcher = new OutboxDispatcher();

  /*
   * The realtime bridge lives here, not in the API (architecture §19).
   *
   * The dispatch loop below is the one that claims outbox rows, so this is the
   * only process that knows an event happened — and it has no HTTP surface, so it
   * holds an emit-only Socket.IO server whose broadcasts travel to the API
   * instances' sockets through the Valkey adapter. That is what §19's "with the
   * Valkey adapter" buys: without it these broadcasts would reach nothing at all,
   * because no browser is ever connected to the worker.
   */
  const realtime = createRealtimeEmitter({
    logger,
    valkey: { url: env.VALKEY_URL, key: env.REALTIME_ADAPTER_KEY },
  });
  bridgeOutboxToRealtime(dispatcher, realtime, logger);

  /*
   * The modules whose jobs this process runs, and nothing else (architecture §21).
   *
   * An application *context*, not an HTTP application: the worker serves no requests, so
   * it needs no adapter, no pipeline and no Better Auth instance — and building
   * `AppModule` here would demand all three. `CourierModule` pulls in what it actually
   * depends on (orders, ledger, wallets, inventory, approvals) through its own imports,
   * which is the same graph the API builds and therefore the same behaviour: a booking
   * job moves an order through the identical `TransitionsService`.
   *
   * Every module with queue handlers is imported by `WorkerModule` below, and its
   * queues are listed in `job-queues.ts`. The nightly stock reconciliation was
   * defined, scheduled and enqueued for weeks with no
   * handler here at all: the cron fired, the jobs piled up, and nothing ran them.
   */
  // `MarketingModule` is here for its handlers *and* for its delivery hook: a courier sync
  // that delivers an order runs in this process, and without the module loaded nobody would
  // be registered to queue the order's conversion (M18, D-262).
  @Module({
    imports: [
      CourierModule,
      InventoryModule,
      NotifyModule,
      OrdersModule,
      MarketingModule,
      HrModule,
      AnalyticsModule,
    ],
  })
  class WorkerModule {}

  // `abortOnError: false` for the reason `main.api.ts` gives: with the logger off, Nest's
  // own teardown exits without printing the error that stopped it.
  const context = await NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
    abortOnError: false,
  });

  const jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: ownerUrl,
    // The role a request's transaction is inside when it enqueues. Named from
    // `DATABASE_URL` rather than hard-coded, so D-042's role names live in one
    // place.
    appRole: roleFrom(database.DATABASE_URL),
    queues: ALL_QUEUES,
    logger,
  });

  const report = reportJobFailedThroughOutbox(logger);

  /*
   * Each module's handlers, then the generic dead-letter sweep.
   *
   * M12 registered a second worker of its own on `delivery.book_parcel.dead`, competing
   * with the runtime's watcher; run through real pg-boss, every dead-lettered booking
   * stayed `pending` and none was flagged. The courier's failure handling is now the
   * reporter it passes to `jobs.work`, so each queue has exactly one watcher.
   */
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
  await registerNotifyJobs({ jobs, notify: context.get(NotifyService), report });
  await registerCrmJobs({ jobs, crm: context.get(CrmService), report });
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

  // Every registered queue gets its dead-letter watcher, whether or not this
  // release also registered a handler for the queue itself. A queue with a
  // handler in the API tier and none here would otherwise dead-letter silently.
  for (const definition of ALL_QUEUES) {
    await jobs.workDeadLetters(definition.name, report);
  }

  logger.info({ queues: ALL_QUEUES.length }, 'jobs runtime started');

  const stopping = new AbortController();
  const dispatching = runDispatchLoop(dispatcher, logger, stopping.signal);

  logger.info('ready');

  await new Promise<void>((resolve) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        logger.info({ signal }, 'worker shutting down');
        resolve();
      });
    }
  });

  stopping.abort();
  // The dispatch loop is awaited before pg-boss stops: a subscriber that is
  // mid-delivery may enqueue, and enqueueing into a stopped runtime throws.
  await dispatching;
  // And realtime after the loop, for the same reason in the other direction: a
  // subscriber still delivering would otherwise publish into closed Valkey
  // connections, and its row would fail for a shutdown rather than a fault.
  await realtime.close();
  await jobs.stop();
  // Last, because a handler that is still finishing holds services out of this context.
  await context.close();
  // Then the error events and spans of the jobs that just finished (§26).
  await shutdownObservability();
}

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
async function runDispatchLoop(
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

function roleFrom(connectionString: string): string {
  const user = decodeURIComponent(new URL(connectionString).username);
  return user === '' ? 'erp_app' : user;
}

bootstrap().catch(async (error: unknown) => {
  process.stderr.write(`worker failed to start: ${String(error)}\n`);
  reportError(error, { kind: 'boot', process: 'worker' });
  await shutdownObservability();
  process.exit(1);
});
