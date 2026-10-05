import 'reflect-metadata';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { currentDatabaseConfig } from '@elysium/db';

import { ALL_QUEUES } from './job-queues.js';
import { OutboxDispatcher } from './platform/events/dispatcher.js';
import { loadDeploymentBrand } from './platform/brand/deployment.js';
import { serverEnv } from './platform/config/env.js';
import { JobsRuntime } from './platform/jobs/jobs.runtime.js';
import { createLogger } from './platform/logging/logger.js';
import { reportError, shutdownObservability } from './platform/observability/errors.js';
import { bridgeOutboxToRealtime, createRealtimeEmitter } from './platform/realtime/index.js';
import { registerWorkerJobs, runDispatchLoop, WORKER_MODULES } from './worker-jobs.js';

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

async function bootstrap(): Promise<void> {
  const env = serverEnv();
  const logger = createLogger('worker');

  // One brand per deployment (D-470): refuse a database holding another real brand.
  const brand = await loadDeploymentBrand(env.ERP_BRAND_SLUG);
  if (brand !== null) logger.info({ brand: brand.slug }, 'brand deployment');

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
   * Every module with queue handlers is in `WORKER_MODULES` (worker-jobs.ts), and its
   * queues are listed in `job-queues.ts`. The nightly stock reconciliation was
   * defined, scheduled and enqueued for weeks with no
   * handler here at all: the cron fired, the jobs piled up, and nothing ran them.
   */
  @Module({ imports: [...WORKER_MODULES] })
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

  // Each module's handlers, then the generic dead-letter sweep (worker-jobs.ts). The
  // preview seed runs the same registration, so the two cannot drift.
  await registerWorkerJobs({ context, jobs, dispatcher, logger });

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
