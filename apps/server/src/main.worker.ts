import 'reflect-metadata';

import { currentDatabaseConfig } from '@elysium/db';
import type { Logger } from 'pino';

import { OutboxDispatcher } from './platform/events/dispatcher.js';
import { serverEnv } from './platform/config/env.js';
import { reportJobFailedThroughOutbox } from './platform/jobs/job-failed.js';
import { JobsRuntime } from './platform/jobs/jobs.runtime.js';
import { PLATFORM_QUEUES } from './platform/jobs/queues.js';
import { createLogger } from './platform/logging/logger.js';
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

  const jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: ownerUrl,
    // The role a request's transaction is inside when it enqueues. Named from
    // `DATABASE_URL` rather than hard-coded, so D-042's role names live in one
    // place.
    appRole: roleFrom(database.DATABASE_URL),
    queues: PLATFORM_QUEUES,
    logger,
  });

  // Every registered queue gets its dead-letter watcher, whether or not this
  // release also registered a handler for the queue itself. A queue with a
  // handler in the API tier and none here would otherwise dead-letter silently.
  const report = reportJobFailedThroughOutbox(logger);
  for (const definition of PLATFORM_QUEUES) {
    await jobs.workDeadLetters(definition.name, report);
  }

  logger.info({ queues: PLATFORM_QUEUES.length }, 'jobs runtime started');

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
  /**
   * Outbox rows already reported, for this process's lifetime.
   *
   * `findDeadLettered` returns every row that has spent its attempts, on every
   * call, because the table has no column saying a row was reported — it is
   * append-only and marked, never updated past its attempt count. Without this
   * set, each poll would emit a fresh `job.failed` for the same undeliverable
   * row, forever, and each of those is itself an outbox row: a queue that
   * generates its own backlog.
   *
   * In-process, so a worker restart re-reports once. That is the right way round
   * — repeating a real failure after a restart is noise, and losing it is a
   * failure nobody hears about — but a `reported_at` column on `events.outbox`
   * is the actual fix, and it belongs to the migration that owns that table.
   */
  const reported = new Set<string>();
  const report = reportJobFailedThroughOutbox(logger);

  while (!signal.aborted) {
    try {
      const { delivered, failed } = await dispatcher.drain();

      for (const row of await dispatcher.deadLettered()) {
        if (reported.has(row.id)) continue;
        reported.add(row.id);
        await report({
          // Not a pg-boss queue, and named so it cannot be mistaken for one: the
          // failure is in delivering an event, not in doing a job's work.
          queue: 'events.dispatch',
          orgId: row.orgId,
          ref: row.id,
          code: 'OUTBOX_UNDELIVERABLE',
        });
      }

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

bootstrap().catch((error: unknown) => {
  process.stderr.write(`worker failed to start: ${String(error)}\n`);
  process.exit(1);
});
